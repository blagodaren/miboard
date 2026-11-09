import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nodeHistories, nodeCapabilities, historySummary, historyPlot, NODE_HISTORY_LIMIT } from '../src/lib/node-diagnostics.ts'
import type { Proxy } from '../src/lib/api.ts'

const sample = (delay: number, second = 0) => ({ time: new Date(Date.UTC(2026, 10, 10, 12, 0, second)).toISOString(), delay })
const proxy = (extra: Partial<Proxy> = {}): Proxy => ({ name: 'Node', type: 'Vless', history: [sample(777)], ...extra })

test('node histories keep generic and distinct URL checks separate, including failures', () => {
  const histories = nodeHistories(proxy({ extra: {
    'https://a.example/check': { alive: true, history: [sample(100), sample(0, 1), sample(300, 2)] },
    'https://b.example/check': { alive: true, history: [sample(5)] },
  } }))
  assert.deepEqual(histories.map(history => [history.url, history.samples.map(sample => sample.delay)]), [[null, [777]], ['https://a.example/check', [100, 0, 300]], ['https://b.example/check', [5]]])
  assert.deepEqual(historySummary(histories[1].samples), { total: 3, failed: 1, median: 200, min: 100, max: 300 })
  const plot = historyPlot(histories[1].samples)
  assert.equal(plot.paths.length, 2, 'failed sample breaks the chart line')
  assert.equal(plot.points.filter(point => point.failed).length, 1)
})

test('node diagnostics rejects corrupt samples, sorts times and bounds payload size', () => {
  const node = proxy({ history: [sample(20, 2), sample(10, 1), { time: 'invalid', delay: 5 }, sample(-5), sample(Infinity)] })
  assert.deepEqual(nodeHistories(node)[0].samples.map(sample => sample.delay), [10, 20])
  const large = nodeHistories(proxy({ history: Array.from({ length: 300 }, (_, index) => sample(index, index)) }))[0]
  assert.equal(large.samples.length, NODE_HISTORY_LIMIT)
  assert.equal(large.truncated, true)
  assert.equal(large.samples[0].delay, 100)
  assert.deepEqual(nodeHistories(null), [])
  assert.deepEqual(historySummary([]), { total: 0, failed: 0, median: null, min: null, max: null })
  assert.equal(historyPlot([{ time: 1, delay: 100, failed: false }]).points[0].x, 320)
})

test('only reported allowlisted capabilities are exposed, including explicit false and zero', () => {
  const node = proxy({ udp: true, uot: false, xudp: true, tfo: false, mptcp: true, smux: false, interface: 'eth0', 'routing-mark': 0, 'dialer-proxy': 'dialer' })
  assert.deepEqual(nodeCapabilities(node).map(item => [item.key, item.value]), [['udp', true], ['uot', false], ['xudp', true], ['tfo', false], ['mptcp', true], ['smux', false], ['interface', 'eth0'], ['dialer-proxy', 'dialer'], ['routing-mark', 0]])
  assert.deepEqual(nodeCapabilities(proxy()), [])
  assert.deepEqual(nodeCapabilities({ ...proxy(), udp: 'yes', secret: 'never show', interface: '' } as unknown as Proxy), [])
})
