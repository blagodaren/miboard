import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { Proxy } from '../src/lib/api.ts'
import {
  DEFAULT_PROXY_SORT,
  readProxySort,
  saveProxySort,
  saveProxySortForGroups,
  sortProxyNames,
} from '../src/lib/proxy-sort.ts'
import type { ProxySort, ProxySortDirection } from '../src/lib/proxy-sort.ts'

const noMetadata = () => undefined
const setting = (key: ProxySort['key'], direction: ProxySortDirection = 'asc'): ProxySort => ({ key, direction })

function node(name: string, type = 'Vless', delays: number[] = []): Proxy {
  return { name, type, history: delays.map((delay, index) => ({ time: String(index), delay })) }
}

function memoryStorage(t: TestContext): Storage {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const data = new Map<string, string>()
  const storage: Storage = {
    get length() { return data.size },
    clear() { data.clear() },
    getItem(key) { return data.get(String(key)) ?? null },
    key(index) { return [...data.keys()][index] ?? null },
    removeItem(key) { data.delete(String(key)) },
    setItem(key, value) { data.set(String(key), String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  return storage
}

const storageKey = (backend: string, group: string) => 'miboard.proxy-sort.v1' + JSON.stringify([backend, group])

test('configuration order returns an independent copy and ignores sort direction', () => {
  const names = Object.freeze(['node-3', 'node-1', 'node-2'])
  for (const direction of ['asc', 'desc'] as const) {
    const sorted = sortProxyNames(names, setting('config', direction), noMetadata, 'en-US')
    assert.deepEqual(sorted, names)
    assert.notEqual(sorted, names)
  }
})

test('latency uses the latest sample and keeps failed and missing nodes last in both directions', () => {
  const names = Object.freeze(['missing', 'failed-zero', 'fast', 'equal-first', 'negative', 'slow', 'equal-second', 'nan', 'infinite', 'empty'])
  const metadata = new Map([
    ['failed-zero', node('failed-zero', 'Vless', [0])],
    ['fast', node('fast', 'Vless', [900, 15])],
    ['equal-first', node('equal-first', 'Vless', [30])],
    ['negative', node('negative', 'Vless', [-1])],
    ['slow', node('slow', 'Vless', [10, 180])],
    ['equal-second', node('equal-second', 'Vless', [30])],
    ['nan', node('nan', 'Vless', [Number.NaN])],
    ['infinite', node('infinite', 'Vless', [Number.POSITIVE_INFINITY])],
    ['empty', node('empty')],
  ])
  const get = (name: string) => metadata.get(name)
  const unavailable = ['failed-zero', 'negative', 'missing', 'nan', 'infinite', 'empty']
  assert.deepEqual(sortProxyNames(names, setting('latency'), get, 'en-US'), ['fast', 'equal-first', 'equal-second', 'slow', ...unavailable])
  assert.deepEqual(sortProxyNames(names, setting('latency', 'desc'), get, 'en-US'), ['slow', 'equal-first', 'equal-second', 'fast', ...unavailable])
  assert.deepEqual(names, ['missing', 'failed-zero', 'fast', 'equal-first', 'negative', 'slow', 'equal-second', 'nan', 'infinite', 'empty'])
})

test('latency sorting follows displayed URL-specific measurements without falling back to generic history', () => {
  const names = ['untested', 'failed', 'slow', 'fast']
  // Generic history belongs to a different URL and deliberately contradicts the cards.
  const metadata = new Map([
    ['untested', node('untested', 'Vless', [1])],
    ['failed', node('failed', 'Vless', [2])],
    ['slow', node('slow', 'Vless', [3])],
    ['fast', node('fast', 'Vless', [999])],
  ])
  const displayed: Record<string, number | undefined> = { untested: undefined, failed: 0, slow: 300, fast: 25 }
  const get = (name: string) => metadata.get(name)
  const delay = (name: string) => displayed[name]
  assert.deepEqual(sortProxyNames(names, setting('latency'), get, 'en-US', delay), ['fast', 'slow', 'failed', 'untested'])
  assert.deepEqual(sortProxyNames(names, setting('latency', 'desc'), get, 'en-US', delay), ['slow', 'fast', 'failed', 'untested'])
})

test('name sorting is natural, ignores leading flags and punctuation, and preserves original names', () => {
  const names = Object.freeze(['🇩🇪 ⚡ Узел 10', '🌉 🇳🇱 Узел 2', '... узел 1'])
  assert.deepEqual(sortProxyNames(names, setting('name'), noMetadata, 'ru-RU'), ['... узел 1', '🌉 🇳🇱 Узел 2', '🇩🇪 ⚡ Узел 10'])
  assert.deepEqual(sortProxyNames(names, setting('name', 'desc'), noMetadata, 'ru-RU'), ['🇩🇪 ⚡ Узел 10', '🌉 🇳🇱 Узел 2', '... узел 1'])
  assert.deepEqual(names, ['🇩🇪 ⚡ Узел 10', '🌉 🇳🇱 Узел 2', '... узел 1'])
})

test('equivalent names keep their initial order instead of reversing ties', () => {
  const names = ['🇩🇪 Café 2', 'CAFÉ 2', 'Cafe 2']
  assert.deepEqual(sortProxyNames(names, setting('name'), noMetadata, 'en-US'), names)
  assert.deepEqual(sortProxyNames(names, setting('name', 'desc'), noMetadata, 'en-US'), names)
})

test('protocol sorting groups transports, sorts names within transports, and leaves missing types last', () => {
  const names = ['Unknown', 'Node 10', 'Trojan', 'Node 2', 'Hysteria']
  const metadata = new Map([
    ['Node 10', node('Node 10', 'Vless')],
    ['Trojan', node('Trojan', 'Trojan')],
    ['Node 2', node('Node 2', 'Vless')],
    ['Hysteria', node('Hysteria', 'Hysteria2')],
  ])
  const get = (name: string) => metadata.get(name)
  assert.deepEqual(sortProxyNames(names, setting('protocol'), get, 'en-US'), ['Hysteria', 'Trojan', 'Node 2', 'Node 10', 'Unknown'])
  assert.deepEqual(sortProxyNames(names, setting('protocol', 'desc'), get, 'en-US'), ['Node 10', 'Node 2', 'Trojan', 'Hysteria', 'Unknown'])
  metadata.set('Unknown', node('Unknown', '   '))
  assert.equal(sortProxyNames(names, setting('protocol', 'desc'), get, 'en-US').at(-1), 'Unknown')
})

test('provider sorting pins manual nodes, nested groups, built-ins and unknown names in their input order', () => {
  const names = Object.freeze(['Provider 10', 'Manual', 'Provider 2', 'DIRECT', 'Auto', 'Provider 1', 'REJECT', 'Unknown'])
  const providers = new Set(['Provider 10', 'Provider 2', 'Provider 1'])
  const metadata = new Map([
    ['Provider 10', node('Provider 10', 'Vless', [300])],
    ['Provider 2', node('Provider 2', 'Trojan', [20])],
    ['Provider 1', node('Provider 1', 'Hysteria2', [90])],
    ['Manual', node('Manual', 'Vless', [1])],
    ['DIRECT', node('DIRECT', 'Direct', [2])],
    ['Auto', { ...node('Auto', 'Selector', [3]), all: ['Provider 2'], now: 'Provider 2' }],
    ['REJECT', node('REJECT', 'Reject', [0])],
  ])
  const pinned = ['Manual', 'DIRECT', 'Auto', 'REJECT', 'Unknown']
  const expected: Record<ProxySort['key'], [string[], string[]]> = {
    config: [['Provider 10', 'Provider 2', 'Provider 1'], ['Provider 10', 'Provider 2', 'Provider 1']],
    latency: [['Provider 2', 'Provider 1', 'Provider 10'], ['Provider 10', 'Provider 1', 'Provider 2']],
    name: [['Provider 1', 'Provider 2', 'Provider 10'], ['Provider 10', 'Provider 2', 'Provider 1']],
    protocol: [['Provider 1', 'Provider 2', 'Provider 10'], ['Provider 10', 'Provider 2', 'Provider 1']],
  }
  for (const key of ['config', 'latency', 'name', 'protocol'] as const) {
    for (const [index, direction] of (['asc', 'desc'] as const).entries()) {
      const sorted = sortProxyNames(names, setting(key, direction), (name) => metadata.get(name), 'en-US', undefined, (name) => providers.has(name))
      assert.deepEqual(sorted, [...pinned, ...expected[key][index]], `${key} ${direction}`)
      assert.notEqual(sorted, names)
    }
  }
  assert.deepEqual(names, ['Provider 10', 'Manual', 'Provider 2', 'DIRECT', 'Auto', 'Provider 1', 'REJECT', 'Unknown'])
})

test('provider sorting works on filtered lists without restoring missing entries or reordering unknown manual fallbacks', () => {
  const providers = new Set(['Provider 1', 'Provider 2', 'Provider 99'])
  const metadata = new Map([
    ['Provider 1', node('Provider 1', 'Vless', [50])],
    ['Provider 2', node('Provider 2', 'Trojan', [30])],
  ])
  const names = Object.freeze(['Unknown B', 'Provider 99', 'Provider 2', 'Unknown A', 'DIRECT'])
  const sorted = sortProxyNames(names, setting('latency'), (name) => metadata.get(name), 'en-US', undefined, (name) => providers.has(name))
  assert.deepEqual(sorted, ['Unknown B', 'Unknown A', 'DIRECT', 'Provider 2', 'Provider 99'])
  assert.equal(sorted.includes('Provider 1'), false)
  assert.deepEqual(names, ['Unknown B', 'Provider 99', 'Provider 2', 'Unknown A', 'DIRECT'])
})

test('provider classification is evaluated once per unique input name, including duplicate entries', () => {
  const names = ['Provider 2', 'Manual', 'Provider 1', 'Provider 2', 'Manual']
  const calls = new Map<string, number>()
  const sorted = sortProxyNames(names, setting('name'), noMetadata, 'en-US', undefined, (name) => {
    calls.set(name, (calls.get(name) ?? 0) + 1)
    return name.startsWith('Provider')
  })
  assert.deepEqual(sorted, ['Manual', 'Manual', 'Provider 1', 'Provider 2', 'Provider 2'])
  assert.deepEqual([...calls].sort(), [['Manual', 1], ['Provider 1', 1], ['Provider 2', 1]])
})

test('provider latency sorting still follows the displayed delay callback', () => {
  const names = ['Provider 10', 'Manual', 'Provider 2']
  const metadata = new Map([
    ['Provider 10', node('Provider 10', 'Vless', [1])],
    ['Provider 2', node('Provider 2', 'Vless', [999])],
    ['Manual', node('Manual', 'Vless', [5])],
  ])
  const displayed: Record<string, number> = { 'Provider 10': 500, 'Provider 2': 2, Manual: 1 }
  const get = (name: string) => metadata.get(name)
  const delay = (name: string) => displayed[name]
  const isProvider = (name: string) => name.startsWith('Provider')
  assert.deepEqual(sortProxyNames(names, setting('latency'), get, 'en-US', delay, isProvider), ['Manual', 'Provider 2', 'Provider 10'])
  assert.deepEqual(sortProxyNames(names, setting('latency', 'desc'), get, 'en-US', delay, isProvider), ['Manual', 'Provider 10', 'Provider 2'])
})

test('saved sorting is independent for each backend and group', (t) => {
  memoryStorage(t)
  saveProxySort('http://router-one:9090', 'Select', setting('latency'))
  saveProxySort('http://router-one:9090', 'Video', setting('name', 'desc'))
  saveProxySort('http://router-two:9090', 'Select', setting('protocol'))
  assert.deepEqual(readProxySort('http://router-one:9090', 'Select'), setting('latency'))
  assert.deepEqual(readProxySort('http://router-one:9090', 'Video'), setting('name', 'desc'))
  assert.deepEqual(readProxySort('http://router-two:9090', 'Select'), setting('protocol'))
  assert.deepEqual(readProxySort('http://router-two:9090', 'Video'), DEFAULT_PROXY_SORT)
})

test('compound storage keys cannot collide when backend and group contain separators', (t) => {
  memoryStorage(t)
  saveProxySort('http://router/a:b', 'c', setting('latency'))
  saveProxySort('http://router/a', 'b:c', setting('name'))
  assert.deepEqual(readProxySort('http://router/a:b', 'c'), setting('latency'))
  assert.deepEqual(readProxySort('http://router/a', 'b:c'), setting('name'))
})

test('bulk preferences replace every listed group for every key and direction while preserving other backends', (t) => {
  memoryStorage(t)
  const groups = Object.freeze(['Select', 'Video', 'Auto'])
  saveProxySort('http://other-router:9090', 'Select', setting('protocol', 'desc'))
  for (const key of ['config', 'latency', 'name', 'protocol'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      saveProxySort('http://router:9090', 'Select', setting('latency'))
      saveProxySort('http://router:9090', 'Video', setting('name', 'desc'))
      const settings = Object.freeze(setting(key, direction))
      assert.doesNotThrow(() => saveProxySortForGroups('http://router:9090', groups, settings))
      for (const group of groups) assert.deepEqual(readProxySort('http://router:9090', group), settings, `${group}: ${key} ${direction}`)
      assert.deepEqual(settings, { key, direction })
    }
  }
  assert.deepEqual(groups, ['Select', 'Video', 'Auto'])
  assert.deepEqual(readProxySort('http://other-router:9090', 'Select'), setting('protocol', 'desc'))
  assert.deepEqual(readProxySort('http://router:9090', 'Untouched'), DEFAULT_PROXY_SORT)
})

test('bulk preferences persist each unique group once', (t) => {
  const storage = memoryStorage(t)
  const originalSet = storage.setItem.bind(storage)
  const written: string[] = []
  storage.setItem = (key, value) => { written.push(key); originalSet(key, value) }
  saveProxySortForGroups('http://router:9090', ['Select', 'Select', 'Video', 'Select', 'Video'], setting('name', 'desc'))
  assert.deepEqual(written, [storageKey('http://router:9090', 'Select'), storageKey('http://router:9090', 'Video')])
})

test('one blocked bulk storage write does not prevent later groups from saving', (t) => {
  const storage = memoryStorage(t)
  const originalSet = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    if (key === storageKey('http://router:9090', 'Blocked')) throw new Error('storage write rejected')
    originalSet(key, value)
  }
  assert.doesNotThrow(() => saveProxySortForGroups('http://router:9090', ['Before', 'Blocked', 'After'], setting('latency', 'desc')))
  assert.deepEqual(readProxySort('http://router:9090', 'Before'), setting('latency', 'desc'))
  assert.deepEqual(readProxySort('http://router:9090', 'Blocked'), DEFAULT_PROXY_SORT)
  assert.deepEqual(readProxySort('http://router:9090', 'After'), setting('latency', 'desc'))
})

test('invalid runtime bulk preferences replace existing values with safe defaults', (t) => {
  memoryStorage(t)
  const invalid: unknown[] = [null, [], {}, { key: 'manual', direction: 'asc' }, { key: 'name', direction: 'up' }, { key: 'latency' }]
  for (const settings of invalid) {
    saveProxySort('http://router:9090', 'Select', setting('protocol', 'desc'))
    saveProxySort('http://router:9090', 'Video', setting('name'))
    assert.doesNotThrow(() => saveProxySortForGroups('http://router:9090', ['Select', 'Video'], settings as ProxySort))
    assert.deepEqual(readProxySort('http://router:9090', 'Select'), DEFAULT_PROXY_SORT)
    assert.deepEqual(readProxySort('http://router:9090', 'Video'), DEFAULT_PROXY_SORT)
  }
})

test('corrupt JSON and invalid stored settings use the configuration default', (t) => {
  const storage = memoryStorage(t)
  const key = storageKey('http://router:9090', 'Select')
  for (const value of ['{broken', 'null', '[]', '"name"', '{}', '{"key":"manual","direction":"asc"}', '{"key":"name","direction":"up"}', '{"key":"latency"}']) {
    storage.setItem(key, value)
    assert.deepEqual(readProxySort('http://router:9090', 'Select'), DEFAULT_PROXY_SORT, value)
  }
})

test('blocked localStorage reads and writes do not prevent sorting or return invalid preferences', (t) => {
  const storage = memoryStorage(t)
  storage.getItem = () => { throw new Error('storage blocked') }
  storage.setItem = () => { throw new Error('storage full') }
  assert.deepEqual(readProxySort('http://router:9090', 'Select'), DEFAULT_PROXY_SORT)
  assert.doesNotThrow(() => saveProxySort('http://router:9090', 'Select', setting('latency')))
  assert.doesNotThrow(() => saveProxySortForGroups('http://router:9090', ['Select', 'Video'], setting('name')))
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage unavailable') } })
  assert.deepEqual(readProxySort('http://router:9090', 'Select'), DEFAULT_PROXY_SORT)
  assert.doesNotThrow(() => saveProxySort('http://router:9090', 'Select', setting('protocol')))
  assert.doesNotThrow(() => saveProxySortForGroups('http://router:9090', ['Select', 'Video'], setting('latency')))
})
