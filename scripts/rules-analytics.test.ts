import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRulesAnalytics } from '../src/lib/rules-analytics.ts'
import type { Connection, Rule } from '../src/lib/api.ts'

function connection(id: string, changes: Partial<Connection> = {}): Connection {
  return {
    id,
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP: '1.1.1.1', destinationPort: '443', host: 'Example.COM.',
    },
    download: 100, upload: 20, start: '2026-11-08T12:00:00Z',
    rule: 'DomainSuffix', rulePayload: 'example.com', chains: ['exit-node', 'auto', 'selector'],
    ...changes,
  }
}

test('active-frame totals, per-rule domains and chains reconcile without accumulating repeated frames', () => {
  const frame = [
    connection('one'),
    connection('two', { download: 200, upload: 30, metadata: { ...connection('base').metadata, host: 'cdn.example.com' } }),
    connection('three', { rule: 'Match', rulePayload: '', chains: ['DIRECT'], download: 50, upload: 10 }),
  ]
  const stats = buildRulesAnalytics(frame)
  assert.deepEqual(stats.totals, { download: 350, upload: 60, total: 410, connections: 3 })
  assert.equal(stats.rules.length, 2)
  assert.equal(stats.rules[0].name, 'example.com')
  assert.equal(stats.rules[0].total, 350)
  assert.equal(stats.rules[0].connections, 2)
  assert.equal(stats.rules[0].share, 350 / 410)
  assert.deepEqual(stats.rules[0].domains.map(({ name, total }) => [name, total]), [['cdn.example.com', 230], ['example.com', 120]])
  assert.equal(stats.rules.reduce((sum, row) => sum + row.total, 0), stats.totals.total)
  assert.equal(stats.chains.reduce((sum, row) => sum + row.total, 0), stats.totals.total)
  assert.deepEqual(buildRulesAnalytics(frame), stats)
  // Closed connections disappear because this view deliberately describes open connections.
  assert.deepEqual(buildRulesAnalytics(frame.slice(0, 1)).totals, { download: 100, upload: 20, total: 120, connections: 1 })
})

test('mihomo chains are reversed for routing display and intermediate selectors stay in order', () => {
  const original = connection('one', { chains: ['node', 'inner', 'outer', 'policy'] })
  const chain = buildRulesAnalytics([original]).chains[0]
  assert.equal(chain.policy, 'policy')
  assert.equal(chain.outbound, 'node')
  assert.deepEqual(chain.via, ['outer', 'inner'])
  assert.deepEqual(chain.path, ['policy', 'outer', 'inner', 'node'])
  assert.deepEqual(original.chains, ['node', 'inner', 'outer', 'policy'])
  assert.equal(chain.total, 120)
})

test('missing chains remain unknown even when the configured rule routes to DIRECT', () => {
  const configured: Rule[] = [{ type: 'DomainSuffix', payload: 'example.com', proxy: 'DIRECT' }]
  const stats = buildRulesAnalytics([connection('one', { chains: [] })], configured)
  assert.equal(stats.rules[0].policy, '')
  assert.equal(stats.chains[0].outbound, '')
  assert.deepEqual(stats.chains[0].path, [])
  assert.equal(stats.rules[0].ruleIndex, 1)
})

test('canonical rule types match configuration while identical payloads in other types or policies remain separate', () => {
  const configured: Rule[] = [
    { type: 'DOMAIN-SUFFIX', payload: 'example.com', proxy: 'first' },
    { type: 'RuleSet', payload: 'example.com', proxy: 'first' },
    { type: 'DomainSuffix', payload: 'example.com', proxy: 'second' },
  ]
  const stats = buildRulesAnalytics([
    connection('one', { chains: ['DIRECT', 'first'] }),
    connection('two', { rule: 'RULE_SET', chains: ['DIRECT', 'first'] }),
    connection('three', { chains: ['DIRECT', 'second'] }),
  ], configured)
  assert.equal(stats.rules.length, 3)
  assert.deepEqual(stats.rules.map((row) => row.ruleIndex).sort(), [1, 2, 3])
  assert.equal(new Set(stats.rules.map((row) => row.id)).size, 3)
  const reranked = buildRulesAnalytics([
    connection('one', { chains: ['DIRECT', 'first'], download: 1000 }),
    connection('three', { chains: ['DIRECT', 'second'] }),
  ], configured)
  assert.equal(reranked.rules[0].id, stats.rules.find((row) => row.ruleIndex === 1)?.id)
  assert.equal(reranked.rules[0].ruleIndex, 1)
})

test('ambiguous configuration does not claim a specific rule position', () => {
  const configured = [
    { type: 'DomainSuffix', payload: 'example.com', proxy: 'selector' },
    { type: 'DomainSuffix', payload: 'example.com', proxy: 'selector' },
  ]
  assert.equal(buildRulesAnalytics([connection('one')], configured).rules[0].ruleIndex, null)
})

test('structured rule and chain identities cannot collide on separator-containing names', () => {
  const stats = buildRulesAnalytics([
    connection('one', { rulePayload: 'a|b', chains: ['exit', 'c'] }),
    connection('two', { rulePayload: 'a', chains: ['exit', 'b|c'] }),
    connection('three', { rulePayload: 'a|b', chains: ['exit|middle', 'c'] }),
    connection('four', { rulePayload: 'a|b', chains: ['exit', 'middle', 'c'] }),
  ])
  assert.equal(stats.rules.length, 2)
  assert.equal(stats.chains.length, 4)
  assert.equal(stats.rules.find((row) => row.payload === 'a|b')?.connections, 3)
})

test('duplicate IDs count once and malformed counters do not contaminate traffic or shares', () => {
  const stats = buildRulesAnalytics([
    connection('one'), connection('one'),
    connection('two', { download: NaN, upload: -1 }),
    connection('three', { download: Infinity, upload: 10 }),
    connection('', { download: 999999 }),
  ])
  assert.deepEqual(stats.totals, { download: 100, upload: 30, total: 130, connections: 3 })
  assert.equal(stats.rules[0].share, 1)
  assert.equal(stats.rules[0].domains[0].connections, 3)
  const zero = buildRulesAnalytics([connection('zero', { download: 0, upload: 0 })])
  assert.equal(zero.rules[0].share, 0)
  assert.deepEqual(buildRulesAnalytics([]), { totals: { download: 0, upload: 0, total: 0, connections: 0 }, rules: [], chains: [] })
})

test('domain chart prefers sniffed hosts, normalizes DNS names and excludes address-only traffic', () => {
  const withHost = (id: string, host: string, sniffHost?: string) => connection(id, {
    metadata: { ...connection('base').metadata, host, sniffHost },
  })
  const stats = buildRulesAnalytics([
    withHost('one', 'original.example', 'SNIFFED.EXAMPLE.'),
    withHost('two', 'sniffed.example'),
    withHost('three', '1.1.1.1'),
    withHost('four', '[::ffff:c000:201]'),
    withHost('five', 'fe80::1%eth0'),
    withHost('six', '2130706433'),
    withHost('seven', 'example.com/path'),
    withHost('eight', 'ПРИМЕР.РФ.'),
  ])
  assert.deepEqual(stats.rules[0].domains.map(({ name, connections }) => [name, connections]), [
    ['sniffed.example', 2], ['xn--e1afmkfd.xn--p1ai', 1],
  ])
  assert.equal(stats.totals.connections, 8)
  assert.equal(stats.rules[0].domains.reduce((sum, row) => sum + row.total, 0), 360)
  assert.equal(stats.totals.total, 960)
})
