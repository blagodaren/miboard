import type { Connection } from './api'
import type { JournalEntry } from './connection-journal'

export type ObservationRange = 'active' | '1h' | '24h' | '7d'
export type ObservedConnection = Connection & { dl: number; ul: number; observedClosed?: boolean; afterGap?: boolean }
const durations = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 }
const identity = (row: Connection) => JSON.stringify([row.id, row.start])

/** Lifetime byte counters of connections observed in a window, never period traffic. */
export function observedConnections(
  active: readonly (Connection & { dl?: number; ul?: number })[],
  entries: readonly JournalEntry[],
  range: ObservationRange,
  now = Date.now(),
): ObservedConnection[] {
  if (range === 'active') return active.map(row => ({ ...row, dl: row.dl ?? 0, ul: row.ul ?? 0 }))
  const cutoff = now - durations[range]
  const closed = new Map<string, JournalEntry>()
  for (const entry of entries) {
    if (!Number.isFinite(entry.lastSeenAt) || entry.lastSeenAt < cutoff || entry.lastSeenAt > now) continue
    const key = identity(entry.connection)
    if (!closed.has(key) || closed.get(key)!.lastSeenAt < entry.lastSeenAt) closed.set(key, entry)
  }
  const rows = new Map<string, ObservedConnection>()
  for (const [key, entry] of closed) {
    rows.set(key, { ...entry.connection, id: key, dl: 0, ul: 0, observedClosed: true, afterGap: entry.afterGap })
  }
  // A live sample takes precedence over a journal copy after a reconnect.
  for (const row of active) {
    const key = identity(row)
    rows.set(key, { ...row, id: key, dl: row.dl ?? 0, ul: row.ul ?? 0 })
  }
  return [...rows.values()]
}
