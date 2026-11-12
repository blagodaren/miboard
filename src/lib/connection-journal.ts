import type { Connection } from './api'
import { readJournalRetention, saveJournalRetention, validJournalRetention, type JournalRetention } from './journal-preferences.ts'
export { validJournalRetention, type JournalRetention } from './journal-preferences.ts'

export type JournalEntry = {
  connection: Connection
  firstSeenAt: number
  lastSeenAt: number
  /** When disappearance was observed, never an exact server-side end time. */
  closedAt: number
  afterGap?: boolean
}
type JournalReset = { id: string; at: number }
export type JournalRecord = { retention: JournalRetention; entries: JournalEntry[]; reset?: JournalReset; expiredBefore?: number; retentionChangedAt?: number }
export type JournalWriteOptions = { now: number; processedAt?: number; clear?: JournalReset; retention?: JournalRetention }
export type JournalStore = {
  /** Writes synchronously stage durable operations and serialize them in storage. */
  stagesImmediately?: boolean
  read: (backend: string) => Promise<unknown>
  write: (backend: string, record: JournalRecord, options: JournalWriteOptions) => Promise<JournalRecord | void>
}
export const JOURNAL_LIMIT = 5000
export const JOURNAL_ACTIVE_LIMIT = 10000
export const JOURNAL_DB_NAME = 'miboard-connection-journal-v1'
export const JOURNAL_WRITE_INTERVAL = 5000
const periods = { off: 0, '1h': 3600000, '24h': 86400000, '7d': 604800000 }
const text = (value: unknown, max = 4096) => typeof value === 'string' ? value.slice(0, max) : ''
const counter = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
const identity = (connection: Connection) => JSON.stringify([connection.id, connection.start])

/** Store known connection fields only, never arbitrary response data or credentials. */
export function journalConnection(value: unknown): Connection | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id || !row.metadata || typeof row.metadata !== 'object') return null
  const source = row.metadata as Record<string, unknown>
  const metadata: Connection['metadata'] = {
    network: text(source.network), type: text(source.type), sourceIP: text(source.sourceIP), sourcePort: text(source.sourcePort),
    destinationIP: text(source.destinationIP), destinationPort: text(source.destinationPort), host: text(source.host),
  }
  for (const key of [
    'sniffHost', 'process', 'processPath', 'remoteDestination', 'inboundIP', 'inboundPort', 'inboundName', 'inboundUser',
    'sourceIPASN', 'destinationIPASN', 'rematchName', 'dnsMode', 'specialProxy', 'specialRules', 'id',
    'smartBlock', 'smartTarget', 'wildcardTarget', 'exitGeoIP', 'exitIPASN',
  ] as const) {
    if (typeof source[key] === 'string') metadata[key] = text(source[key])
  }
  for (const key of ['sourceGeoIP', 'destinationGeoIP'] as const) {
    if (source[key] === null) metadata[key] = null
    else if (Array.isArray(source[key])) metadata[key] = source[key].filter(item => typeof item === 'string').slice(0, 8).map(item => text(item, 64))
  }
  for (const key of ['uid', 'dscp'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (key !== 'dscp' || value <= 63)) metadata[key] = value
  }
  const connection: Connection = {
    id: text(row.id, 512), metadata, start: text(row.start, 128), upload: counter(row.upload), download: counter(row.download),
    chains: Array.isArray(row.chains) ? row.chains.filter(item => typeof item === 'string').slice(0, 64).map(item => text(item)) : [],
    rule: text(row.rule), rulePayload: text(row.rulePayload),
  }
  if (row.providerChains === null) connection.providerChains = null
  else if (Array.isArray(row.providerChains)) {
    // Empty positions correspond to the same positions in chains; keep them.
    connection.providerChains = row.providerChains.slice(0, 64).map(item => text(item))
  }
  for (const key of ['maxUploadRate', 'maxDownloadRate', 'downloadSpeed', 'uploadSpeed'] as const) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) connection[key] = value
  }
  return connection
}

export function retainJournal(values: readonly unknown[], retention: JournalRetention, now = Date.now()): JournalEntry[] {
  if (retention === 'off') return []
  const entries = new Map<string, JournalEntry>()
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const entry = value as JournalEntry
    const connection = journalConnection(entry.connection)
    if (!connection || ![entry.firstSeenAt, entry.lastSeenAt, entry.closedAt].every(time => Number.isFinite(time) && time > 0)
      || entry.firstSeenAt > entry.lastSeenAt || entry.lastSeenAt > entry.closedAt || entry.closedAt > now + 60000
      || entry.closedAt < now - periods[retention]) continue
    const clean: JournalEntry = { connection, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt, closedAt: entry.closedAt, ...(entry.afterGap ? { afterGap: true } : {}) }
    const key = identity(connection)
    if ((entries.get(key)?.closedAt ?? 0) <= clean.closedAt) entries.set(key, clean)
  }
  return [...entries.values()].sort((a, b) => b.closedAt - a.closedAt || b.lastSeenAt - a.lastSeenAt).slice(0, JOURNAL_LIMIT)
}

function journalReset(value: unknown): JournalReset | undefined {
  if (!value || typeof value !== 'object') return
  const reset = value as JournalReset
  if (typeof reset.id === 'string' && reset.id.length <= 128 && Number.isFinite(reset.at) && reset.at > 0) return { id: reset.id, at: reset.at }
}

/** Run inside the store's atomic read/write operation, never after a separate read. */
export function mergeJournalRecord(saved: unknown, incoming: JournalRecord, options: JournalWriteOptions): JournalRecord {
  const previous = saved && typeof saved === 'object' ? saved as Partial<JournalRecord> : undefined
  const now = options.processedAt ?? options.now
  const savedReset = journalReset(previous?.reset)
  const retentionChangedAt = counter(previous?.retentionChangedAt)
  const retention = options.retention && options.now >= retentionChangedAt
    ? options.retention : validJournalRetention(previous?.retention) ? previous.retention : incoming.retention
  const clear = options.clear ?? (retention === 'off' && (previous?.retention !== 'off' || !savedReset) ? { id: `off-${options.now}`, at: options.now } : undefined)
  const reset = clear && (!savedReset || clear.at >= savedReset.at) ? clear : savedReset ?? journalReset(incoming.reset)
  const expiredBefore = Math.max(counter(previous?.expiredBefore), retention === 'off' ? 0 : now - periods[retention])
  // A stale tab may contribute genuinely newer closures, but cannot resurrect
  // snapshots removed by Clear or by turning recording off in another tab.
  const additions = reset && incoming.reset?.id !== reset.id
    ? incoming.entries.filter(entry => entry.closedAt > reset.at)
    : incoming.entries
  const existing = Array.isArray(previous?.entries)
    ? clear ? previous.entries.filter(entry => entry && typeof entry === 'object' && entry.closedAt > clear.at) : previous.entries
    : []
  const entries = retainJournal([...existing, ...additions], retention, now).filter(entry => entry.closedAt >= expiredBefore)
  return { retention, entries, expiredBefore, retentionChangedAt: options.retention ? Math.max(retentionChangedAt, options.now) : retentionChangedAt, ...(reset ? { reset } : {}) }
}

export class JournalTracker {
  #previous = new Map<string, { connection: Connection; firstSeenAt: number; lastSeenAt: number }>()
  #complete = true
  #gapped = false
  #time = 0

  pause(reset = false) {
    this.#gapped = true
    if (reset) { this.#previous.clear(); this.#complete = true; this.#time = 0 }
  }

  observe(connections: readonly Connection[], now = Date.now()): JournalEntry[] {
    if (!Number.isFinite(now) || now <= 0 || now < this.#time) return []
    this.#time = now
    const next = new Map<string, { connection: Connection; firstSeenAt: number; lastSeenAt: number }>()
    // An incomplete snapshot cannot prove that any omitted connection ended.
    let complete = connections.length <= JOURNAL_ACTIVE_LIMIT
    for (const source of connections.slice(0, JOURNAL_ACTIVE_LIMIT)) {
      const connection = journalConnection(source)
      if (!connection) { complete = false; continue }
      const key = identity(connection)
      const previous = this.#previous.get(key)
      next.set(key, { connection, firstSeenAt: previous?.firstSeenAt ?? now, lastSeenAt: now })
    }
    const ended: JournalEntry[] = []
    if (complete && this.#complete) {
      for (const [key, previous] of this.#previous) {
        if (!next.has(key)) ended.push({ ...previous, closedAt: now, ...(this.#gapped ? { afterGap: true } : {}) })
      }
    }
    this.#previous = next
    this.#complete = complete
    this.#gapped = false
    return ended
  }
}

export function indexedJournalStore(): JournalStore {
  const writerId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let sequence = 0
  let opened: Promise<IDBDatabase> | undefined
  let available: IDBDatabase | undefined
  const database = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const request = indexedDB.open(JOURNAL_DB_NAME, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('backends')) request.result.createObjectStore('backends') }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('IndexedDB blocked'))
    request.onsuccess = () => {
      const db = request.result
      available = db
      db.onversionchange = () => { db.close(); available = undefined; opened = undefined }
      resolve(db)
    }
  })
  // Array keys are disjoint from the existing string backend keys, so old
  // journals need no schema upgrade (or blocked upgrade in another open tab).
  // Every staged snapshot is bounded by JOURNAL_LIMIT. Each write queues its
  // drain immediately behind staging, and every read drains abandoned writes.
  const drain = (db: IDBDatabase, backend: string) => new Promise<JournalRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction('backends', 'readwrite')
    const store = transaction.objectStore('backends')
    let saved: unknown
    let merged: JournalRecord | undefined
    const pending: Array<{ record: JournalRecord; options: JournalWriteOptions }> = []
    transaction.oncomplete = () => resolve(merged ?? saved as JournalRecord | undefined)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Journal transaction aborted'))
    const request = store.get(backend)
    request.onsuccess = () => { saved = request.result }
    const cursor = store.openCursor(IDBKeyRange.bound([backend], [backend, []]))
    cursor.onsuccess = () => {
      const row = cursor.result
      if (row) {
        const operation = row.value
        if (operation?.record && Array.isArray(operation.record.entries) && validJournalRetention(operation.record.retention)
          && Number.isFinite(operation.options?.now) && operation.options.now > 0) pending.push(operation)
        row.delete()
        row.continue()
        return
      }
      // A suspended page can leave a queued operation behind. Its timestamp
      // preserves clear/retention ordering when a later page finishes it.
      pending.sort((a, b) => a.options.now - b.options.now)
      for (const operation of pending) {
        merged = mergeJournalRecord(merged ?? saved, operation.record, {
          ...operation.options,
          processedAt: Date.now(),
          retention: readJournalRetention(backend) ?? operation.options.retention,
        })
      }
      if (merged) store.put(merged, backend)
      transaction.commit?.()
    }
  })
  return {
    stagesImmediately: true,
    async read(backend) { return drain(await database(), backend) },
    write(backend, record, options) {
      const write = (db: IDBDatabase) => {
        const queued = new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('backends', 'readwrite')
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error ?? new Error('Journal queue transaction aborted'))
          transaction.objectStore('backends').put({ record, options }, [backend, writerId, ++sequence])
          transaction.commit?.()
        })
        // Queue the drain now, even if navigation prevents the staging
        // callback from running. IDB orders it after the staging transaction.
        return Promise.all([queued, drain(db, backend)]).then(([, saved]) => saved)
      }
      // Queue the complete operation before pagehide returns. Its put can
      // commit after navigation even if JS callbacks can no longer run. The
      // next page's read completes the merge without losing the pending batch.
      return available ? write(available) : database().then(write)
    },
  }
}

/** Backend-scoped observations with ordered, coalesced persistence and a bounded memory fallback. */
export class ConnectionJournal {
  backendUrl = ''
  retention: JournalRetention = '24h'
  entries: readonly JournalEntry[] = []
  loading = false
  storageState: 'loading' | 'persistent' | 'memory' = 'loading'
  #tracker = new JournalTracker()
  #generation = 0
  #revision = 0
  #clearRevision = 0
  #reset: JournalReset | undefined
  #pendingClear: JournalReset | undefined
  #pendingRetention: JournalRetention | undefined
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | undefined
  #writes = Promise.resolve()
  #pendingWrites = 0
  #listeners = new Set<() => void>()
  #memory = new Map<string, JournalRecord>()
  #writeFailed = false
  #store: JournalStore
  #clock: () => number
  constructor(store: JournalStore = indexedJournalStore(), clock = () => Date.now()) { this.#store = store; this.#clock = clock }

  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  #changed() { for (const listener of this.#listeners) listener() }

  async activateBackend(url: string): Promise<void> {
    void this.flush()
    const generation = ++this.#generation
    this.#dirty = false
    this.#reset = undefined
    this.#pendingClear = undefined
    this.#pendingRetention = undefined
    this.backendUrl = url
    this.entries = []
    this.retention = url ? readJournalRetention(url) ?? '24h' : '24h'
    this.loading = !!url
    this.storageState = this.#writeFailed ? 'memory' : 'loading'
    this.#tracker = new JournalTracker()
    const revision = this.#revision
    const clearRevision = this.#clearRevision
    this.#changed()
    if (!url) return
    let record: JournalRecord | undefined
    try {
      await this.#writes
      const value = this.#writeFailed ? this.#memory.get(url) : await this.#store.read(url)
      if (value && typeof value === 'object') record = value as JournalRecord
    } catch {
      if (generation !== this.#generation) return
      // Never overwrite an unreadable persisted journal with an empty record.
      this.#writeFailed = true
    }
    if (generation !== this.#generation) return
    if (revision === this.#revision) {
      const preference = readJournalRetention(url)
      if (preference) this.retention = preference
      else if (validJournalRetention(record?.retention)) {
        this.retention = record.retention
        saveJournalRetention(url, record.retention)
      }
    }
    const saved = clearRevision === this.#clearRevision && Array.isArray(record?.entries) ? record.entries : []
    if (clearRevision === this.#clearRevision) this.#reset = journalReset(record?.reset)
    this.entries = retainJournal([...saved, ...this.entries], this.retention, this.#clock())
    this.loading = false
    // A read may fail even before the first attempted write; the write reports durability.
    this.storageState = this.#writeFailed ? 'memory' : 'persistent'
    if (this.retention === 'off') this.#tracker.pause(true)
    this.#changed()
    this.#schedule()
  }

  observe(connections: readonly Connection[], now = this.#clock()) {
    if (!this.backendUrl || this.retention === 'off') return
    const ended = this.#tracker.observe(connections, now)
    const entries = retainJournal([...this.entries, ...ended], this.retention, now)
    if (!ended.length && entries.length === this.entries.length) return
    this.entries = entries
    this.#changed()
    this.#schedule()
  }

  pause(reset = false) { this.#tracker.pause(reset) }
  prune(now = this.#clock()) {
    const entries = retainJournal(this.entries, this.retention, now)
    if (entries.length !== this.entries.length) { this.entries = entries; this.#changed(); this.#schedule() }
  }
  setRetention(retention: JournalRetention) {
    if (!validJournalRetention(retention) || !this.backendUrl) return
    this.#revision++
    this.retention = retention
    this.#pendingRetention = retention
    saveJournalRetention(this.backendUrl, retention)
    this.entries = retainJournal(this.entries, retention, this.#clock())
    if (retention === 'off') { this.#tracker.pause(true); this.#markClear() }
    this.#changed()
    this.#schedule()
  }
  clear() {
    if (!this.backendUrl) return
    this.#markClear()
    this.entries = []
    this.#changed()
    this.#schedule()
  }

  #markClear() {
    this.#clearRevision++
    this.#reset = { id: `${this.#clock()}-${Math.random().toString(36).slice(2)}`, at: this.#clock() }
    this.#pendingClear = this.#reset
  }

  #schedule() {
    this.#dirty = true
    if (this.loading || !this.backendUrl || this.#timer !== undefined) return
    // A fixed window batches busy streams without postponing writes forever.
    this.#timer = setTimeout(() => { void this.flush() }, JOURNAL_WRITE_INTERVAL)
  }

  async flush(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#dirty && !this.loading && this.backendUrl) {
      this.#dirty = false
      const backend = this.backendUrl
      const generation = this.#generation
      const clearRevision = this.#clearRevision
      const revision = this.#revision
      const record: JournalRecord = { retention: this.retention, entries: [...this.entries], ...(this.#reset ? { reset: this.#reset } : {}) }
      const options: JournalWriteOptions = { now: this.#clock(), clear: this.#pendingClear, retention: this.#pendingRetention }
      this.#pendingClear = undefined
      this.#pendingRetention = undefined
      this.#memory.delete(backend)
      this.#memory.set(backend, record)
      while (this.#memory.size > 4) this.#memory.delete(this.#memory.keys().next().value!)
      if (!this.#writeFailed) {
        const first = this.#pendingWrites++ === 0
        const write = async () => {
          try {
            if (!this.#writeFailed) {
              const saved = await this.#store.write(backend, record, options)
              if (saved) {
                if (this.#memory.get(backend) === record) this.#memory.set(backend, saved)
                if (generation === this.#generation && clearRevision === this.#clearRevision) {
                  const current = { retention: this.retention, entries: [...this.entries], reset: this.#reset }
                  const merged = mergeJournalRecord(saved, current, { now: this.#clock(), ...(revision !== this.#revision ? { retention: this.retention } : {}) })
                  this.entries = merged.entries
                  this.#reset = merged.reset
                  this.retention = merged.retention
                  if (this.retention === 'off') this.#tracker.pause(true)
                  this.#changed()
                }
              }
            }
          }
          catch {
            this.#writeFailed = true
            if (generation === this.#generation) { this.storageState = 'memory'; this.#changed() }
          }
          finally { this.#pendingWrites-- }
        }
        this.#writes = first ? write() : this.#store.stagesImmediately
          ? Promise.all([this.#writes, write()]).then(() => {})
          : this.#writes.then(write)
      }
    }
    await this.#writes
  }
}
