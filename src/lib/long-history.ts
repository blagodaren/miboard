import type { Connection } from './api'

export const HISTORY_HOUR = 3_600_000
export const HISTORY_DAY = 24 * HISTORY_HOUR
export const HISTORY_RETENTION = 30 * HISTORY_DAY
export const HISTORY_GAP = 15_000
export const HISTORY_ENTITIES = 24
export const HISTORY_BUCKET_BYTES = 8192
export const HISTORY_MAX_CONNECTIONS = 10_000
export type HistoryAmount = { name: string; down: number; up: number }
export type HistoryBucket = { hour: number; down: number; up: number; observedMs: number; gaps: number; devices: HistoryAmount[]; domains: HistoryAmount[] }
export type HistoryLease = { owner: string; until: number }
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const label = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 160) : ''
export const historyHour = (now: number) => Math.floor(now / HISTORY_HOUR) * HISTORY_HOUR
export const emptyHistoryBucket = (hour: number): HistoryBucket => ({ hour, down: 0, up: 0, observedMs: 0, gaps: 0, devices: [], domains: [] })
export function leaseAvailable(lease: HistoryLease | undefined, owner: string, now: number): boolean {
  return !lease || lease.owner === owner || lease.until <= now || lease.until > now + HISTORY_GAP * 2
}
function addAmount(rows: HistoryAmount[], item: HistoryAmount) {
  let row = rows.find(row => row.name === item.name)
  if (!row) {
    const name = rows.length < HISTORY_ENTITIES - 1 ? item.name : ''
    row = rows.find(row => row.name === name)
    if (!row) { row = { name, down: 0, up: 0 }; rows.push(row) }
  }
  row.down += item.down; row.up += item.up
}
function compact(rows: HistoryAmount[]) {
  const candidates = rows.filter(row => row.name !== '').sort((a, b) => a.down + a.up - b.down - b.up)
  const removed = candidates[0]
  if (!removed) return false
  rows.splice(rows.indexOf(removed), 1)
  let other = rows.find(row => row.name === '')
  if (!other) { other = { name: '', down: 0, up: 0 }; rows.push(other) }
  other.down += removed.down; other.up += removed.up
  return true
}
export function mergeHistoryBucket(previous: HistoryBucket | undefined, delta: HistoryBucket): HistoryBucket {
  const out = previous ? structuredClone(previous) : emptyHistoryBucket(delta.hour)
  out.down += delta.down; out.up += delta.up
  out.observedMs = Math.min(HISTORY_HOUR, out.observedMs + delta.observedMs)
  out.gaps += delta.gaps
  delta.devices.forEach(row => addAmount(out.devices, row))
  delta.domains.forEach(row => addAmount(out.domains, row))
  while (new TextEncoder().encode(JSON.stringify(out)).length > HISTORY_BUCKET_BYTES) {
    if (!compact(out.devices.length >= out.domains.length ? out.devices : out.domains)) break
  }
  return out
}
type Counter = { down: number; up: number; start: string }
/** Only increments between observed snapshots are counted; no reconstruction over gaps. */
export class HistoryAccumulator {
  #previous = new Map<string, Counter>()
  #at: number | null = null
  reset() { this.#previous.clear(); this.#at = null }
  observe(connections: readonly Connection[], now: number): HistoryBucket[] {
    if (!Number.isFinite(now)) return []
    const prior = this.#at
    const continuous = prior !== null && now > prior && now - prior <= HISTORY_GAP
    if (prior !== null && now <= prior) return []
    const deltas = new Map<number, HistoryBucket>()
    const bucket = (time: number) => {
      const hour = historyHour(time)
      if (!deltas.has(hour)) deltas.set(hour, emptyHistoryBucket(hour))
      return deltas.get(hour)!
    }
    const segments: { item: HistoryBucket; fraction: number }[] = []
    if (continuous) {
      let cursor = prior
      while (cursor < now) {
        const end = Math.min(now, historyHour(cursor) + HISTORY_HOUR)
        const item = bucket(cursor)
        item.observedMs += end - cursor
        segments.push({ item, fraction: (end - cursor) / (now - prior) })
        cursor = end
      }
    } else bucket(now).gaps++
    const next = new Map<string, Counter>()
    for (const conn of connections.slice(0, HISTORY_MAX_CONNECTIONS)) {
      if (!conn || typeof conn.id !== 'string' || next.has(conn.id) || !count(conn.download) || !count(conn.upload)) continue
      const last = this.#previous.get(conn.id)
      next.set(conn.id, { down: conn.download, up: conn.upload, start: conn.start })
      if (!continuous || !last || last.start !== conn.start) continue
      if (conn.download < last.down || conn.upload < last.up) { bucket(now).gaps++; continue }
      let down = conn.download - last.down, up = conn.upload - last.up
      const totalDown = down, totalUp = up
      for (let i = 0; i < segments.length; i++) {
        const { item, fraction } = segments[i]
        const d = i === segments.length - 1 ? down : Math.floor(totalDown * fraction)
        const u = i === segments.length - 1 ? up : Math.floor(totalUp * fraction)
        down -= d; up -= u; item.down += d; item.up += u
        addAmount(item.devices, { name: label(conn.metadata?.sourceIP), down: d, up: u })
        addAmount(item.domains, { name: label(conn.metadata?.host || conn.metadata?.sniffHost || conn.metadata?.destinationIP).toLowerCase(), down: d, up: u })
      }
    }
    this.#previous = next; this.#at = now
    return [...deltas.values()].map(item => mergeHistoryBucket(undefined, item))
  }
}
export function aggregateHistory(buckets: readonly HistoryBucket[], dimension: 'devices' | 'domains'): HistoryAmount[] {
  const rows = new Map<string, HistoryAmount>()
  for (const bucket of buckets) for (const item of bucket[dimension]) {
    const row = rows.get(item.name) ?? { name: item.name, down: 0, up: 0 }
    row.down += item.down; row.up += item.up; rows.set(item.name, row)
  }
  return [...rows.values()].sort((a, b) => b.down + b.up - a.down - a.up)
}

export type HistoryDay = { day: number; down: number; up: number; observedMs: number; gaps: number }
export type HistoryShare = { format: 'miboard-history'; version: 1; revision: string; collector: string; label: string; updatedAt: number; days: HistoryDay[] }
export const HISTORY_SHARE_BYTES = 128 * 1024
const HISTORY_SHARE_PREFIX = 'miboard.history.v1.'
export const HISTORY_COLLECTOR_MAX = 64 - HISTORY_SHARE_PREFIX.length
export const validHistoryCollector = (value: unknown): value is string => typeof value === 'string' && value.length >= 8 && value.length <= HISTORY_COLLECTOR_MAX && /^[a-z0-9-]+$/.test(value)
export function historyShareKey(collector: string): string {
  if (!validHistoryCollector(collector)) throw new HistoryShareError('invalid')
  return HISTORY_SHARE_PREFIX + collector
}
export function createHistoryShare(buckets: readonly HistoryBucket[], collector: string, name: string, revision: string, now = Date.now()): HistoryShare {
  const days = new Map<number, HistoryDay>()
  for (const bucket of buckets.filter(b => b.hour >= now - HISTORY_RETENTION)) {
    const day = Math.floor(bucket.hour / HISTORY_DAY) * HISTORY_DAY
    const row = days.get(day) ?? { day, down: 0, up: 0, observedMs: 0, gaps: 0 }
    row.down += bucket.down; row.up += bucket.up; row.observedMs += bucket.observedMs; row.gaps += bucket.gaps; days.set(day, row)
  }
  return parseHistoryShare({ format: 'miboard-history', version: 1, revision, collector, label: name.trim().slice(0, 80), updatedAt: now, days: [...days.values()].sort((a, b) => a.day - b.day) })!
}
export class HistoryShareError extends Error {
  code: 'invalid' | 'changed' | 'verify'
  constructor(code: 'invalid' | 'changed' | 'verify') { super(code); this.code = code; this.name = 'HistoryShareError' }
}
export function parseHistoryShare(value: unknown): HistoryShare | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new HistoryShareError('invalid')
  const v = value as HistoryShare
  if (new TextEncoder().encode(JSON.stringify(value)).length > HISTORY_SHARE_BYTES || v.format !== 'miboard-history' || v.version !== 1
    || !validHistoryCollector(v.collector) || typeof v.revision !== 'string' || !/^[a-z0-9-]{8,64}$/.test(v.revision)
    || typeof v.label !== 'string' || v.label.length > 80 || !count(v.updatedAt) || !Number.isFinite(new Date(v.updatedAt).getTime()) || !Array.isArray(v.days) || v.days.length > 31) throw new HistoryShareError('invalid')
  // Validate against the snapshot's own timestamp so archived snapshots remain
  // readable. Safe integers alone may exceed JavaScript Date's valid range.
  const firstDay = Math.floor((v.updatedAt - HISTORY_RETENTION) / HISTORY_DAY) * HISTORY_DAY
  const lastDay = Math.floor(v.updatedAt / HISTORY_DAY) * HISTORY_DAY
  const seen = new Set<number>()
  for (const day of v.days) {
    if (!day || !count(day.day) || !Number.isFinite(new Date(day.day).getTime()) || day.day < firstDay || day.day > lastDay || day.day % HISTORY_DAY !== 0 || seen.has(day.day) || !count(day.down) || !count(day.up)
      || !count(day.observedMs) || day.observedMs > HISTORY_DAY || !count(day.gaps)) throw new HistoryShareError('invalid')
    seen.add(day.day)
  }
  // Whitelist: remote JSON can never inject profiles, credentials, or extra fields into our state.
  return { format: 'miboard-history', version: 1, revision: v.revision, collector: v.collector, label: v.label, updatedAt: v.updatedAt,
    days: v.days.map(({ day, down, up, observedMs, gaps }) => ({ day, down, up, observedMs, gaps })) }
}
/** A named collector snapshot replaces itself; different browsers are never summed. */
export async function writeHistoryShare(expected: HistoryShare | null, next: HistoryShare, read: () => Promise<unknown>, write: (data: HistoryShare) => Promise<unknown>): Promise<void> {
  const current = parseHistoryShare(await read())
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new HistoryShareError('changed')
  await write(next)
  if (JSON.stringify(parseHistoryShare(await read())) !== JSON.stringify(next)) throw new HistoryShareError('verify')
}
