import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '../src/lib/api.ts'
import { connectionEndpoint, connectionJSON, connectionSearchText } from '../src/lib/connection-details.ts'
import { journalConnection, JournalTracker } from '../src/lib/connection-journal.ts'

const fixture = (): Connection => ({
  id: '00000000-0000-4000-8000-000000000001',
  metadata: {
    network: 'tcp', type: 'Tun', sourceIP: '192.168.50.10', destinationIP: '', sourcePort: '49152', destinationPort: '443',
    sourceGeoIP: null, destinationGeoIP: null, sourceIPASN: '', destinationIPASN: '',
    inboundIP: '198.18.0.0', inboundPort: '30000', inboundName: 'FIXTURE-TUN', inboundUser: '', rematchName: '',
    host: 'download.fixture.example', dnsMode: 'fake-ip', uid: 0, process: '', processPath: '',
    specialProxy: '', specialRules: '', remoteDestination: 'exit.fixture.example', dscp: 0,
    id: '00000000-0000-4000-8000-000000000001', smartBlock: '', smartTarget: '', wildcardTarget: '',
    exitGeoIP: '', exitIPASN: '', sniffHost: '',
  },
  upload: 627, download: 12018, start: '2026-01-02T03:04:05.123456789Z',
  chains: ['Fixture exit', 'Fixture auto', 'Fixture select'], providerChains: ['provider', '', ''], rule: 'RuleSet',
  rulePayload: 'fixture-domains@domain', maxUploadRate: 3290, maxDownloadRate: 71350, downloadSpeed: 0, uploadSpeed: 0,
})

test('endpoints retain IPv6 boundaries and represent missing fields without invented addresses', () => {
  assert.equal(connectionEndpoint('192.168.50.10', '49152'), '192.168.50.10:49152')
  assert.equal(connectionEndpoint('download.fixture.example', 443), 'download.fixture.example:443')
  assert.equal(connectionEndpoint('2001:db8::1', '443'), '[2001:db8::1]:443')
  assert.equal(connectionEndpoint('[2001:db8::1]', '443'), '[2001:db8::1]:443')
  assert.equal(connectionEndpoint('fe80::1%eth0', '53'), '[fe80::1%eth0]:53')
  assert.equal(connectionEndpoint('2001:db8::1'), '2001:db8::1')
  assert.equal(connectionEndpoint(' ', '443'), '—:443')
  assert.equal(connectionEndpoint('', ''), '—')
  assert.equal(connectionEndpoint(), '—')
  assert.equal(connectionEndpoint('0.0.0.0', 0), '0.0.0.0:0')
  assert.equal(connectionEndpoint('127.0.0.1', Infinity), '127.0.0.1')
})

test('JSON retains backend extension fields and exact values, excluding only local display fields', () => {
  const original = { ...fixture(), backendExtension: { latency: 0, nullable: null }, dl: 800, ul: 20, journal: { closedAt: 42 } }
  const before = structuredClone(original)
  const json = connectionJSON(original)
  const parsed = JSON.parse(json)
  assert.deepEqual(parsed, { ...fixture(), backendExtension: { latency: 0, nullable: null } })
  assert.equal(parsed.metadata.uid, 0)
  assert.equal(parsed.metadata.sourceGeoIP, null)
  assert.equal(parsed.downloadSpeed, 0)
  assert.match(json, /\n  "metadata": \{/)
  assert.deepEqual(original, before, 'Copy/export never mutates live connection state')
})

test('expanded search finds independently useful protocol, endpoint, inbound and routing metadata', () => {
  const row = fixture()
  row.metadata.sniffHost = 'SNI.Example.com'
  row.metadata.processPath = 'C:\\Apps\\Browser.exe'
  row.metadata.inboundUser = 'WorkUser'
  const value = connectionSearchText(row, 'Work Laptop')
  for (const needle of ['work laptop', '49152', '30000', 'sni.example.com', 'c:\\apps\\browser.exe', 'workuser',
    'fixture-tun', 'fake-ip', 'exit.fixture.example', 'provider', 'ruleset', 'tcp', 'fixture exit', row.id]) {
    assert(value.includes(needle), `Search must include ${needle}`)
  }
  assert(!value.includes('undefined'))
  assert(!value.includes('null'))
})

test('archive preserves the supplied expanded snapshot, including null GeoIP, zero values and provider positions', () => {
  const original = fixture()
  assert.deepEqual(journalConnection(original), original)
  const tracker = new JournalTracker()
  tracker.observe([original], 1000)
  original.metadata.inboundName = 'mutated'
  original.providerChains![0] = 'mutated'
  const [entry] = tracker.observe([], 2000)
  assert.deepEqual(entry.connection, fixture(), 'Archived data is detached from the active frame')
})

test('archive bounds known extension data and drops arbitrary or invalid values', () => {
  const original = fixture()
  const input = {
    ...original,
    secret: 'do not store', backendExtension: { secret: 'do not store' },
    providerChains: ['provider', 13, '', ...Array.from({ length: 100 }, () => 'p'.repeat(5000))],
    maxDownloadRate: Infinity, maxUploadRate: -1, downloadSpeed: '123', uploadSpeed: 0,
    metadata: {
      ...original.metadata, secret: 'do not store', uid: -1, dscp: 64,
      inboundUser: 'x'.repeat(5000), sourceGeoIP: [null, 'DE', ...Array.from({ length: 20 }, () => 'x'.repeat(100))],
    },
  }
  const clean = journalConnection(input)!
  assert.equal('secret' in clean, false)
  assert.equal('backendExtension' in clean, false)
  assert.equal('secret' in clean.metadata, false)
  assert.equal(clean.metadata.inboundUser!.length, 4096)
  assert.equal(clean.metadata.sourceGeoIP!.length, 8)
  assert.equal(clean.metadata.sourceGeoIP![1].length, 64)
  assert.equal(clean.providerChains!.length, 64)
  assert.deepEqual(clean.providerChains!.slice(0, 3), ['provider', '', ''])
  assert.equal(clean.providerChains![3].length, 4096)
  for (const key of ['maxDownloadRate', 'maxUploadRate', 'downloadSpeed']) assert.equal(key in clean, false)
  assert.equal(clean.uploadSpeed, 0)
  assert.equal('uid' in clean.metadata, false)
  assert.equal('dscp' in clean.metadata, false)
})

test('ordinary mihomo records keep optional fields absent and null provider metadata remains null', () => {
  const minimal: Connection = {
    id: 'minimal', metadata: { network: 'udp', type: 'Socks5', sourceIP: '::1', sourcePort: '42', destinationIP: '1.1.1.1', destinationPort: '53', host: '' },
    upload: 1, download: 0, start: '2026-11-09T00:00:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '',
  }
  assert.deepEqual(journalConnection(minimal), minimal)
  assert.deepEqual(JSON.parse(connectionJSON(minimal)), minimal)
  assert(connectionSearchText(minimal).includes('socks5'))
  const nullable = journalConnection({ ...minimal, providerChains: null })!
  assert.equal(nullable.providerChains, null)
  assert(connectionSearchText(nullable).includes('direct'))
})
