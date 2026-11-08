import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRuleChainGraph, getRuleChainHighlight } from '../src/lib/rule-chain-graph.ts'
import type { RuleChainStat } from '../src/lib/rules-analytics.ts'

function chain(id: string, ruleId: string, path: string[], download = 100, upload = 20, connections = 1): RuleChainStat {
  return {
    id, ruleId, path, policy: path.length > 1 ? path[0] : path[0] ?? '',
    outbound: path.at(-1) ?? '', via: path.slice(1, -1),
    download, upload, total: download + upload, connections,
  }
}

type Graph = ReturnType<typeof buildRuleChainGraph>

function node(graph: Graph, kind: 'group' | 'outbound', name: string) {
  const matches = graph.nodes.filter((candidate) => candidate.kind === kind && candidate.name === name)
  assert.equal(matches.length, 1, `${kind} ${JSON.stringify(name)} should appear once`)
  return matches[0]
}

function totals(value: { download: number; upload: number; total: number; connections: number }) {
  return { download: value.download, upload: value.upload, total: value.total, connections: value.connections }
}

function assertGeometry(graph: Graph) {
  assert(Number.isFinite(graph.width) && graph.width >= 0)
  assert(Number.isFinite(graph.height) && graph.height >= 0)
  for (const current of graph.nodes) {
    for (const field of ['x', 'y', 'width', 'height'] as const) assert(Number.isFinite(current[field]), `${current.id}: ${field} must be finite`)
    assert(current.x >= 0 && current.y >= 0, 'Node origins must stay inside the graph')
    assert(current.width > 0 && current.height > 0, 'Nodes need visible dimensions')
    assert(current.x + current.width <= graph.width + 1, 'Graph width must contain every node')
    assert(current.y + current.height <= graph.height + 1, 'Graph height must contain every node')
  }
  for (let index = 0; index < graph.nodes.length; index++) {
    const a = graph.nodes[index]
    for (const b of graph.nodes.slice(index + 1)) {
      assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
        `Nodes ${a.id} and ${b.id} must not overlap`)
    }
  }
  const ids = new Set(graph.nodes.map((current) => current.id))
  assert.equal(ids.size, graph.nodes.length, 'Every rendered node needs a unique ID')
  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length, 'Every rendered edge needs a unique ID')
  for (const edge of graph.edges) {
    assert(ids.has(edge.source), 'Every edge source must exist')
    assert(ids.has(edge.target), 'Every edge target must exist')
  }
}

test('different rules and policies converge on one Select at different route depths', () => {
  const routes = [
    chain('a', 'rule-a', ['AI', 'Select', 'Exit'], 100, 10, 2),
    chain('b', 'rule-b', ['Meta', 'Nested', 'Select', 'Exit'], 200, 20, 3),
    chain('c', 'rule-c', ['Select', 'Exit'], 300, 30, 4),
  ]
  const original = structuredClone(routes)
  const graph = buildRuleChainGraph(routes)
  const select = node(graph, 'group', 'Select')
  const outbound = node(graph, 'outbound', 'Exit')
  assert.equal(graph.nodes.filter((current) => current.kind === 'rule').length, 3)
  assert.deepEqual(totals(select), { download: 600, upload: 60, total: 660, connections: 9 })
  assert.deepEqual(totals(outbound), totals(select))
  const shared = graph.edges.filter((edge) => edge.source === select.id && edge.target === outbound.id)
  assert.equal(shared.length, 1, 'The shared suffix should have one edge')
  assert.deepEqual(totals(shared[0]), totals(select))
  assert.equal(graph.edges.filter((edge) => edge.target === select.id).length, 3, 'All distinct incoming branches must remain connected')
  assert.deepEqual(routes, original, 'Building the graph must not reorder or change source routes')
  assert.deepEqual(buildRuleChainGraph(routes), graph, 'Repeated snapshots should produce the same layout')
})

test('one rule can split across outbound nodes without duplicating its counters', () => {
  const graph = buildRuleChainGraph([
    chain('a', 'same-rule', ['Select', 'Exit-A'], 100, 10, 2),
    chain('b', 'same-rule', ['Select', 'Exit-B'], 200, 20, 3),
    chain('c', 'other-rule', ['Select', 'Exit-A'], 50, 5, 1),
  ])
  const rule = graph.nodes.filter((current) => current.kind === 'rule' && current.ruleId === 'same-rule')
  assert.equal(rule.length, 1)
  assert.deepEqual(totals(rule[0]), { download: 300, upload: 30, total: 330, connections: 5 })
  const select = node(graph, 'group', 'Select')
  assert.deepEqual(totals(select), { download: 350, upload: 35, total: 385, connections: 6 })
  const sharedEntry = graph.edges.filter((edge) => edge.source === rule[0].id && edge.target === select.id)
  assert.equal(sharedEntry.length, 1, 'The rule entry should aggregate its routes into a single edge')
  assert.deepEqual(totals(sharedEntry[0]), totals(rule[0]))
  const exitA = node(graph, 'outbound', 'Exit-A')
  const exitB = node(graph, 'outbound', 'Exit-B')
  assert.deepEqual(totals(exitA), { download: 150, upload: 15, total: 165, connections: 3 })
  assert.deepEqual(totals(exitB), { download: 200, upload: 20, total: 220, connections: 3 })
  const outgoing = graph.edges.filter((edge) => edge.source === select.id)
  assert.deepEqual(new Set(outgoing.map((edge) => edge.target)), new Set([exitA.id, exitB.id]))
  assert.equal(outgoing.reduce((sum, edge) => sum + edge.total, 0), select.total)
  assert.equal(outgoing.reduce((sum, edge) => sum + edge.connections, 0), select.connections)
})

test('structured identities keep separator names and group/outbound roles distinct', () => {
  const graph = buildRuleChainGraph([
    chain('a', 'a|b', ['Select', 'a|b']),
    chain('b', 'a', ['a|b', 'Select']),
    chain('c', '["group","Select"]', ['a', 'b|c', 'a|b']),
  ])
  assert.equal(graph.nodes.filter((current) => current.kind === 'rule').length, 3)
  assert.notEqual(node(graph, 'group', 'Select').id, node(graph, 'outbound', 'Select').id)
  assert.notEqual(node(graph, 'group', 'a|b').id, node(graph, 'outbound', 'a|b').id)
  node(graph, 'group', 'a')
  node(graph, 'group', 'b|c')
  assertGeometry(graph)
})

test('missing paths remain unknown while a single-hop DIRECT is only an outbound', () => {
  const graph = buildRuleChainGraph([chain('unknown', 'unknown-rule', []), chain('direct', 'direct-rule', ['DIRECT'])])
  const unknownGroup = node(graph, 'group', '')
  const unknownExit = node(graph, 'outbound', '')
  assert.notEqual(unknownGroup.id, unknownExit.id)
  assert.equal(graph.nodes.filter((current) => current.kind === 'group' && current.name === 'DIRECT').length, 0)
  assert.deepEqual(totals(node(graph, 'outbound', 'DIRECT')), { download: 100, upload: 20, total: 120, connections: 1 })
  const onlyUnknown = buildRuleChainGraph([chain('unknown', 'unknown-rule', [])])
  assert(!onlyUnknown.nodes.some((current) => current.name === 'DIRECT'), 'An absent route must not be inferred as DIRECT')
  assertGeometry(graph)
})

test('all nodes fit without overlap and normal routes flow from left to right', () => {
  const graph = buildRuleChainGraph(Array.from({ length: 18 }, (_, index) => chain(`chain-${index}`, `rule-${index}`,
    index % 3 ? [`Policy-${index % 4}`, 'Select', `Exit-${index % 2}`] : [`Policy-${index % 4}`, 'Middle', 'Select', `Exit-${index % 2}`],
    index * 100, index * 3, index + 1)))
  assertGeometry(graph)
  const byId = new Map(graph.nodes.map((current) => [current.id, current]))
  for (const edge of graph.edges) {
    const source = byId.get(edge.source)!
    const target = byId.get(edge.target)!
    assert(source.x + source.width < target.x, 'Normal routing edges need space and a forward direction')
  }
})

test('changing traffic ranking keeps node identities and positions stable', () => {
  const first = buildRuleChainGraph([chain('a', 'rule-a', ['AI', 'Select', 'Exit-A'], 200), chain('b', 'rule-b', ['Meta', 'Select', 'Exit-B'], 100)])
  const second = buildRuleChainGraph([chain('b', 'rule-b', ['Meta', 'Select', 'Exit-B'], 1000), chain('a', 'rule-a', ['AI', 'Select', 'Exit-A'], 200)])
  assert.deepEqual(new Set(second.nodes.map((current) => current.id)), new Set(first.nodes.map((current) => current.id)))
  assert.deepEqual(new Set(second.edges.map((edge) => edge.id)), new Set(first.edges.map((edge) => edge.id)))
  const positions = (graph: Graph) => new Map(graph.nodes.map(({ id, x, y, width, height }) => [id, { x, y, width, height }]))
  assert.deepEqual(positions(second), positions(first), 'Counter updates must not make an unchanged graph jump')
})

test('repeated groups and cyclic observed routes terminate without multiplying per-route traffic', () => {
  const graph = buildRuleChainGraph([
    chain('repeat', 'repeated-rule', ['A', 'B', 'A', 'B', 'Exit'], 100, 20, 2),
    chain('reverse', 'reverse-rule', ['B', 'A', 'Other-Exit'], 50, 10, 1),
  ])
  assertGeometry(graph)
  assert.equal(graph.nodes.filter((current) => current.kind === 'rule').length, 2)
  for (const current of graph.nodes.filter((item) => item.kind === 'group')) {
    assert(current.total <= 180, 'A route visiting a group twice must contribute to that node only once')
    assert(current.connections <= 3, 'A repeated hop must not multiply connection counts')
  }
  for (const edge of graph.edges) {
    assert(edge.total <= 180, 'A route traversing an edge twice must contribute only once')
    assert(edge.connections <= 3)
  }
})

test('empty input produces a finite empty graph', () => {
  const graph = buildRuleChainGraph([])
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.edges, [])
  assertGeometry(graph)
})

function ruleNode(graph: Graph, ruleId: string) {
  const matches = graph.nodes.filter((candidate) => candidate.kind === 'rule' && candidate.ruleId === ruleId)
  assert.equal(matches.length, 1, `Rule ${JSON.stringify(ruleId)} should appear once`)
  return matches[0]
}

function assertHighlight(graph: Graph, anchorId: string, expectedNodes: Graph['nodes'], expectedConnections: [string, string][]) {
  const highlighted = getRuleChainHighlight(graph, anchorId)
  assert(highlighted, 'An existing anchor should activate route highlighting')
  assert.deepEqual(highlighted.nodeIds, new Set(expectedNodes.map((current) => current.id)))
  const expectedEdges = expectedConnections.map(([source, target]) => {
    const matches = graph.edges.filter((edge) => edge.source === source && edge.target === target)
    assert.equal(matches.length, 1, 'Each expected connection must exist once')
    return matches[0].id
  })
  assert.deepEqual(highlighted.edgeIds, new Set(expectedEdges))
  return highlighted
}

function splitGraph() {
  const graph = buildRuleChainGraph([
    chain('route-a', 'rule-a', ['Select', 'Exit-A']),
    chain('route-b', 'rule-b', ['Select', 'Exit-B']),
  ])
  return {
    graph, a: ruleNode(graph, 'rule-a'), b: ruleNode(graph, 'rule-b'),
    select: node(graph, 'group', 'Select'), exitA: node(graph, 'outbound', 'Exit-A'), exitB: node(graph, 'outbound', 'Exit-B'),
  }
}

test('highlighting one rule does not leak across a merged Select into another route', () => {
  const { graph, a, select, exitA } = splitGraph()
  assertHighlight(graph, a.id, [a, select, exitA], [[a.id, select.id], [select.id, exitA.id]])
})

test('highlighting a shared group includes every observed route through that group', () => {
  const { graph, a, b, select, exitA, exitB } = splitGraph()
  assertHighlight(graph, select.id, [a, b, select, exitA, exitB], [
    [a.id, select.id], [b.id, select.id], [select.id, exitA.id], [select.id, exitB.id],
  ])
})

test('highlighting an outbound traces only its actual incoming rules through shared groups', () => {
  const { graph, a, select, exitA } = splitGraph()
  assertHighlight(graph, exitA.id, [a, select, exitA], [[a.id, select.id], [select.id, exitA.id]])
})

test('a nested group highlights its branches without unrelated policies or outbound nodes', () => {
  const graph = buildRuleChainGraph([
    chain('route-a', 'rule-a', ['AI', 'Inner', 'Select', 'Exit-A']),
    chain('route-b', 'rule-b', ['Meta', 'Other', 'Select', 'Exit-B']),
    chain('route-c', 'rule-c', ['Video', 'Inner', 'Select', 'Exit-C']),
  ])
  const a = ruleNode(graph, 'rule-a')
  const c = ruleNode(graph, 'rule-c')
  const ai = node(graph, 'group', 'AI')
  const video = node(graph, 'group', 'Video')
  const inner = node(graph, 'group', 'Inner')
  const select = node(graph, 'group', 'Select')
  const exitA = node(graph, 'outbound', 'Exit-A')
  const exitC = node(graph, 'outbound', 'Exit-C')
  assertHighlight(graph, inner.id, [a, c, ai, video, inner, select, exitA, exitC], [
    [a.id, ai.id], [ai.id, inner.id], [c.id, video.id], [video.id, inner.id],
    [inner.id, select.id], [select.id, exitA.id], [select.id, exitC.id],
  ])
})

test('a rule with multiple routes highlights all its routes and excludes other rules sharing its group', () => {
  const graph = buildRuleChainGraph([
    chain('route-a', 'same-rule', ['Select', 'Exit-A']),
    chain('route-b', 'same-rule', ['Select', 'Exit-B']),
    chain('route-c', 'other-rule', ['Select', 'Exit-C']),
  ])
  const same = ruleNode(graph, 'same-rule')
  const select = node(graph, 'group', 'Select')
  const exitA = node(graph, 'outbound', 'Exit-A')
  const exitB = node(graph, 'outbound', 'Exit-B')
  assertHighlight(graph, same.id, [same, select, exitA, exitB], [
    [same.id, select.id], [select.id, exitA.id], [select.id, exitB.id],
  ])
})

test('inactive, missing and stale filtered anchors disable highlighting', () => {
  const { graph, b, exitB } = splitGraph()
  assert.equal(getRuleChainHighlight(graph, null), null)
  assert.equal(getRuleChainHighlight(graph, 'missing-node'), null)
  assert.equal(getRuleChainHighlight(buildRuleChainGraph([]), b.id), null)

  const filtered = buildRuleChainGraph([chain('route-a', 'rule-a', ['Select', 'Exit-A'])])
  assert.equal(getRuleChainHighlight(filtered, b.id), null, 'Filtering away an anchor should clear its highlight')
  assert.equal(getRuleChainHighlight(filtered, exitB.id), null, 'A removed outbound must not remain a valid anchor')
  const a = ruleNode(filtered, 'rule-a')
  const select = node(filtered, 'group', 'Select')
  const exitA = node(filtered, 'outbound', 'Exit-A')
  assertHighlight(filtered, select.id, [a, select, exitA], [[a.id, select.id], [select.id, exitA.id]])
})

test('highlight membership handles repeated hops and cycles once without following unrelated exits', () => {
  const graph = buildRuleChainGraph([
    chain('repeat', 'repeated-rule', ['A', 'B', 'A', 'B', 'Exit']),
    chain('reverse', 'reverse-rule', ['B', 'A', 'Other-Exit']),
  ])
  const repeated = ruleNode(graph, 'repeated-rule')
  const a = node(graph, 'group', 'A')
  const b = node(graph, 'group', 'B')
  const exit = node(graph, 'outbound', 'Exit')
  assertHighlight(graph, repeated.id, [repeated, a, b, exit], [
    [repeated.id, a.id], [a.id, b.id], [b.id, a.id], [b.id, exit.id],
  ])
  for (const item of [...graph.nodes, ...graph.edges]) {
    assert.equal(new Set(item.chainIds).size, item.chainIds.length, 'Each route membership should occur only once per node or edge')
  }
})

test('unknown routes highlight their unknown nodes without selecting DIRECT', () => {
  const graph = buildRuleChainGraph([
    chain('unknown-route', 'unknown-rule', []),
    chain('direct-route', 'direct-rule', ['DIRECT']),
  ])
  const unknown = ruleNode(graph, 'unknown-rule')
  const policy = node(graph, 'group', '')
  const exit = node(graph, 'outbound', '')
  assertHighlight(graph, unknown.id, [unknown, policy, exit], [[unknown.id, policy.id], [policy.id, exit.id]])
})
