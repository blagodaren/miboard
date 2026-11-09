import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proxyCatalog, proxyEndpointKey, proxyTestSelectionKey, readProxyTestSelection, saveProxyTestSelection, validProxyTestSelection } from '../src/lib/proxy-test-selection.ts'
import { createDelayTester, DEFAULT_DELAY_SETTINGS } from '../src/lib/latency.ts'
import type { Proxy, ProxyProvider } from '../src/lib/api.ts'

const node = (name: string, delay = 10): Proxy => ({ name, type: 'Vless', history: [{ time: '2026-11-10T00:00:00Z', delay }] })
const group = (name: string, all: string[], hidden = false): Proxy => ({ name, type: 'Selector', all, now: all[0], history: [], hidden })

test('selected groups include nested leaves once, exclude other and hidden groups unless explicitly selected', () => {
  const proxies = { A: group('A', ['a', 'Nested', 'DIRECT']), Nested: group('Nested', ['shared', 'A']), B: group('B', ['b', 'shared']), Hidden: group('Hidden', ['hidden'], true), a: node('a'), DIRECT: { ...node('DIRECT'), type: 'Direct' } }
  const providers = { provider: { vehicleType: 'HTTP', proxies: [node('shared'), node('b'), node('hidden'), node('unreferenced')] } }
  const catalog = proxyCatalog(proxies, providers)
  assert.deepEqual(catalog.members(['A']).entries.map((entry) => entry.target), [{ name: 'a' }, { name: 'shared', provider: 'provider' }])
  assert.deepEqual(catalog.members(['A', 'B']).entries.map((entry) => entry.target.name), ['a', 'shared', 'b'])
  assert.deepEqual(catalog.members(['Hidden']).entries.map((entry) => entry.target.name), ['hidden'])
  assert.deepEqual(catalog.members([]).entries, [])
  assert.deepEqual(catalog.all.map((entry) => entry.target.name).sort(), ['a', 'b', 'hidden', 'shared', 'unreferenced'])
})

test('same-name provider nodes stay independent; name-only group ownership remains explicitly unresolved', async () => {
  const providers: Record<string, ProxyProvider> = {
    first: { vehicleType: 'HTTP', proxies: [node('same', 11)] },
    second: { vehicleType: 'Inline', proxies: [{ ...node('same', 99), 'dialer-proxy': 'Entry' }] },
  }
  const proxies = { A: group('A', ['same']), B: group('B', ['same']), same: { ...node('same', 11), 'provider-name': 'first' } }
  const catalog = proxyCatalog(proxies, providers)
  assert.equal(catalog.resolve('same'), undefined, 'A root hint cannot establish which provider a different group uses')
  assert.equal(catalog.lookup('same'), undefined, 'Do not display another provider’s protocol/history')
  assert.equal(catalog.ambiguous('same'), true)
  assert.deepEqual(catalog.members(['A']).ambiguousNames, ['same'])
  assert.equal(catalog.providerNode('first', 'same')!.history[0].delay, 11)
  assert.equal(catalog.providerNode('second', 'same')!.history[0].delay, 99)
  assert.deepEqual(catalog.all.map((entry) => entry.target), [{ name: 'same', provider: 'first' }, { name: 'same', provider: 'second' }])
  const requests: string[] = [], results = new Map<string, number>(), ipv6 = new Map<string, boolean>()
  const tester = createDelayTester({ groupDelay: async () => ({}), proxyDelay: async (target) => {
    requests.push(proxyEndpointKey(target))
    return { delay: target.provider === 'first' ? 11 : 99 }
  } })
  await tester.testNodes(catalog.all.map((entry) => entry.target), { ...DEFAULT_DELAY_SETTINGS, ipv6: true }, (_name, delay, target) => results.set(proxyEndpointKey(target), delay), (_name, supported, target) => ipv6.set(proxyEndpointKey(target), supported))
  assert.equal(requests.length, 4, 'Both provider-specific IPv6 and main endpoints run')
  assert.deepEqual([...results.values()].sort((a, b) => a - b), [11, 99])
  assert.equal(ipv6.size, 2)
  tester.dispose()
})

test('unique provider ownership deduplicates older root copies and keeps manual compatible entries', () => {
  const shared = node('shared'), manual = node('manual')
  const catalog = proxyCatalog({ shared, manual }, { p: { vehicleType: 'HTTP', proxies: [shared] }, default: { proxies: [manual] }, compatible: { vehicleType: 'Compatible', proxies: [manual] } })
  assert.deepEqual(catalog.resolve('shared')?.target, { name: 'shared', provider: 'p' })
  assert.deepEqual(catalog.resolve('manual')?.target, { name: 'manual' })
  assert.equal(catalog.all.length, 2)
  const collision = proxyCatalog({ shared: { ...shared, 'provider-name': 'default' } }, { first: { proxies: [shared] }, second: { proxies: [shared] } })
  assert.equal(collision.resolve('shared'), undefined, 'A group could still use any provider despite an explicit root node')
  assert.deepEqual(collision.all.map((entry) => entry.target), [{ name: 'shared', provider: 'first' }, { name: 'shared', provider: 'second' }, { name: 'shared' }], 'A verified root endpoint is included separately in a full test')
})

test('group selection is isolated per backend, validates imports and survives unavailable storage', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : Reflect.deleteProperty(globalThis, 'localStorage'))
  assert.deepEqual(readProxyTestSelection('http://first'), { mode: 'all', groups: [] })
  assert.equal(saveProxyTestSelection('http://first', { mode: 'selected', groups: ['A', 'A', 'Hidden'] }), true)
  assert.deepEqual(readProxyTestSelection('http://first'), { mode: 'selected', groups: ['A', 'Hidden'] })
  assert.deepEqual(readProxyTestSelection('http://second'), { mode: 'all', groups: [] })
  assert.notEqual(proxyTestSelectionKey('http://first'), proxyTestSelectionKey('http://second'))
  assert.equal(validProxyTestSelection({ mode: 'selected', groups: [] }), true)
  for (const value of [null, [], { mode: 'none', groups: [] }, { mode: 'all', groups: [12] }, { mode: 'selected', groups: [''] }]) assert.equal(validProxyTestSelection(value), false)
  values.set(proxyTestSelectionKey('http://first'), 'broken')
  assert.deepEqual(readProxyTestSelection('http://first'), { mode: 'all', groups: [] })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
  assert.equal(saveProxyTestSelection('http://first', { mode: 'selected', groups: [] }), false)
  assert.deepEqual(readProxyTestSelection('http://first'), { mode: 'all', groups: [] })
})
