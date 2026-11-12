import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { Connection } from '../src/lib/api.ts'
import { ConnectionJournal, JournalTracker, JOURNAL_ACTIVE_LIMIT, JOURNAL_LIMIT, JOURNAL_WRITE_INTERVAL, journalConnection, mergeJournalRecord, retainJournal, type JournalEntry, type JournalRecord, type JournalStore } from '../src/lib/connection-journal.ts'
import { journalRetentionKey } from '../src/lib/journal-preferences.ts'

const NOW = 1_800_000_000_000
const connection = (id = 'one', patch: Partial<Connection> = {}): Connection => ({
  id, metadata: { network: 'tcp', type: 'Tun', sourceIP: '192.168.1.5', sourcePort: '1234', destinationIP: '1.1.1.1', destinationPort: '443', host: 'journal.example.com', process: 'browser', processPath: '/bin/browser' },
  start: '2026-11-01T00:00:00Z', upload: 12, download: 100, chains: ['edge', 'Auto'], rule: 'Domain', rulePayload: 'journal.example.com', ...patch,
})
const entry = (id = 'one', closedAt = NOW): JournalEntry => ({ connection: connection(id), firstSeenAt: closedAt - 2000, lastSeenAt: closedAt - 1000, closedAt })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(t: TestContext, initial = new Map<string, JournalRecord>()) {
  const data = new Map(initial)
  const store: JournalStore = { async read(key) { return structuredClone(data.get(key)) }, async write(key, value) { data.set(key, structuredClone(value)) } }
  const journal = new ConnectionJournal(store, () => NOW)
  t.after(() => journal.flush())
  return { journal, data }
}
function preferences(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  } })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return data
}

function sharedJournals(t: TestContext, initial: JournalRecord = { retention: '1h', entries: [] }) {
  let now = NOW
  const data = new Map<string, JournalRecord>([['a', structuredClone(initial)]])
  // One synchronous update models the atomic IDB transaction. The browser test
  // separately exercises the real IndexedDB implementation in two tabs.
  const store: JournalStore = {
    async read(key) { return structuredClone(data.get(key)) },
    async write(key, record, options) {
      const merged = mergeJournalRecord(data.get(key), record, options)
      data.set(key, structuredClone(merged))
      return merged
    },
  }
  const first = new ConnectionJournal(store, () => now)
  const second = new ConnectionJournal(store, () => now)
  t.after(() => Promise.all([first.flush(), second.flush()]))
  return { first, second, data, advance(milliseconds: number) { now += milliseconds } }
}

test('a stale tab pruning expired history preserves closures saved by another tab', async t => {
  const { first, second, data, advance } = sharedJournals(t, { retention: '1h', entries: [entry('expires', NOW - 3600000 + 500)] })
  await Promise.all([first.activateBackend('a'), second.activateBackend('a')])
  first.observe([connection('fresh')], NOW - 1000)
  first.observe([], NOW)
  await first.flush()
  advance(1000)
  second.prune()
  assert.deepEqual(second.entries, [])
  await second.flush()
  assert.deepEqual(data.get('a')!.entries.map(row => row.connection.id), ['fresh'])
  assert.deepEqual(second.entries.map(row => row.connection.id), ['fresh'])
})

test('draining a deferred operation validates existing records against drain time, not its old enqueue time', () => {
  const saved = { retention: '1h' as const, entries: [entry('fresh', NOW + 120000)] }
  const merged = mergeJournalRecord(saved, { retention: '1h', entries: [] }, { now: NOW, processedAt: NOW + 120000 })
  assert.deepEqual(merged.entries.map(row => row.connection.id), ['fresh'])
})

test('concurrent journal writers preserve both sets of closures and reread another tab after switching back', async t => {
  const { first, second, data } = sharedJournals(t)
  await Promise.all([first.activateBackend('a'), second.activateBackend('a')])
  first.observe([connection('first')], NOW - 2000)
  first.observe([], NOW - 1000)
  second.observe([connection('second')], NOW - 1000)
  second.observe([], NOW)
  await Promise.all([first.flush(), second.flush()])
  assert.deepEqual(data.get('a')!.entries.map(row => row.connection.id), ['second', 'first'])
  await first.activateBackend('b')
  await first.activateBackend('a')
  assert.deepEqual(first.entries.map(row => row.connection.id), ['second', 'first'])
})

test('a stale snapshot cannot resurrect cleared entries but can record later closures', async t => {
  const { first, second, data, advance } = sharedJournals(t, { retention: '1h', entries: [entry('cleared', NOW - 1)] })
  await Promise.all([first.activateBackend('a'), second.activateBackend('a')])
  first.clear()
  await first.flush()
  await second.flush()
  assert.deepEqual(data.get('a')!.entries, [])
  assert.deepEqual(second.entries, [])
  advance(10)
  second.observe([connection('new')], NOW + 1)
  second.observe([], NOW + 2)
  await second.flush()
  assert.deepEqual(data.get('a')!.entries.map(row => row.connection.id), ['new'])
})

test('a delayed clear preserves another tab closure observed after the clear was requested', async t => {
  const { first, second, data, advance } = sharedJournals(t, { retention: '1h', entries: [entry('cleared', NOW - 1)] })
  await Promise.all([first.activateBackend('a'), second.activateBackend('a')])
  first.clear()
  advance(10)
  second.observe([connection('new')], NOW + 1)
  second.observe([], NOW + 2)
  await second.flush()
  await first.flush()
  assert.deepEqual(data.get('a')!.entries.map(row => row.connection.id), ['new'])
})

test('stale writes cannot re-enable recording or restore expired history after retention is increased', async t => {
  const { first, second, data } = sharedJournals(t, { retention: '7d', entries: [entry('old', NOW - 7200000)] })
  await Promise.all([first.activateBackend('a'), second.activateBackend('a')])
  first.setRetention('1h')
  await first.flush()
  first.setRetention('7d')
  await first.flush()
  await second.flush()
  assert.deepEqual(data.get('a')!.entries, [], 'An old snapshot cannot undo expiry')
  second.observe([connection('before-off')], NOW - 1000)
  second.observe([], NOW)
  first.setRetention('off')
  await first.flush()
  await second.flush()
  assert.equal(data.get('a')!.retention, 'off')
  assert.equal(second.retention, 'off')
  assert.deepEqual(data.get('a')!.entries, [])
})

test('only disappearance from a later snapshot creates a completed record with last observed counters', () => {
  const tracker = new JournalTracker()
  const first = connection()
  assert.deepEqual(tracker.observe([first], NOW), [])
  const updated = connection('one', { download: 500 })
  assert.deepEqual(tracker.observe([updated], NOW + 1000), [])
  updated.metadata.host = 'mutated.example'
  const [closed] = tracker.observe([], NOW + 2000)
  assert.equal(closed.connection.download, 500)
  assert.equal(closed.connection.metadata.host, 'journal.example.com', 'Snapshots are copied, not retained as mutable references')
  assert.equal(closed.firstSeenAt, NOW)
  assert.equal(closed.lastSeenAt, NOW + 1000)
  assert.equal(closed.closedAt, NOW + 2000, 'The observed end is separate from the last sample')
  assert.deepEqual(tracker.observe([], NOW + 3000), [])
})

test('disconnect itself closes nothing; disappearance after reconnect retains last-seen uncertainty', () => {
  const tracker = new JournalTracker()
  tracker.observe([connection('gone'), connection('stays')], NOW)
  tracker.pause()
  const ended = tracker.observe([connection('stays')], NOW + 100000)
  assert.equal(ended.length, 1)
  assert.equal(ended[0].connection.id, 'gone')
  assert.equal(ended[0].lastSeenAt, NOW)
  assert.equal(ended[0].closedAt, NOW + 100000)
  assert.equal(ended[0].afterGap, true)
  assert.equal(tracker.observe([], NOW + 101000)[0].afterGap, undefined)
})

test('backend switch resets the active baseline without manufacturing closed records', () => {
  const tracker = new JournalTracker()
  tracker.observe([connection('old-server')], NOW)
  tracker.pause(true)
  assert.deepEqual(tracker.observe([], NOW + 10000), [])
})

test('reused IDs with different starts remain separate and out-of-order frames cannot close a newer connection', () => {
  const tracker = new JournalTracker()
  tracker.observe([connection()], NOW)
  const newer = connection('one', { start: '2026-11-02T00:00:00Z' })
  const ended = tracker.observe([newer], NOW + 1000)
  assert.equal(ended[0].connection.start, '2026-11-01T00:00:00Z')
  assert.deepEqual(tracker.observe([], NOW), [])
  assert.equal(tracker.observe([], NOW + 2000)[0].connection.start, newer.start)
})

test('truncated and malformed snapshots never prove that omitted connections ended', () => {
  const tracker = new JournalTracker()
  tracker.observe([connection('old')], NOW)
  const oversized = Array.from({ length: JOURNAL_ACTIVE_LIMIT + 1 }, (_, i) => connection(String(i)))
  assert.deepEqual(tracker.observe(oversized, NOW + 1000), [])
  assert.deepEqual(tracker.observe([], NOW + 2000), [])
  tracker.observe([connection('valid')], NOW + 3000)
  assert.deepEqual(tracker.observe([null as unknown as Connection], NOW + 4000), [])
  assert.deepEqual(tracker.observe([], NOW + 5000), [])
})

test('storage sanitization keeps required metadata but excludes arbitrary response fields and unsafe counters', () => {
  const source = { ...connection(), secret: 'never store', upload: -1, download: Infinity, metadata: { ...connection().metadata, secret: 'never store' } }
  const clean = journalConnection(source)!
  assert.equal(clean.upload, 0)
  assert.equal(clean.download, 0)
  assert.equal(clean.metadata.processPath, '/bin/browser')
  assert.equal('secret' in clean, false)
  assert.equal('secret' in clean.metadata, false)
})

test('retention validates records, expires on the requested horizon and deduplicates the latest observation', () => {
  const old = entry('old', NOW - 3600001)
  const boundary = entry('boundary', NOW - 3600000)
  const recent = entry('recent', NOW - 1000)
  const duplicate = entry('recent', NOW)
  const malformed = { ...entry('bad'), lastSeenAt: NOW + 1 }
  assert.deepEqual(retainJournal([old, boundary, recent, duplicate, malformed], '1h', NOW).map(e => e.connection.id), ['recent', 'boundary'])
  assert.equal(retainJournal([old], '24h', NOW).length, 1)
  assert.deepEqual(retainJournal([recent], 'off', NOW), [])
  assert.deepEqual(retainJournal([{ ...recent, closedAt: Infinity }], '7d', NOW), [])
})

test('the 5000-record bound keeps the newest records regardless of input order', () => {
  const source = Array.from({ length: JOURNAL_LIMIT + 30 }, (_, i) => entry(String(i), NOW - i))
  const retained = retainJournal(source.reverse(), '7d', NOW)
  assert.equal(retained.length, JOURNAL_LIMIT)
  assert.equal(retained[0].connection.id, '0')
  assert.equal(retained.at(-1)!.connection.id, String(JOURNAL_LIMIT - 1))
})

test('journals persist per backend and switching servers never archives the prior active snapshot', async t => {
  const { journal, data } = fixture(t)
  await journal.activateBackend('http://a:9090')
  journal.observe([connection('a-ended')], NOW - 2000)
  journal.observe([], NOW - 1000)
  journal.observe([connection('a-active')], NOW)
  await journal.activateBackend('http://b:9090')
  assert.equal(journal.backendUrl, 'http://b:9090')
  assert.deepEqual(journal.entries, [])
  journal.observe([], NOW + 1)
  await journal.activateBackend('http://a:9090')
  assert.deepEqual(journal.entries.map(e => e.connection.id), ['a-ended'])
  assert.equal(data.get('http://a:9090')!.entries.length, 1)
})

test('continuous closures are persisted once per batch window without delaying the next write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: JournalRecord[] = []
  const journal = new ConnectionJournal({ async read() {}, async write(_key, record) { writes.push(structuredClone(record)) } }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  await journal.flush()
  writes.length = 0
  for (let second = 1; second <= 10; second++) {
    journal.observe([connection(String(second))], NOW + second * 1000)
    journal.observe([], NOW + second * 1000 + 1)
    t.mock.timers.tick(1000)
    await tick()
    assert.equal(writes.length, Math.floor(second * 1000 / JOURNAL_WRITE_INTERVAL))
  }
  assert.deepEqual(writes.map(record => record.entries.length), [5, 10])
  t.mock.timers.tick(JOURNAL_WRITE_INTERVAL * 3)
  await tick()
  await journal.flush()
  assert.equal(writes.length, 2, 'Idle periods and redundant flushes do not rewrite the snapshot')
})

test('an explicit flush saves pending closures immediately and cancels their scheduled duplicate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const writes: JournalRecord[] = []
  const journal = new ConnectionJournal({ async read() {}, async write(_key, record) { writes.push(structuredClone(record)) } }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  await journal.flush()
  writes.length = 0
  journal.observe([connection('pending')], NOW - 1000)
  journal.observe([], NOW)
  t.mock.timers.tick(300)
  await tick()
  assert.equal(writes.length, 0)
  await journal.flush()
  assert.deepEqual(writes[0].entries.map(row => row.connection.id), ['pending'])
  t.mock.timers.tick(JOURNAL_WRITE_INTERVAL)
  await tick()
  assert.equal(writes.length, 1)
})

test('legacy retention migrates per backend, while an existing portable preference takes precedence', async t => {
  const saved = preferences(t)
  saved.set(journalRetentionKey('b'), '1h')
  const { journal } = fixture(t, new Map<string, JournalRecord>([
    ['a', { retention: '7d', entries: [entry('a-old', NOW - 7200000)] }],
    ['b', { retention: '7d', entries: [entry('b-old', NOW - 7200000)] }],
  ]))
  await journal.activateBackend('a')
  assert.equal(journal.retention, '7d')
  assert.equal(saved.get(journalRetentionKey('a')), '7d')
  assert.equal(journal.entries.length, 1)
  await journal.activateBackend('b')
  assert.equal(journal.retention, '1h')
  assert.deepEqual(journal.entries, [])
})

test('a journal flush cannot undo an imported retention preference waiting for reload', async t => {
  const saved = preferences(t)
  const { journal } = fixture(t)
  await journal.activateBackend('a')
  journal.setRetention('1h')
  await journal.flush()
  assert.equal(saved.get(journalRetentionKey('a')), '1h')
  saved.set(journalRetentionKey('a'), 'off')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  await journal.flush()
  assert.equal(journal.retention, '1h', 'An import does not change the active session until it is reloaded')
  assert.equal(saved.get(journalRetentionKey('a')), 'off', 'Lifecycle flushes only write the journal snapshot')
  await journal.activateBackend('a')
  assert.equal(journal.retention, 'off')
  assert.deepEqual(journal.entries, [])
})

test('late backend loads cannot replace the newly selected backend or its entries', async t => {
  const gate = deferred<JournalRecord>()
  const journal = new ConnectionJournal({ async read(key) { return key === 'a' ? gate.promise : { retention: '24h', entries: [entry('b')] } }, async write() {} }, () => NOW)
  t.after(() => journal.flush())
  const a = journal.activateBackend('a')
  await tick()
  await journal.activateBackend('b')
  gate.resolve({ retention: '7d', entries: [entry('a')] })
  await a
  assert.equal(journal.backendUrl, 'b')
  assert.equal(journal.retention, '24h')
  assert.equal(journal.entries[0].connection.id, 'b')
})

test('a stale failed read cannot disable persistence for the newly selected backend', async t => {
  const gate = deferred<JournalRecord>()
  const writes: [string, JournalRecord][] = []
  const journal = new ConnectionJournal({
    async read(key) { return key === 'a' ? gate.promise : undefined },
    async write(key, record) { writes.push([key, structuredClone(record)]) },
  }, () => NOW)
  t.after(() => journal.flush())
  const old = journal.activateBackend('a')
  await tick()
  await journal.activateBackend('b')
  gate.reject(new Error('Old backend read failed late'))
  await old
  journal.observe([connection('b-observed')], NOW - 1000)
  journal.observe([], NOW)
  await journal.flush()
  assert.equal(journal.backendUrl, 'b')
  assert.equal(journal.storageState, 'persistent')
  assert.equal(writes.at(-1)![0], 'b')
  assert.equal(writes.at(-1)![1].entries[0].connection.id, 'b-observed', 'The new journal is still durably written')
})

test('clear during loading cannot resurrect persisted entries when the old read finishes', async t => {
  const gate = deferred<JournalRecord>()
  let saved: JournalRecord | undefined
  const journal = new ConnectionJournal({ async read() { return gate.promise }, async write(_key, record) { saved = record } }, () => NOW)
  t.after(() => journal.flush())
  const loading = journal.activateBackend('a')
  journal.clear()
  gate.resolve({ retention: '24h', entries: [entry('old')] })
  await loading
  await journal.flush()
  assert.deepEqual(journal.entries, [])
  assert.deepEqual(saved!.entries, [])
})

test('ordered writes prevent a slow old snapshot from undoing a later clear', async t => {
  const gate = deferred<void>()
  const writes: JournalRecord[] = []
  const journal = new ConnectionJournal({ async read() {}, async write(_key, record) { writes.push(structuredClone(record)); if (writes.length === 1) await gate.promise } }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  const first = journal.flush()
  await tick()
  journal.clear()
  const second = journal.flush()
  assert.equal(writes.length, 1, 'The clear waits behind the earlier transaction')
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(writes[0].entries.length, 1)
  assert.deepEqual(writes[1].entries, [])
})

test('a lifecycle flush stages its final batch while an earlier durable write is still in flight', async t => {
  const gate = deferred<void>()
  const writes: JournalRecord[] = []
  const journal = new ConnectionJournal({
    stagesImmediately: true,
    async read() {},
    async write(_key, record) {
      writes.push(structuredClone(record))
      if (writes.length === 1) await gate.promise
    },
  }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  journal.observe([connection('before')], NOW - 2000)
  journal.observe([], NOW - 1000)
  const first = journal.flush()
  journal.clear()
  const clear = journal.flush()
  journal.observe([connection('after')], NOW)
  journal.observe([], NOW + 1)
  const lifecycle = journal.flush()
  assert.equal(writes.length, 3, 'Every batch is staged before the pagehide callback returns')
  assert.deepEqual(writes.map(record => record.entries.map(row => row.connection.id)), [['before'], [], ['after']])
  gate.resolve()
  await Promise.all([first, clear, lifecycle])
})

test('off clears the current journal, stops recording and begins a new baseline when re-enabled', async t => {
  const { journal } = fixture(t)
  await journal.activateBackend('a')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  journal.setRetention('off')
  journal.observe([connection('disabled')], NOW)
  journal.observe([], NOW + 1)
  assert.deepEqual(journal.entries, [])
  journal.setRetention('1h')
  assert.deepEqual(journal.entries, [])
  journal.observe([connection('new')], NOW + 2)
  journal.observe([], NOW + 3)
  assert.equal(journal.entries[0].connection.id, 'new')
})

test('quota failure keeps bounded entries in memory across backend changes and never clears another server', async t => {
  const journal = new ConnectionJournal({ async read() {}, async write() { throw new Error('QuotaExceededError') } }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  await journal.flush()
  assert.equal(journal.storageState, 'memory')
  assert.equal(journal.entries.length, 1)
  await journal.activateBackend('b')
  journal.clear()
  await journal.activateBackend('a')
  assert.equal(journal.entries.length, 1)
})

test('unreadable storage falls back to memory without overwriting unknown existing data', async t => {
  let writes = 0
  const journal = new ConnectionJournal({ async read() { throw new Error('Blocked') }, async write() { writes++ } }, () => NOW)
  t.after(() => journal.flush())
  await journal.activateBackend('a')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  await journal.flush()
  assert.equal(journal.storageState, 'memory')
  assert.equal(journal.entries.length, 1)
  assert.equal(writes, 0)
})

test('retention expires while offline through pruning without manufacturing another closure', async t => {
  const { journal } = fixture(t)
  await journal.activateBackend('a')
  journal.setRetention('1h')
  journal.observe([connection()], NOW - 1000)
  journal.observe([], NOW)
  journal.pause()
  journal.prune(NOW + 3600001)
  assert.deepEqual(journal.entries, [])
})
