import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnalysisTracker } from '../src/lib/analysis.ts'
import { domainExport, domainList } from '../src/lib/domain-export.ts'
import type { Connection } from '../src/lib/api.ts'

function connection(id: string, metadata: Partial<Connection['metadata']> = {}, download = 100, upload = 20): Connection {
  return {
    id, metadata: { host: `${id}.example`, network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '10000', destinationIP: '1.1.1.1', destinationPort: '443', ...metadata },
    download, upload, start: '2026-11-10T10:00:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '',
  }
}

test('every inbound dimension conserves session traffic through baseline, repeats, closes and counter resets', () => {
  const tracker = new AnalysisTracker()
  const row = (download: number, upload: number) => connection('one', { inboundName: 'DEFAULT-TUN', inboundUser: 'alice' }, download, upload)
  tracker.ingest([row(100, 20)], 1000)
  tracker.ingest([row(150, 30)], 2000)
  tracker.ingest([row(150, 30)], 3000)
  tracker.ingest([row(5, 2)], 4000)
  tracker.ingest([], 5000)
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.totals, { download: 55, upload: 12, connections: 1, active: 0 })
  for (const dimension of ['inbounds', 'protocols', 'users'] as const) {
    const [value] = snapshot[dimension]
    assert.equal(value.download, 55)
    assert.equal(value.upload, 12)
    assert.equal(value.connections, 1)
    assert.equal(value.active, 0)
    assert.deepEqual(value.sources, ['192.168.1.2'])
    assert.deepEqual(value.domains, ['one.example'])
  }
  assert.equal(snapshot.protocols[0].label, 'TCP')
})

test('unknown values, fallback types, named inbounds and users on different inbounds stay distinct', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([
    connection('unknown', { type: '', network: '', inboundName: '', inboundUser: '' }),
    connection('fallback', { inboundName: '', inboundUser: 'same' }),
    connection('named', { inboundName: 'Tun', inboundUser: 'same' }),
    connection('another', { inboundName: 'SOCKS', inboundUser: 'same', network: 'udp' }),
    connection('literal', { inboundName: 'Unknown inbound', inboundUser: 'User not reported', network: 'TCP' }),
  ])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.inbounds.length, 5)
  assert.equal(snapshot.users.length, 5)
  assert.equal(snapshot.protocols.length, 3)
  assert.equal(snapshot.users.filter((row) => row.label === 'same').length, 3)
  assert.equal(snapshot.inbounds.filter((row) => row.label === 'Tun').length, 2)
  assert.equal(new Set(snapshot.inbounds.map((row) => row.name)).size, 5)
  for (const dimension of ['inbounds', 'protocols', 'users'] as const) {
    assert.equal(snapshot[dimension].reduce((sum, row) => sum + row.download, 0), snapshot.totals.download)
    assert.equal(snapshot[dimension].reduce((sum, row) => sum + row.connections, 0), snapshot.totals.connections)
  }
})

test('late inbound metadata reattributes previously observed bytes once; repeated frame IDs do not duplicate dimensions', () => {
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection('one', { inboundName: '', inboundUser: '', type: '' })])
  const enriched = connection('one', { inboundName: 'SOCKS', inboundUser: 'alice', type: 'Socks5' })
  tracker.ingest([enriched, enriched])
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.inbounds.length, 1)
  assert.equal(snapshot.inbounds[0].label, 'SOCKS')
  assert.equal(snapshot.users[0].label, 'alice')
  assert.equal(snapshot.users[0].download, 100)
  assert.equal(snapshot.users[0].connections, 1)
  tracker.reset()
  assert.deepEqual(tracker.snapshot().inbounds, [])
  assert.deepEqual(tracker.snapshot().protocols, [])
  assert.deepEqual(tracker.snapshot().users, [])
})

test('domain export normalizes and deduplicates names, excludes IP/URL/control injections, and keeps selected order', () => {
  assert.deepEqual(domainList([
    'SECOND.example.', 'FIRST.example', 'second.example', 'ПРИМЕР.РФ.', 'router.lan',
    '1.2.3.4', '2130706433', '0x7f000001', '[2001:db8::1]', '2001:db8::1',
    'https://example.com', 'user:secret@example.com', 'ok.example\nDOMAIN,evil.example',
    '*.example.com', '-invalid.example', 'invalid-.example', 'x'.repeat(64) + '.example', null,
  ]), ['second.example', 'first.example', 'xn--e1afmkfd.xn--p1ai', 'router.lan'])
})

test('TXT export includes the entire filtered selection beyond chart and page limits', () => {
  const domains = Array.from({ length: 140 }, (_, i) => `site-${i}.example`)
  const output = domainExport(domains, '../../server:443/CON?secret')
  assert.equal(output.domains.length, 140)
  assert.equal(output.text.split('\n').filter(Boolean).length, 140)
  assert.ok(output.text.endsWith('site-139.example\n'))
  assert.match(output.filename, /^miboard-domains-[\p{L}\p{N}._-]+\.txt$/u)
  assert.ok(!output.filename.includes('..'))
  assert.deepEqual(domainExport([], ''), { domains: [], text: '', filename: 'miboard-domains.txt' })
})
