import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observedConnections } from '../src/lib/observations.ts'
import { AnalysisTracker, UNKNOWN_ASN } from '../src/lib/analysis.ts'
import type { Connection } from '../src/lib/api.ts'
import type { JournalEntry } from '../src/lib/connection-journal.ts'

const now = Date.parse('2026-11-10T12:00:00Z')
const connection = (id: string, meta: Partial<Connection['metadata']> = {}, download = 100): Connection => ({
  id, start: '2026-11-10T10:00:00Z', download, upload: 10,
  chains: ['node', 'select'], rule: 'Match', rulePayload: '',
  metadata: { network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '4000', destinationIP: '1.1.1.1', destinationPort: '443', host: 'example.org', ...meta },
})
const entry = (row: Connection, lastSeenAt = now - 10_000): JournalEntry => ({ connection: row, firstSeenAt: now - 300_000, lastSeenAt, closedAt: lastSeenAt + 1000 })

test('applications separate devices and paths while preserving session byte baseline', () => {
  const tracker = new AnalysisTracker()
  const rows = [
    connection('a', { process: 'browser', processPath: '/bin/browser', destinationIPASN: 'AS13335 Cloudflare' }),
    connection('b', { process: 'browser', processPath: '/bin/browser', sourceIP: '192.168.1.3' }),
    connection('c', { process: 'browser', processPath: '/opt/browser' }),
    connection('d'),
  ]
  tracker.ingest(rows, now)
  tracker.ingest(rows.map(row => ({ ...row, download: row.download + 50 })), now + 1000)
  const result = tracker.snapshot()
  assert.equal(result.applications.length, 4)
  assert.equal(result.applications.reduce((sum, row) => sum + row.download, 0), 200)
  assert.equal(result.applications.filter(row => row.process === '').length, 1)
  assert.deepEqual(result.applications[0].domains, ['example.org'])
  assert.equal(result.networks.find(row => row.name === 'AS13335 Cloudflare')?.download, 50)
  assert.equal(result.networks.find(row => row.name === UNKNOWN_ASN)?.download, 150)
})

test('late process and ASN metadata reattributes bytes once; closed connections remain', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([], now)
  tracker.ingest([connection('a')], now + 1000)
  tracker.ingest([connection('a', { process: 'curl', processPath: '/bin/curl', uid: 0, destinationIPASN: 'AS13335' }, 150)], now + 2000)
  tracker.ingest([], now + 3000)
  const result = tracker.snapshot()
  assert.equal(result.applications.length, 1)
  assert.equal(result.applications[0].process, 'curl')
  assert.equal(result.applications[0].uid, 0)
  assert.equal(result.applications[0].download, 150)
  assert.equal(result.applications[0].active, 0)
  assert.equal(result.networks.length, 1)
  assert.equal(result.networks[0].download, result.totals.download)
})

test('multiple ASN metadata never inflates totals; explicit clearing restores unknown', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([], now)
  tracker.ingest([connection('a', { destinationIPASN: ['AS2', 'AS1', 'AS2'] as unknown as string })], now)
  assert.equal(tracker.snapshot().networks.length, 1)
  assert.equal(tracker.snapshot().networks[0].download, 100)
  tracker.ingest([connection('a', { destinationIPASN: '' })], now + 1000)
  assert.equal(tracker.snapshot().networks[0].name, UNKNOWN_ASN)
  assert.equal(tracker.snapshot().networks[0].download, 100)
})

test('unknown applications are grouped by device and UID when available', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([], now)
  tracker.ingest([connection('a', { uid: 0 }), connection('b', { uid: 1000 }), connection('c')], now)
  assert.equal(tracker.snapshot().applications.length, 3)
})

test('reused connection IDs with a different start retain separate application traffic', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([], now)
  tracker.ingest([connection('reused', { process: 'old-app' })], now)
  tracker.ingest([], now + 1000)
  tracker.ingest([{ ...connection('reused', { process: 'new-app' }, 20), start: '2026-11-10T12:00:00Z' }], now + 2000)
  const result = tracker.snapshot()
  assert.equal(result.totals.connections, 2)
  assert.equal(result.applications.find(row => row.process === 'old-app')?.download, 100)
  assert.equal(result.applications.find(row => row.process === 'new-app')?.download, 20)
})

test('the same application path under different users is not assigned an arbitrary UID', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([], now)
  const rows = [connection('a', { processPath: '/bin/browser', uid: 0 }), connection('b', { processPath: '/bin/browser', uid: 1000 })]
  tracker.ingest(rows, now)
  assert.deepEqual(tracker.snapshot().applications.map(row => row.uid).sort((a, b) => a! - b!), [0, 1000])
  tracker.ingest(rows.reverse(), now + 1000)
  assert.deepEqual(tracker.snapshot().applications.map(row => row.uid).sort((a, b) => a! - b!), [0, 1000])
})

test('history filters by last observation, not disappearance after a stream gap', () => {
  const recent = entry(connection('recent'), now - 30_000)
  const old = { ...entry(connection('old'), now - 2 * 3_600_000), closedAt: now - 100, afterGap: true }
  const future = entry(connection('future'), now + 1000)
  const rows = observedConnections([], [recent, old, future], '1h', now)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].download, 100)
  assert.equal(rows[0].observedClosed, true)
  assert.equal(rows[0].dl, 0)
  assert.equal(observedConnections([], [recent, old], '24h', now).length, 2)
})

test('active samples supersede journal duplicates; reused IDs with different starts stay separate', () => {
  const row = connection('same')
  const older = { ...row, start: '2026-11-09T12:00:00Z' }
  const rows = observedConnections([{ ...row, download: 200, dl: 5, ul: 1 }], [entry(row), entry(older)], '24h', now)
  assert.equal(rows.length, 2)
  assert.equal(rows.reduce((sum, row) => sum + row.download, 0), 300)
  assert.equal(rows.filter(row => row.observedClosed).length, 1)
  assert.equal(rows.reduce((sum, row) => sum + row.dl, 0), 5)
  assert.equal(row.id, 'same')
})

test('history keeps lifetime counters, selects latest duplicate and preserves gaps', () => {
  const row = connection('closed', {}, 5000)
  const result = observedConnections([], [entry(row, now - 2000), { ...entry({ ...row, download: 6000 }, now - 1000), afterGap: true }], '1h', now)
  assert.equal(result.length, 1)
  assert.equal(result[0].download, 6000)
  assert.equal(result[0].afterGap, true)
  assert.equal(observedConnections([], [entry(row)], 'active', now).length, 0)
})
