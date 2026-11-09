import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diagnosticHost, diagnosticRoute, domainObservations, dnsRecords, dnsRecordType } from '../src/lib/domain-diagnostics.ts'
import type { Connection, DnsResponse } from '../src/lib/api.ts'

function connection(id = 'one', host = 'Example.COM.', changes: Partial<Connection> = {}): Connection {
  return {
    id, metadata: { network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP: '203.0.113.4', destinationPort: '443', host },
    upload: 20, download: 100, start: '2026-11-09T12:00:00Z',
    chains: ['exit-node', 'selector', 'policy'], rule: 'DomainSuffix', rulePayload: 'example.com', ...changes,
  }
}

test('domain input accepts pasted URLs and IDNA without transmitting paths or credentials', () => {
  for (const [input, expected] of [
    [' Example.COM. ', 'example.com'], ['https://EXAMPLE.com:8443/path?token=private#test', 'example.com'],
    ['example.com/path', 'example.com'], ['пример.рф', 'xn--e1afmkfd.xn--p1ai'], ['router.local', 'router.local'],
  ]) assert.equal(diagnosticHost(input), expected)
  for (const input of ['', 'http://user:pass@example.com', 'https://user@example.com', 'ftp://example.com',
    '192.168.1.2', 'http://[::1]', 'bad host', 'example.com\\other', '-bad.test', 'bad_.test',
    'example..com', 'a'.repeat(64) + '.com', 'https://example.com:99999']) {
    assert.equal(diagnosticHost(input), null, input)
  }
})

test('only actual host/sniffHost observations count; a shared DNS IP does not imply a route', () => {
  const sniffed = connection('sniffed', '')
  sniffed.metadata.sniffHost = 'EXAMPLE.COM'
  const entries = domainObservations('example.com', [connection(), sniffed, connection('cdn', 'unrelated.test')], [], 100)
  assert.deepEqual(entries.map(item => item.connection.id), ['one', 'sniffed'])
  assert.equal(domainObservations('never-seen.test', [connection()], [], 100).length, 0)
})

test('active observations take precedence over history, which is ordered by last observation', () => {
  const closed = [
    { connection: connection(), firstSeenAt: 1, lastSeenAt: 40, closedAt: 50 },
    { connection: connection('older'), firstSeenAt: 1, lastSeenAt: 10, closedAt: 20 },
    { connection: connection('newer'), firstSeenAt: 1, lastSeenAt: 30, closedAt: 40, afterGap: true },
  ]
  const entries = domainObservations('example.com', [connection()], closed, 100)
  assert.deepEqual(entries.map(item => item.connection.id), ['one', 'newer', 'older'])
  assert.deepEqual(entries.map(item => item.source), ['active', 'closed', 'closed'])
  assert.equal(entries[1].afterGap, true)
  assert.equal(entries[1].observedAt, 30)
  assert.deepEqual(closed.map(item => item.connection.id), ['one', 'older', 'newer'], 'source history is not reordered')
})

test('observation output is bounded without dropping active matches in favour of history', () => {
  const active = Array.from({ length: 60 }, (_, i) => connection(String(i), 'example.com', {
    start: new Date(Date.UTC(2026, 10, 9, 12, i)).toISOString(),
  }))
  const entries = domainObservations('example.com', active, [], 100)
  assert.equal(entries.length, 50)
  assert.equal(entries[0].connection.id, '59')
  assert.equal(entries.at(-1)?.connection.id, '10')
})

test('a reused core connection ID does not hide a historical connection with a different start time', () => {
  const archived = { connection: connection(), firstSeenAt: 1, lastSeenAt: 20, closedAt: 30 }
  const live = connection('one', 'example.com', { start: '2026-11-09T13:00:00Z' })
  const entries = domainObservations('example.com', [live], [archived], 100)
  assert.equal(entries.length, 2)
  assert.notEqual(entries[0].key, entries[1].key)
})

test('the route uses the core chain in request order without changing the core data', () => {
  const item = connection()
  assert.deepEqual(diagnosticRoute(item), ['policy', 'selector', 'exit-node'])
  assert.deepEqual(item.chains, ['exit-node', 'selector', 'policy'])
  assert.deepEqual(diagnosticRoute(connection('empty', '', { chains: [] })), [])
})

test('DNS records retain CNAME, IPv4, IPv6 and zero TTL, filtering malformed data', () => {
  const valid = [{ name: 'example.com', type: 5, TTL: 0, data: 'edge.test' },
    { name: 'edge.test', type: 1, TTL: 60, data: '203.0.113.4' },
    { name: 'edge.test', type: 28, TTL: 60, data: '2001:db8::4' }]
  const response = { Status: 0, Answer: [...valid, null, { name: 'bad', type: 1, TTL: -1, data: 'bad' },
    { name: 'bad', type: 1, TTL: Infinity, data: 'bad' }, { name: 'bad', type: 1, TTL: 60, data: {} }] } as DnsResponse
  assert.deepEqual(dnsRecords(response), valid)
  assert.deepEqual(dnsRecords({ Status: 3 }), [])
  assert.deepEqual(dnsRecords({ Status: 0, Answer: {} } as DnsResponse), [])
  assert.equal(dnsRecords({ Status: 0, Answer: Array(120).fill(valid[0]) }).length, 100)
  assert.deepEqual([1, 5, 28, 65].map(dnsRecordType), ['A', 'CNAME', 'AAAA', '65'])
})
