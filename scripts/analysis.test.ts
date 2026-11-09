import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnalysisTracker, ANALYSIS_CONNECTION_LIMIT, UNKNOWN_PROXY } from '../src/lib/analysis.ts'
import type { Connection } from '../src/lib/api.ts'

function connection(id = 'one', changes: Partial<Connection> = {}): Connection {
  return {
    id,
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP: '1.1.1.1', destinationPort: '443', host: 'Example.COM.',
    },
    upload: 20, download: 100, start: '2026-11-08T12:00:00Z',
    chains: ['exit-node', 'selector'], rule: 'Match', rulePayload: '',
    ...changes,
  }
}

test('first frame is a baseline; repeated snapshots and closed IDs do not double count', () => {
  const tracker = new AnalysisTracker()
  tracker.reset(1000)
  tracker.ingest([connection()], 1000)
  assert.deepEqual(tracker.snapshot().totals, { download: 0, upload: 0, connections: 1, active: 1 })
  tracker.ingest([connection('one', { download: 180, upload: 30 })], 2000)
  tracker.ingest([connection('one', { download: 180, upload: 30 })], 3000)
  assert.deepEqual(tracker.snapshot().totals, { download: 80, upload: 10, connections: 1, active: 1 })
  tracker.ingest([], 4000)
  assert.deepEqual(tracker.snapshot().totals, { download: 80, upload: 10, connections: 1, active: 0 })
  tracker.ingest([connection('one', { download: 200, upload: 40 })], 5000)
  assert.deepEqual(tracker.snapshot().totals, { download: 100, upload: 20, connections: 1, active: 1 })
  assert.equal(tracker.snapshot().domains[0].name, 'example.com')
  assert.deepEqual(tracker.snapshot().domains[0].ips, ['1.1.1.1'])
  assert.equal(tracker.snapshot().domains[0].lastSeen, 5000)
})

test('new connections include initial bytes; proxy attribution uses the exit node', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection(), connection('two', { chains: ['DIRECT'] }), connection('three', { chains: [] })])
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.totals, { download: 300, upload: 60, connections: 3, active: 3 })
  assert.deepEqual(snapshot.proxies.map((row) => row.name).sort(), ['DIRECT', 'exit-node', UNKNOWN_PROXY].sort())
  assert.equal(snapshot.proxies.some((row) => row.name === 'selector'), false)
  assert.equal(snapshot.domains[0].connections, 3)
})

test('a proxy named Неизвестно stays separate from connections without a proxy', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([
    connection('unknown', { chains: [], download: 100 }),
    connection('named', { chains: ['Неизвестно'], download: 250 }),
  ])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.proxies.length, 2)
  assert.equal(snapshot.proxies.find((row) => row.name === UNKNOWN_PROXY)?.download, 100)
  assert.equal(snapshot.proxies.find((row) => row.name === 'Неизвестно')?.download, 250)
  assert.deepEqual(snapshot.domains[0].proxies.sort(), [UNKNOWN_PROXY, 'Неизвестно'].sort())
})

test('late domain/IP/ASN/geo metadata attributes existing session bytes exactly once', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const initial = connection('one', { metadata: { ...connection().metadata, host: '', destinationIP: '' }, chains: [] })
  tracker.ingest([initial])
  assert.equal(tracker.snapshot().domains.length, 0)
  const enriched = connection('one', {
    metadata: {
      ...connection().metadata, host: 'original.example', sniffHost: 'Resolved.EXAMPLE.',
      destinationGeoIP: ['NL', 'private'], destinationIPASN: 'AS13335 Cloudflare',
    } as Connection['metadata'],
  })
  tracker.ingest([enriched])
  tracker.ingest([enriched])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.domains[0].name, 'resolved.example')
  assert.equal(snapshot.domains[0].download, 100)
  assert.equal(snapshot.domains[0].connections, 1)
  assert.deepEqual(snapshot.ips[0].countries, ['NL', 'private'])
  assert.deepEqual(snapshot.ips[0].asn, ['AS13335 Cloudflare'])
  assert.equal(snapshot.proxies[0].name, 'exit-node')
  assert.equal(snapshot.proxies[0].download, 100)
  assert.deepEqual(snapshot.totals, { download: 100, upload: 20, connections: 1, active: 1 })
})

test('IP literals are excluded from domains; IPv6 addresses are canonicalized', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const make = (id: string, host: string, destinationIP = '') => connection(id, {
    metadata: { ...connection().metadata, host, destinationIP },
  })
  tracker.ingest([
    make('v4', '1.1.1.1'), make('v6', '[2001:0db8:0:0:0:0:0:1]'),
    make('v6-2', '2001:db8::1'), make('none', ''), make('idn', 'ПРИМЕР.РФ.'),
  ])
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.domains.map((row) => row.name), ['xn--e1afmkfd.xn--p1ai'])
  assert.equal(snapshot.ips.find((row) => row.name === '2001:db8::1')?.connections, 2)
  assert.equal(snapshot.ips.find((row) => row.name === '1.1.1.1')?.connections, 1)
})

test('an outbound proxy peer never becomes a destination IP or an application/ASN association', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const row = connection('proxied', {
    metadata: { ...connection().metadata, destinationIP: '', remoteDestination: '8.8.8.8', process: 'browser' },
  })
  tracker.ingest([row])
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.ips, [])
  assert.equal(snapshot.domains[0].name, 'example.com')
  for (const rows of [snapshot.domains, snapshot.proxies, snapshot.applications, snapshot.networks]) {
    assert.deepEqual(rows[0].ips, [])
    assert.equal(rows[0].download, 100)
  }
  assert.deepEqual(snapshot.totals, { download: 100, upload: 20, connections: 1, active: 1 })
})

test('reported destination IPs and literal target hosts retain priority over outbound proxy peers', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const make = (id: string, metadata: Partial<Connection['metadata']>) => connection(id, {
    metadata: { ...connection().metadata, remoteDestination: '8.8.8.8', ...metadata },
  })
  tracker.ingest([
    make('resolved', { destinationIP: '1.1.1.1', host: 'example.com' }),
    make('literal', { destinationIP: '', host: '1.0.0.1' }),
    make('sniffed', { destinationIP: '', host: '', sniffHost: '9.9.9.9' }),
  ])
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.ips.map(row => row.name).sort(), ['1.0.0.1', '1.1.1.1', '9.9.9.9'])
  assert.deepEqual(snapshot.domains[0].ips, ['1.1.1.1'])
  assert.equal(snapshot.totals.download, 300)
})

test('counter resets add new bytes; invalid counters do not poison the baseline', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([connection()])
  tracker.ingest([connection('one', { download: 150, upload: 30 })])
  tracker.ingest([connection('one', { download: -5, upload: NaN })])
  tracker.ingest([connection('one', { download: 160, upload: 40 })])
  assert.deepEqual(tracker.snapshot().totals, { download: 60, upload: 20, connections: 1, active: 1 })
  tracker.ingest([connection('one', { download: 5, upload: 3 })])
  tracker.ingest([connection('one', { download: 5, upload: 3 })])
  assert.deepEqual(tracker.snapshot().totals, { download: 65, upload: 23, connections: 1, active: 1 })
})

test('reset clears the session and establishes a new byte baseline', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection()])
  tracker.reset(1234)
  assert.deepEqual(tracker.snapshot().totals, { download: 0, upload: 0, connections: 0, active: 0 })
  assert.equal(tracker.snapshot().startedAt, 1234)
  tracker.ingest([connection()])
  assert.equal(tracker.snapshot().totals.download, 0)
  tracker.ingest([connection('one', { download: 110 })])
  assert.equal(tracker.snapshot().totals.download, 10)
})

test('repeated IDs in one frame are counted once', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection(), connection()])
  assert.deepEqual(tracker.snapshot().totals, { download: 100, upload: 20, connections: 1, active: 1 })
})

test('memory limit is explicit, retains tracked IDs, and does not re-count returning IDs', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const connections = Array.from({ length: ANALYSIS_CONNECTION_LIMIT }, (_, index) => connection(String(index)))
  tracker.ingest(connections)
  tracker.ingest([connection('extra'), connection('0', { download: 110 })])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.truncated, true)
  assert.equal(snapshot.totals.connections, ANALYSIS_CONNECTION_LIMIT)
  assert.equal(snapshot.totals.download, ANALYSIS_CONNECTION_LIMIT * 100 + 10)
  assert.equal(snapshot.totals.active, 1)
  tracker.reset()
  assert.equal(tracker.snapshot().truncated, false)
})

test('lookup metadata replaces old results instead of accumulating across frames', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const enriched = (countries: string[] | null, asn?: string) => connection('one', {
    metadata: { ...connection().metadata, destinationGeoIP: countries, destinationIPASN: asn } as Connection['metadata'],
  })
  tracker.ingest([enriched(['NL'], 'AS1')])
  tracker.ingest([enriched(null)])
  assert.deepEqual(tracker.snapshot().ips[0].countries, ['NL'])
  assert.deepEqual(tracker.snapshot().ips[0].asn, ['AS1'])
  tracker.ingest([enriched(['DE'], 'AS2')])
  assert.deepEqual(tracker.snapshot().ips[0].countries, ['DE'])
  assert.deepEqual(tracker.snapshot().ips[0].asn, ['AS2'])
  tracker.ingest([enriched([], '')])
  assert.deepEqual(tracker.snapshot().ips[0].countries, [])
  assert.deepEqual(tracker.snapshot().ips[0].asn, [])
})

test('changing destination IP clears lookup results for the old address', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection('one', {
    metadata: {
      ...connection().metadata, destinationGeoIP: ['NL'], destinationIPASN: 'AS1',
    } as Connection['metadata'],
  })])
  tracker.ingest([connection('one', { metadata: { ...connection().metadata, destinationIP: '8.8.8.8' } })])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.ips.length, 1)
  assert.equal(snapshot.ips[0].name, '8.8.8.8')
  assert.deepEqual(snapshot.ips[0].countries, [])
  assert.deepEqual(snapshot.ips[0].asn, [])
  assert.equal(snapshot.ips[0].download, 100)
  assert.deepEqual(snapshot.domains[0].ips, ['8.8.8.8'])
})

test('temporarily absent metadata does not downgrade a sniffed domain or a resolved IP', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection('one', { metadata: { ...connection().metadata, sniffHost: 'sniffed.example' } })])
  tracker.ingest([connection('one', {
    metadata: { ...connection().metadata, destinationIP: '', remoteDestination: '8.8.8.8' },
  })])
  assert.equal(tracker.snapshot().domains[0].name, 'sniffed.example')
  assert.equal(tracker.snapshot().ips[0].name, '1.1.1.1')
  tracker.ingest([connection('one', { metadata: { ...connection().metadata, sniffHost: 'updated.example' } })])
  assert.equal(tracker.snapshot().domains[0].name, 'updated.example')
  assert.equal(tracker.snapshot().domains[0].download, 100)
})

test('an invalid first counter still establishes its baseline on the first valid value', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([connection('one', { download: NaN, upload: -1 })])
  tracker.ingest([connection('one', { download: 1000, upload: 50 })])
  assert.deepEqual(tracker.snapshot().totals, { download: 0, upload: 0, connections: 1, active: 1 })
  tracker.ingest([connection('one', { download: 1100, upload: 70 })])
  assert.deepEqual(tracker.snapshot().totals, { download: 100, upload: 20, connections: 1, active: 1 })
})

test('reconnect frames continue the session and preserve statistics during the gap', () => {
  const tracker = new AnalysisTracker()
  tracker.reset(1000)
  tracker.ingest([connection()], 1000)
  tracker.ingest([connection('one', { download: 150 })], 2000)
  // A socket outage produces no frames and does not call reset().
  assert.equal(tracker.snapshot().updatedAt, 2000)
  tracker.ingest([connection('one', { download: 300 }), connection('new')], 9000)
  assert.equal(tracker.snapshot().startedAt, 1000)
  assert.deepEqual(tracker.snapshot().totals, { download: 300, upload: 20, connections: 2, active: 2 })
})

test('Geo/ASN value counts are bounded and truncation is explicit', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection('one', {
    metadata: {
      ...connection().metadata,
      destinationGeoIP: Array.from({ length: 100 }, (_, index) => `region-${index}`),
      destinationIPASN: 'A'.repeat(1000),
    } as Connection['metadata'],
  })])
  assert.equal(tracker.snapshot().truncated, true)
  assert.equal(tracker.snapshot().ips[0].countries.length, 64)
  assert.equal(tracker.snapshot().ips[0].asn.length, 0)
  tracker.ingest([connection('one', { metadata: { ...connection().metadata, destinationGeoIP: ['new'] } })])
  assert.deepEqual(tracker.snapshot().ips[0].countries, ['new'])
})

test('IPv6 mapped/scoped forms stay out of domains and malformed names are ignored', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  const make = (id: string, host: string) => connection(id, {
    metadata: { ...connection().metadata, destinationIP: '', host },
  })
  tracker.ingest([
    make('mapped', '::ffff:192.0.2.1'), make('mapped2', '[::ffff:c000:201]'),
    make('scoped', 'fe80::1%eth0'), make('broken', 'example.com\\path'),
    make('integer', '2130706433'), make('bad-bracket', '[1.1.1.1'),
  ])
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.domains, [])
  assert.equal(snapshot.ips.find((row) => row.name === '::ffff:c000:201')?.connections, 2)
  assert.equal(snapshot.ips.find((row) => row.name === 'fe80::1%eth0')?.connections, 1)
  assert.equal(snapshot.ips.length, 2)
})
