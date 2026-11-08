import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDeviceFlow, type DeviceFlowGraph, type DeviceFlowKind } from '../src/lib/device-flow.ts'
import { UNKNOWN_DEVICE, type DeviceConnection } from '../src/lib/devices.ts'

function connection(id: string, sourceIP = '192.168.1.2', proxy = 'Exit', domain = 'api.example.com', download = 100, upload = 20): DeviceConnection {
  return {
    id, metadata: { sourceIP, sourcePort: '1234', destinationIP: '203.0.113.1', destinationPort: '443', host: domain, network: 'tcp', type: 'Tun' },
    download, upload, start: '2026-11-09T12:00:00Z', chains: proxy ? [proxy] : [], rule: 'Match', rulePayload: '',
  }
}
function totals(graph: DeviceFlowGraph, kind: DeviceFlowKind) {
  return graph.nodes.filter(node => node.kind === kind).reduce((sum, node) => ({
    download: sum.download + node.download, upload: sum.upload + node.upload,
    total: sum.total + node.total, connections: sum.connections + node.connections,
  }), { download: 0, upload: 0, total: 0, connections: 0 })
}
function geometry(graph: DeviceFlowGraph) {
  const ids = new Set(graph.nodes.map(node => node.id))
  assert.equal(ids.size, graph.nodes.length)
  assert.equal(new Set(graph.links.map(link => link.id)).size, graph.links.length)
  for (const node of graph.nodes) {
    assert(node.x >= 0 && node.y >= 0 && node.x + node.width <= graph.width && node.y + node.height <= graph.height)
    for (const other of graph.nodes) {
      if (node.id !== other.id) assert(node.x + node.width <= other.x || other.x + other.width <= node.x || node.y + node.height <= other.y || other.y + other.height <= node.y)
    }
  }
  for (const link of graph.links) {
    assert(ids.has(link.source) && ids.has(link.target))
    assert(!/NaN|Infinity/.test(link.path))
    assert(Number.isFinite(link.strokeWidth) && link.strokeWidth >= 1.5 && link.strokeWidth <= 12)
  }
}

test('empty snapshots produce an empty graph with zero totals', () => {
  assert.deepEqual(buildDeviceFlow([]), { nodes: [], links: [], width: 0, height: 0, totals: { download: 0, upload: 0, total: 0, connections: 0 } })
})

test('multiple devices share one proxy and one domain while all stage totals are conserved', () => {
  const input = [connection('a'), connection('b', '192.168.1.3'), connection('c', '192.168.1.2', 'Exit', 'api.example.com', 200, 40)]
  const original = structuredClone(input)
  const graph = buildDeviceFlow(input)
  assert.equal(graph.nodes.filter(node => node.kind === 'device').length, 2)
  assert.equal(graph.nodes.filter(node => node.kind === 'proxy').length, 1)
  assert.equal(graph.nodes.filter(node => node.kind === 'domain').length, 1)
  assert.equal(graph.links.length, 3)
  assert.deepEqual(graph.totals, { download: 400, upload: 80, total: 480, connections: 3 })
  for (const kind of ['device', 'proxy', 'domain'] as const) assert.deepEqual(totals(graph, kind), graph.totals)
  assert.deepEqual(input, original)
  assert.deepEqual(buildDeviceFlow([...input].reverse()), graph, 'Source order must not change the rendered graph')
  geometry(graph)
})

test('duplicate connection ids do not inflate counters or links', () => {
  const row = connection('same')
  const graph = buildDeviceFlow([row, row, { ...row, download: 9999 }, connection('second')])
  assert.equal(graph.totals.connections, 2)
  assert.equal(graph.totals.total, 240)
  assert.equal(graph.links.length, 2)
  for (const link of graph.links) assert.equal(link.connections, 2)
})

test('selection uses canonical device ids including IPv6 and missing source addresses', () => {
  const input = [
    connection('v6a', '2001:0db8:0000:0000:0000:0000:0000:0001'),
    connection('v6b', '[2001:db8::1]'),
    connection('unknown', ''),
    connection('v4'),
  ]
  const graph = buildDeviceFlow(input, 'traffic', '2001:db8::1')
  assert.equal(graph.totals.connections, 2)
  assert.equal(graph.nodes.find(node => node.kind === 'device')?.deviceId, '2001:db8::1')
  const unknown = buildDeviceFlow(input, 'traffic', UNKNOWN_DEVICE)
  assert.equal(unknown.totals.connections, 1)
  assert.equal(unknown.nodes.find(node => node.kind === 'device')?.unknown, true)
  assert.equal(buildDeviceFlow(input, 'traffic', '192.168.9.9').nodes.length, 0)
})

test('unknown names and real names cannot collide with Other bucket identities', () => {
  const input = [connection('unknown', '', '', ''), connection('literal', '192.168.1.2', 'other', 'other')]
  input[0].metadata.destinationIP = ''
  const graph = buildDeviceFlow(input)
  assert.equal(graph.nodes.filter(node => node.unknown).length, 3)
  assert.equal(graph.nodes.filter(node => node.other).length, 0)
  assert.equal(graph.nodes.filter(node => node.name === 'other').length, 2)
  geometry(graph)
})

test('top limits group remaining devices, proxies and domains without losing traffic or connections', () => {
  const input = Array.from({ length: 40 }, (_, index) => connection(`c${index}`, `192.168.1.${index + 1}`, `Exit-${index}`, `domain-${index}.example.com`, 100 + index, 20))
  const graph = buildDeviceFlow(input)
  assert.equal(graph.nodes.filter(node => node.kind === 'device').length, 9)
  assert.equal(graph.nodes.filter(node => node.kind === 'proxy').length, 9)
  assert.equal(graph.nodes.filter(node => node.kind === 'domain').length, 11)
  assert.equal(graph.nodes.filter(node => node.other).length, 3)
  for (const kind of ['device', 'proxy', 'domain'] as const) assert.deepEqual(totals(graph, kind), graph.totals)
  for (const kind of ['device', 'proxy'] as const) {
    const nodeIds = new Set(graph.nodes.filter(node => node.kind === kind).map(node => node.id))
    assert.equal(graph.links.filter(link => nodeIds.has(link.source)).reduce((sum, link) => sum + link.total, 0), graph.totals.total)
  }
  geometry(graph)
})

test('metric changes ranking and link weight while preserving counters, including zero traffic', () => {
  const input = [connection('big', '192.168.1.2', 'Big', 'big.example.com', 10000, 0), ...Array.from({ length: 3 }, (_, i) => connection(`small${i}`, '192.168.1.3', 'Many', 'many.example.com', 1, 0))]
  const traffic = buildDeviceFlow(input, 'traffic')
  const count = buildDeviceFlow(input, 'connections')
  assert.equal(traffic.nodes.find(node => node.kind === 'device')?.name, '192.168.1.2')
  assert.equal(count.nodes.find(node => node.kind === 'device')?.name, '192.168.1.3')
  assert.deepEqual(traffic.totals, count.totals)
  assert.notEqual(traffic.links.find(link => link.connections === 3)?.strokeWidth, count.links.find(link => link.connections === 3)?.strokeWidth)
  const zero = buildDeviceFlow([connection('zero', '192.168.1.2', 'Exit', 'api.example.com', 0, 0)])
  assert.equal(zero.nodes.length, 3)
  geometry(zero)
})

test('invalid negative counters and malformed ids cannot create invalid geometry', () => {
  const input = [connection('negative', '192.168.1.2', 'Exit', 'api.example.com', -100, Number.NaN), connection('infinite', '', '', '', Number.POSITIVE_INFINITY, -50), connection('', '192.168.1.4')]
  const graph = buildDeviceFlow(input)
  assert.equal(graph.totals.connections, 2)
  assert.equal(graph.totals.total, 0)
  geometry(graph)
})
