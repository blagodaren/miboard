import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import type { Proxy } from '../src/lib/api.ts'
import {
  DEFAULT_DELAY_SETTINGS,
  DELAY_STORAGE_KEY,
  IPV6_TEST_URL,
  createDelayTester,
  delayHistorySample,
  delayMeasurementName,
  delayTestUrl,
  delayGroupSettings,
  isLatencyTestable,
  isBulkLatencyNode,
  proxyDelayValue,
  readDelaySettings,
  saveDelaySettings,
  resolveProxyLeaf,
  validDelaySettings,
} from '../src/lib/latency.ts'
import type { DelayClient, DelaySettings, DelayTarget } from '../src/lib/latency.ts'

const settings = (patch: Partial<DelaySettings> = {}): DelaySettings => ({ ...DEFAULT_DELAY_SETTINGS, mode: 'core', ...patch })
const panel = (patch: Partial<DelaySettings> = {}): DelaySettings => settings({ mode: 'panel', ...patch })
const target = (name: string, provider?: string): DelayTarget => provider ? { name, provider } : { name }
const history = (...values: number[]) => values.map((delay, index) => ({ time: String(index), delay }))
const node = (delays: number[] = []): Proxy => ({ name: 'node', type: 'Vless', history: history(...delays) })

function replaceStorage(t: TestContext, storage: Pick<Storage, 'getItem' | 'setItem'>): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
}

function memoryStorage(t: TestContext): Map<string, string> {
  const data = new Map<string, string>()
  replaceStorage(t, {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  })
  return data
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Let promise queues settle without tying the concurrency assertions to wall-clock time.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('new installations use the dashboard, gstatic and five-second defaults', () => {
  assert.equal(DEFAULT_DELAY_SETTINGS.mode, 'panel')
  assert.equal(DEFAULT_DELAY_SETTINGS.url, 'https://www.gstatic.com/generate_204')
  assert.equal(DEFAULT_DELAY_SETTINGS.timeout, 5000)
  assert.equal(DEFAULT_DELAY_SETTINGS.yellow, 400)
  assert.equal(DEFAULT_DELAY_SETTINGS.red, 800)
})

test('group policy uses dashboard pipelines only for selectors, load balancers and Smart groups', () => {
  const preferences = panel({ url: 'https://global.test/204', timeout: 1234, independent: true })
  for (const type of ['Selector', 'selector', 'LOADBALANCE', 'Smart']) {
    const group = { ...node(), type, testUrl: 'https://group.test/204' }
    assert.deepEqual(delayGroupSettings(group, preferences), { ...preferences, mode: 'panel', url: group.testUrl })
    assert.equal(delayGroupSettings(group, panel({ timeout: 15000 })).timeout, 2000)
    assert.equal(delayGroupSettings(group, settings({ timeout: 1234 })).mode, 'core')
    assert.equal(delayGroupSettings(group, settings({ timeout: 1234 })).timeout, 5000)
  }
  for (const type of ['URLTest', 'Fallback', 'Relay', 'Unknown']) {
    const group = { ...node(), type }
    assert.equal(delayGroupSettings(group, preferences).mode, 'core')
    assert.equal(delayGroupSettings(group, preferences).timeout, 5000)
    assert.equal(delayGroupSettings(group, panel({ timeout: 15000 })).timeout, 15000)
  }
  assert.equal(preferences.timeout, 1234, 'Planning must not overwrite the persisted setting')
})

test('group tests allow DIRECT while shared Test all excludes built-ins and every group type', () => {
  for (const type of ['Reject', 'REJECTDROP', 'block']) assert.equal(isLatencyTestable({ ...node(), type }), false)
  assert.equal(isLatencyTestable(undefined), true)
  assert.equal(isLatencyTestable({ ...node(), type: 'Direct' }), true)
  for (const type of ['Direct', 'reject', 'RejectDrop', 'Block', 'Compatible', 'Pass', 'PassRule', 'ReMatch', 'DNS', 'Relay', 'Selector', 'Fallback', 'URLTest', 'Smart', 'LoadBalance']) {
    assert.equal(isBulkLatencyNode({ ...node(), type }), false, type)
  }
  assert.equal(isBulkLatencyNode({ ...node(), hidden: true }), true, 'Hidden endpoints still participate')
  assert.equal(isBulkLatencyNode({ ...node(), all: [] }), true)
  assert.equal(isBulkLatencyNode({ ...node(), all: ['child'] }), false)
})

test('settings accept safe HTTP(S) endpoints and the supported numeric boundaries', () => {
  assert.equal(validDelaySettings(settings()), true)
  assert.equal(validDelaySettings(panel({ url: 'http://127.0.0.1:8080/check?status=204', timeout: 1, yellow: 1, red: 2 })), true)
  assert.equal(validDelaySettings(settings({ timeout: 32767, yellow: 59999, red: 60000 })), true)
  assert.equal(validDelaySettings(panel({ ipv6: true, independent: true })), true)
})

test('invalid endpoints, incomplete settings and unsafe numeric values are rejected', () => {
  const invalid: unknown[] = [null, [], {}, { ...settings(), mode: 'browser' }]
  for (const url of ['', '/relative', 'ftp://example.test/check', 'javascript:alert(1)', 'https://user:secret@example.test/check', 'https:example.com/', 'https://exam\nple.test/check', 'https://example.test/a b', 'https://example.test/\u007f']) {
    invalid.push(settings({ url }))
  }
  for (const timeout of [0, -1, 32768, 1.5, Infinity, NaN]) invalid.push(settings({ timeout }))
  for (const yellow of [0, -1, 400.5, 60001, NaN]) invalid.push(settings({ yellow }))
  for (const red of [0, -1, 60001, Infinity]) invalid.push(settings({ red }))
  invalid.push(settings({ yellow: 800, red: 800 }), settings({ yellow: 900, red: 800 }))
  for (const flag of ['ipv6', 'independent']) {
    for (const value of [undefined, null, 0, 1, 'true', 'false']) invalid.push({ ...settings(), [flag]: value })
  }
  for (const value of invalid) assert.equal(validDelaySettings(value), false, JSON.stringify(value))
})

test('settings survive reload, while invalid saves leave the previous preference intact', (t) => {
  const data = memoryStorage(t)
  const selected = panel({ url: 'https://example.test/health?code=204', timeout: 23456, yellow: 250, red: 750, ipv6: true, independent: true })
  assert.equal(saveDelaySettings(selected), true)
  assert.deepEqual(readDelaySettings(), selected)
  const saved = data.get(DELAY_STORAGE_KEY)
  assert.equal(saveDelaySettings(settings({ timeout: 32768 })), false)
  assert.equal(data.get(DELAY_STORAGE_KEY), saved)
  assert.deepEqual(readDelaySettings(), selected)
})

test('legacy settings retain the configured endpoint and thresholds when new flags are introduced', (t) => {
  const data = memoryStorage(t)
  const legacy = { mode: 'panel', url: 'https://legacy.test/204', timeout: 12345, yellow: 250, red: 999 }
  data.set(DELAY_STORAGE_KEY, JSON.stringify(legacy))
  assert.deepEqual(readDelaySettings(), { ...legacy, ipv6: false, independent: false })
  assert.equal(validDelaySettings(legacy), false, 'New saves must include boolean values for both flags')
  data.set(DELAY_STORAGE_KEY, JSON.stringify({ ...legacy, ipv6: 'false', independent: true }))
  assert.deepEqual(readDelaySettings(), DEFAULT_DELAY_SETTINGS, 'Invalid explicit flag values must not be silently migrated')
})

test('corrupt and outdated storage safely falls back to independent defaults', (t) => {
  const data = memoryStorage(t)
  for (const value of ['{', 'null', '[]', '{}', JSON.stringify(settings({ timeout: 60000 }))]) {
    data.set(DELAY_STORAGE_KEY, value)
    assert.deepEqual(readDelaySettings(), DEFAULT_DELAY_SETTINGS)
  }
  const first = readDelaySettings()
  first.url = 'https://changed.test/'
  assert.deepEqual(readDelaySettings(), DEFAULT_DELAY_SETTINGS)
})

test('unavailable storage does not prevent valid settings from applying to this session', (t) => {
  replaceStorage(t, {
    getItem() { throw new Error('Storage unavailable') },
    setItem() { throw new Error('Storage unavailable') },
  })
  assert.deepEqual(readDelaySettings(), DEFAULT_DELAY_SETTINGS)
  assert.equal(saveDelaySettings(panel()), true)
})

test('only independent measurements use a group URL, regardless of request orchestration mode', () => {
  const group: Proxy = { ...node(), testUrl: 'https://group.test/check' }
  const prefs = settings({ url: 'https://panel.test/check' })
  for (const mode of ['core', 'panel'] as const) {
    assert.equal(delayTestUrl(group, { ...prefs, mode, independent: false }), prefs.url)
    assert.equal(delayTestUrl(group, { ...prefs, mode, independent: true }), group.testUrl)
  }
  assert.equal(delayTestUrl(node(), prefs), prefs.url)
  assert.equal(delayTestUrl({ ...group, testUrl: '' }, { ...prefs, independent: true }), prefs.url)
})

test('leaf resolution follows nested selected groups to provider nodes and handles missing or cyclic selections', () => {
  const proxies: Record<string, Proxy> = {
    outer: { ...node(), name: 'outer', all: ['inner'], now: 'inner' },
    inner: { ...node(), name: 'inner', all: ['provided'], now: 'provided' },
    // Metadata lookup merges ordinary proxies and provider nodes.
    provided: { ...node([42]), name: 'provided' },
    direct: { ...node([12]), name: 'direct', type: 'Direct' },
    noSelection: { ...node(), name: 'noSelection', all: ['provided'] },
    empty: { ...node(), name: 'empty', all: [] },
    missingLeaf: { ...node(), name: 'missingLeaf', all: ['absent'], now: 'absent' },
    self: { ...node(), name: 'self', all: ['self'], now: 'self' },
    cycleA: { ...node(), name: 'cycleA', all: ['cycleB'], now: 'cycleB' },
    cycleB: { ...node(), name: 'cycleB', all: ['cycleA'], now: 'cycleA' },
  }
  const metadata = (name: string) => proxies[name]
  assert.equal(resolveProxyLeaf('outer', metadata), 'provided')
  assert.equal(resolveProxyLeaf('provided', metadata), 'provided')
  assert.equal(resolveProxyLeaf('direct', metadata), 'direct')
  for (const name of ['absent', 'noSelection', 'empty', 'missingLeaf', 'self', 'cycleA']) {
    assert.equal(resolveProxyLeaf(name, metadata), undefined, name)
  }
  assert.equal(delayMeasurementName('outer', false, metadata), 'provided')
  assert.equal(delayMeasurementName('outer', true, metadata), 'outer')
  assert.equal(delayMeasurementName('cycleA', false, metadata), 'cycleA')
})

test('independent histories stay with the named proxy and URL, while shared histories follow its selected leaf', () => {
  const url = 'https://selected.test/check'
  const group: Proxy = {
    ...node([99]), name: 'group', all: ['leaf'], now: 'leaf',
    extra: { [url]: { alive: true, history: history(81, 82) } },
  }
  const leaf: Proxy = {
    ...node([21, 22]), name: 'leaf',
    extra: { [url]: { alive: true, history: history(11, 12) } },
  }
  const proxies: Record<string, Proxy> = { group, leaf }
  const metadata = (name: string) => proxies[name]
  assert.deepEqual(delayHistorySample('group', url, false, metadata), history(11, 12)[1])
  assert.deepEqual(delayHistorySample('group', url, true, metadata), history(81, 82)[1])
  assert.deepEqual(delayHistorySample('leaf', url, true, metadata), history(11, 12)[1])
  assert.equal(delayHistorySample('group', 'https://untested.test/', true, metadata), undefined)
  assert.equal(delayHistorySample('missing', url, false, metadata), undefined)
  delete group.extra
  assert.deepEqual(delayHistorySample('group', url, true, metadata), history(21, 22)[1], 'Old cores fall back to the resolved leaf history')
  group.extra = {}
  assert.equal(delayHistorySample('group', url, true, metadata), undefined, 'Known URL histories must not fall back to unrelated measurements')
  leaf.extra![url].history = history(12, 0)
  assert.deepEqual(delayHistorySample('group', url, false, metadata), history(12, 0)[1], 'Unreachable latest results stay visible')
})

test('shared manual latency uses the selected leaf URL instead of a newer unrelated generic measurement', () => {
  const url = DEFAULT_DELAY_SETTINGS.url
  const otherUrl = 'https://other.test/check'
  const measured = { time: '2026-11-08T12:00:00Z', delay: 40 }
  const other = { time: '2026-11-08T12:00:01Z', delay: 900 }
  const leaf: Proxy = {
    ...node(), name: 'leaf', history: [other],
    extra: {
      [url]: { alive: true, history: [measured] },
      [otherUrl]: { alive: true, history: [other] },
    },
  }
  const proxies: Record<string, Proxy> = {
    outer: { ...node(), name: 'outer', all: ['inner'], now: 'inner' },
    inner: { ...node(), name: 'inner', all: ['leaf'], now: 'leaf' },
    leaf,
  }
  const metadata = (name: string) => proxies[name]
  for (const name of ['leaf', 'inner', 'outer']) {
    assert.equal(delayHistorySample(name, url, false, metadata), measured, `${name}: manual 40 ms must not become 900 ms after metadata refresh`)
    assert.equal(delayHistorySample(name, otherUrl, false, metadata), other, `${name}: each URL retains its own result`)
  }
  leaf.history = [{ time: '2026-11-08T12:00:02Z', delay: 1200 }]
  assert.equal(delayHistorySample('outer', url, false, metadata), measured, 'Later unrelated generic samples do not invalidate the matching URL result')
})

test('shared URL-specific failures and empty histories never revive a generic success', () => {
  const url = 'https://selected.test/check'
  const leaf: Proxy = {
    ...node([900]), name: 'leaf',
    extra: { [url]: { alive: false, history: history(40, 0) } },
  }
  const metadata = (name: string) => name === 'leaf' ? leaf : undefined
  assert.deepEqual(delayHistorySample('leaf', url, false, metadata), history(40, 0)[1], 'The latest failed URL sample stays zero')
  leaf.extra![url].history = []
  assert.equal(delayHistorySample('leaf', url, false, metadata), undefined, 'A known empty URL bucket is untested, even with generic success')
  delete leaf.extra![url]
  leaf.extra!['https://unrelated.test/check'] = { alive: true, history: history(1500) }
  assert.deepEqual(delayHistorySample('leaf', url, false, metadata), history(900)[0], 'An absent requested bucket retains legacy generic fallback')
  delete leaf.extra
  assert.deepEqual(delayHistorySample('leaf', url, false, metadata), history(900)[0], 'Legacy cores without URL buckets remain supported')
})

test('an unknown shared URL retains IPv6 exclusion while an empty matching bucket stays empty', () => {
  const url = 'https://selected.test/check'
  const normal = { time: '2026-11-08T12:00:00Z', delay: 40 }
  const ipv6 = { time: '2026-11-08T12:00:01Z', delay: 900 }
  const leaf: Proxy = {
    ...node(), name: 'leaf', history: [normal, ipv6],
    extra: { [IPV6_TEST_URL]: { alive: true, history: [ipv6] } },
  }
  const metadata = (name: string) => name === 'leaf' ? leaf : undefined
  assert.equal(delayHistorySample('leaf', url, false, metadata), normal)
  leaf.extra![url] = { alive: false, history: [] }
  assert.equal(delayHistorySample('leaf', url, false, metadata), undefined)
  delete leaf.extra![url]
  leaf.history = history(22, 0)
  assert.deepEqual(delayHistorySample('leaf', url, false, metadata), history(22, 0)[1], 'Unreachable latest results stay visible')
})

test('shared latency excludes IPv6 probe samples by exact timestamp and value unless IPv6 is the main endpoint', () => {
  const url = 'https://normal.test/check'
  const normal = { time: '2026-11-08T12:00:00Z', delay: 80 }
  const ipv6 = { time: '2026-11-08T12:00:01Z', delay: 80 }
  const leaf: Proxy = {
    ...node(), name: 'leaf', history: [normal, ipv6],
    extra: { [IPV6_TEST_URL]: { alive: true, history: [{ ...ipv6 }] } },
  }
  const proxies: Record<string, Proxy> = {
    group: { ...node(), name: 'group', all: ['leaf'], now: 'leaf' },
    leaf,
  }
  const metadata = (name: string) => proxies[name]
  assert.deepEqual(delayHistorySample('group', url, false, metadata), normal, 'Equal delay with a different timestamp remains a normal measurement')
  leaf.history = [ipv6]
  assert.equal(delayHistorySample('group', url, false, metadata), undefined, 'A probe alone must not become the main latency')
  assert.deepEqual(delayHistorySample('group', IPV6_TEST_URL, false, metadata), ipv6)
  assert.deepEqual(delayHistorySample('leaf', IPV6_TEST_URL, true, metadata), ipv6, 'A deliberately configured IPv6 main endpoint is valid')
  const differentDelay = { ...ipv6, delay: 81 }
  leaf.history = [differentDelay]
  assert.deepEqual(delayHistorySample('group', url, false, metadata), differentDelay, 'A timestamp match without a delay match must not filter a sample')
  const failedMain = { ...normal, delay: 0 }
  leaf.history = [failedMain, ipv6]
  assert.deepEqual(delayHistorySample('group', url, false, metadata), failedMain, 'A successful probe must not hide a failed main test')
})

test('displayed latency belongs to the selected URL, including failed latest samples', () => {
  const url = 'https://selected.test/check'
  const proxy: Proxy = {
    ...node([17]),
    extra: {
      [url]: { alive: false, history: history(123, 0) },
      'https://other.test/check': { alive: true, history: history(999) },
    },
  }
  assert.equal(proxyDelayValue(proxy, url), 0)
  assert.equal(proxyDelayValue(proxy, 'https://other.test/check'), 999)
  assert.equal(proxyDelayValue(proxy, 'https://untested.test/check'), undefined)
  assert.equal(proxyDelayValue({ ...proxy, extra: { [url]: { alive: true, history: [] } } }, url), undefined)
  assert.equal(proxyDelayValue(node([45, 0]), url), 0)
  assert.equal(proxyDelayValue(node(), url), undefined)
  assert.equal(proxyDelayValue(undefined, url), undefined)
})

test('core mode sends one group request and marks omitted nodes as unreachable', async () => {
  const calls: unknown[][] = []
  const results: Record<string, number> = {}
  const prefs = settings({ url: 'https://group.test/', timeout: 21000 })
  const tester = createDelayTester({
    async groupDelay(...args) { calls.push(args); return { live: 72 } },
    async proxyDelay() { assert.fail('Core mode must use the group endpoint') },
  })
  await tester.testGroup('Группа / x', [target('live'), target('offline', 'provider')], prefs, (name, delay) => { results[name] = delay })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 3), ['Группа / x', prefs.url, prefs.timeout])
  assert(calls[0][3] instanceof AbortSignal)
  assert.equal(calls[0][3].aborted, false)
  assert.deepEqual(results, { live: 72, offline: 0 })
})

test('group API errors remain visible to the caller', async () => {
  const failure = new Error('Unauthorized')
  const tester = createDelayTester({
    async groupDelay() { throw failure },
    async proxyDelay() { assert.fail('Unexpected per-node request') },
  })
  await assert.rejects(tester.testGroup('group', [target('node')], settings(), () => assert.fail('No successful result')), (error) => error === failure)
})

test('panel mode passes provider identity, URL and timeout and continues after a failed node', async () => {
  const calls: { target: DelayTarget; url: string; timeout: number }[] = []
  const results: Record<string, number> = {}
  const prefs = panel({ url: 'https://custom.test/204', timeout: 32000 })
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Panel mode must use individual endpoints') },
    async proxyDelay(selected, url, timeout) {
      calls.push({ target: selected, url, timeout })
      if (selected.name === 'offline') throw new Error('Request timed out')
      return { delay: selected.provider ? 83 : 51 }
    },
  })
  await tester.testGroup('group', [target('direct'), target('provided', 'subscription / a'), target('offline')], prefs, (name, delay) => { results[name] = delay })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.find((call) => call.target.name === 'provided'), { target: target('provided', 'subscription / a'), url: prefs.url, timeout: prefs.timeout })
  assert(calls.every((call) => call.url === prefs.url && call.timeout === prefs.timeout))
  assert.deepEqual(results, { direct: 51, provided: 83, offline: 0 })
})

test('panel failures publish unreachable results and reject when every node fails', async () => {
  const failure = new Error('Core unavailable')
  const results: Record<string, number> = {}
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { throw failure },
  }, 1)
  await assert.rejects(tester.testGroup('group', [target('a'), target('b')], panel(), (name, delay) => { results[name] = delay }), (error) => error === failure)
  assert.deepEqual(results, { a: 0, b: 0 })
})

test('the panel concurrency limit is shared across simultaneous groups', async () => {
  let active = 0
  let maximum = 0
  let started = 0
  const gates: ReturnType<typeof deferred<{ delay: number }>>[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() {
      started++
      active++
      maximum = Math.max(maximum, active)
      const gate = deferred<{ delay: number }>()
      gates.push(gate)
      try { return await gate.promise } finally { active-- }
    },
  })
  const a = tester.testGroup('a', ['a1', 'a2', 'a3', 'a4'].map((name) => target(name)), panel(), () => {})
  const b = tester.testGroup('b', ['b1', 'b2', 'b3', 'b4'].map((name) => target(name)), panel(), () => {})
  await tick()
  assert.equal(started, 5)
  assert.equal(active, 5)
  while (gates.length) {
    gates.shift()!.resolve({ delay: 50 })
    await tick()
  }
  await Promise.all([a, b])
  assert.equal(started, 8)
  assert.equal(active, 0)
  assert.equal(maximum, 5)
})

test('overlapping groups share an in-flight measurement and both receive its result', async () => {
  const gate = deferred<{ delay: number }>()
  let calls = 0
  const client: DelayClient = {
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { calls++; return gate.promise },
  }
  const tester = createDelayTester(client)
  const a: unknown[] = []
  const b: unknown[] = []
  const shared = target('shared', 'provider')
  const first = tester.testGroup('a', [shared], panel(), (...result) => { a.push(result) })
  const second = tester.testGroup('b', [shared], panel(), (...result) => { b.push(result) })
  await tick()
  assert.equal(calls, 1)
  gate.resolve({ delay: 123 })
  await Promise.all([first, second])
  assert.deepEqual(a, [['shared', 123]])
  assert.deepEqual(b, [['shared', 123]])
  await tester.testGroup('a', [shared], panel(), () => {})
  assert.equal(calls, 2, 'A completed measurement must not suppress a later manual test')
})

test('provider, endpoint and timeout differences do not reuse another measurement', async () => {
  let calls = 0
  const gate = deferred<{ delay: number }>()
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { calls++; return gate.promise },
  })
  const jobs = [
    tester.testGroup('a', [target('same', 'one')], panel(), () => {}),
    tester.testGroup('b', [target('same', 'two')], panel(), () => {}),
    tester.testGroup('c', [target('same', 'one')], panel({ url: 'https://different.test/' }), () => {}),
    tester.testGroup('d', [target('same', 'one')], panel({ timeout: 1234 }), () => {}),
  ]
  await tick()
  assert.equal(calls, 4)
  gate.resolve({ delay: 100 })
  await Promise.all(jobs)
})

test('an empty group completes without requesting a node or reporting an error', async () => {
  const tester = createDelayTester({
    async groupDelay() { return {} },
    async proxyDelay() { assert.fail('Empty group has no nodes') },
  })
  await tester.testGroup('empty', [], panel(), () => assert.fail('No node result'))
})

test('standalone IPv6 probes use provider-aware requests and a fixed two-second timeout', async () => {
  const calls: { target: DelayTarget; url: string; timeout: number }[] = []
  const results: Record<string, boolean> = {}
  const tester = createDelayTester({
    async groupDelay() { assert.fail('IPv6 probing must not invoke a group latency endpoint') },
    async proxyDelay(selected, url, timeout) {
      calls.push({ target: selected, url, timeout })
      if (selected.name === 'error') throw new Error('IPv6 route unavailable')
      return { delay: selected.name === 'supported' ? 77 : 0 }
    },
  })
  await tester.testIPv6([target('supported', 'subscription'), target('zero'), target('error')], 15000, (name, supported) => { results[name] = supported })
  assert.deepEqual(results, { supported: true, zero: false, error: false })
  assert(calls.every((call) => call.url === IPV6_TEST_URL && call.timeout === 2000))
  assert.deepEqual(calls.find((call) => call.target.name === 'supported')?.target, target('supported', 'subscription'))
  calls.length = 0
  await tester.testIPv6([target('supported')], 500, () => {})
  assert.equal(calls[0].timeout, 2000)
})

test('IPv6 and regular measurements share the scheduler and only deduplicate identical URLs and timeouts', async () => {
  const gates: ReturnType<typeof deferred<{ delay: number }>>[] = []
  const calls: { url: string; timeout: number }[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(_target, url, timeout) {
      calls.push({ url, timeout })
      const gate = deferred<{ delay: number }>()
      gates.push(gate)
      return gate.promise
    },
  }, 1)
  const selected = target('shared', 'provider')
  const v6Results: boolean[] = []
  const matchingResults: number[] = []
  const customResults: number[] = []
  const jobs = [
    tester.testIPv6([selected], 15000, (_name, supported) => { v6Results.push(supported) }),
    tester.testIPv6([selected], 15000, (_name, supported) => { v6Results.push(supported) }),
    tester.testGroup('matching', [selected], panel({ url: IPV6_TEST_URL, timeout: 2000 }), (_name, delay) => { matchingResults.push(delay) }),
    tester.testGroup('custom', [selected], panel({ url: 'https://custom.test/204', timeout: 2000 }), (_name, delay) => { customResults.push(delay) }),
  ]
  await tick()
  assert.deepEqual(calls, [{ url: IPV6_TEST_URL, timeout: 2000 }])
  gates.shift()!.resolve({ delay: 41 })
  await tick()
  assert.deepEqual(calls, [{ url: IPV6_TEST_URL, timeout: 2000 }, { url: 'https://custom.test/204', timeout: 2000 }])
  assert.deepEqual(v6Results, [true, true])
  assert.deepEqual(matchingResults, [41])
  assert.deepEqual(customResults, [])
  gates.shift()!.resolve({ delay: 125 })
  await Promise.all(jobs)
  assert.deepEqual(customResults, [125])
})

test('IPv6 failures remain separate from main latency and do not fail a subsequent regular test', async () => {
  const v6Results: Record<string, boolean> = {}
  const mainResults: Record<string, number> = {}
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(_target, url) {
      if (url === IPV6_TEST_URL) throw new Error('No IPv6 connectivity')
      return { delay: 91 }
    },
  })
  await tester.testIPv6([target('a'), target('b')], 15000, (name, supported) => { v6Results[name] = supported })
  assert.deepEqual(v6Results, { a: false, b: false })
  await tester.testGroup('group', [target('a'), target('b')], panel(), (name, delay) => { mainResults[name] = delay })
  assert.deepEqual(mainResults, { a: 91, b: 91 })
})

test('a single ping probes the resolved provider leaf at 2000ms before its named main request', async () => {
  const calls: unknown[][] = []
  const statuses: unknown[] = []
  const main = target('named selector')
  const leaf = target('selected leaf', 'subscription / one')
  const preferences = settings({ ipv6: true, timeout: 500, independent: true })
  const tester = createDelayTester({
    async groupDelay() { assert.fail('A single ping must not use the group endpoint') },
    async proxyDelay(selected, url, timeout) {
      calls.push([selected, url, timeout])
      if (url === IPV6_TEST_URL) throw new Error('No IPv6 route')
      assert.deepEqual(statuses, [[leaf.name, false]], 'The optional result reaches the UI before the main response')
      return { delay: 73 }
    },
  })
  assert.deepEqual(await tester.testNode(main, preferences, (...result) => { statuses.push(result) }, leaf), { delay: 73 })
  assert.deepEqual(calls, [[leaf, IPV6_TEST_URL, 2000], [main, preferences.url, 500]])
})

test('a concurrency slot covers IPv6 and main so queued nodes cannot split one pipeline', async () => {
  const calls: string[] = []
  const gates = new Map<string, ReturnType<typeof deferred<{ delay: number }>>>()
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, url) {
      const key = `${selected.name}:${url === IPV6_TEST_URL ? 'ipv6' : 'main'}`
      calls.push(key)
      const gate = deferred<{ delay: number }>()
      gates.set(key, gate)
      return gate.promise
    },
  }, 2)
  const job = tester.testNodes(['a', 'b', 'c'].map(name => target(name)), settings({ ipv6: true }), () => {})
  await tick()
  assert.deepEqual(calls, ['a:ipv6', 'b:ipv6'])
  gates.get('a:ipv6')!.resolve({ delay: 1 })
  await tick()
  assert.deepEqual(calls, ['a:ipv6', 'b:ipv6', 'a:main'], 'The first main test starts while another IPv6 probe is still pending')
  gates.get('a:main')!.resolve({ delay: 40 })
  await tick()
  assert.deepEqual(calls, ['a:ipv6', 'b:ipv6', 'a:main', 'c:ipv6'], 'The third node only starts after a full slot is released')
  gates.get('b:ipv6')!.resolve({ delay: 1 })
  gates.get('c:ipv6')!.resolve({ delay: 1 })
  await tick()
  gates.get('b:main')!.resolve({ delay: 50 })
  gates.get('c:main')!.resolve({ delay: 60 })
  await job
})

test('pipeline dedup includes the IPv6 target and notifies every shared consumer', async () => {
  const calls: string[] = []
  const gates = new Map<string, ReturnType<typeof deferred<{ delay: number }>>>()
  const statuses: string[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, url) {
      calls.push(`${selected.provider ?? ''}/${selected.name}:${url === IPV6_TEST_URL ? 'ipv6' : 'main'}`)
      if (url !== IPV6_TEST_URL) return { delay: 52 }
      const gate = deferred<{ delay: number }>()
      gates.set(selected.provider!, gate)
      return gate.promise
    },
  })
  const preferences = panel({ ipv6: true })
  const a = { ...target('same main'), ipv6Target: target('same leaf', 'provider-a') }
  const b = { ...target('same main'), ipv6Target: target('same leaf', 'provider-b') }
  const jobs = [
    tester.testNode(a, preferences, () => { statuses.push('a') }),
    tester.testNode(a, preferences, () => { statuses.push('shared a') }),
    tester.testNode(b, preferences, () => { statuses.push('b') }),
  ]
  await tick()
  assert.deepEqual(calls, ['provider-a/same leaf:ipv6', 'provider-b/same leaf:ipv6'])
  gates.get('provider-a')!.resolve({ delay: 1 })
  gates.get('provider-b')!.resolve({ delay: 1 })
  assert.deepEqual(await Promise.all(jobs), [{ delay: 52 }, { delay: 52 }, { delay: 52 }])
  assert.deepEqual(statuses.sort(), ['a', 'b', 'shared a'])
  assert.equal(calls.filter(call => call.endsWith(':main')).length, 2, 'Different probe identities cannot share a complete pipeline')
})

test('bulk node testing caps only the main timeout and keeps provider-aware IPv6 at 2000ms', async () => {
  const calls: unknown[][] = []
  const statuses: unknown[] = []
  const results: unknown[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Shared Test all uses node endpoints even when saved mode is core') },
    async proxyDelay(selected, url, timeout) { calls.push([selected, url, timeout]); return { delay: 41 } },
  })
  const selected = { ...target('main'), ipv6Target: target('leaf', 'provider') }
  for (const timeout of [500, 15000]) {
    calls.length = 0
    await tester.testNodes([selected], settings({ timeout, ipv6: true }), (...result) => { results.push(result) }, (...result) => { statuses.push(result) })
    assert.deepEqual(calls, [[target('leaf', 'provider'), IPV6_TEST_URL, 2000], [target('main'), DEFAULT_DELAY_SETTINGS.url, Math.min(2000, timeout)]])
  }
  assert.deepEqual(statuses, [['leaf', true], ['leaf', true]])
  assert.deepEqual(results, [['main', 41], ['main', 41]])
})

test('core IPv6 uses the group endpoint before the main request and reports each member', async () => {
  const calls: unknown[][] = []
  const statuses: unknown[] = []
  const results: unknown[] = []
  const preferences = delayGroupSettings({ ...node(), type: 'URLTest' }, panel({ timeout: 1234, ipv6: true }))
  const tester = createDelayTester({
    async groupDelay(group, url, timeout, signal) {
      calls.push([group, url, timeout])
      assert(signal instanceof AbortSignal)
      if (url === IPV6_TEST_URL) return { a: 21, b: 0 }
      assert.deepEqual(statuses, [['a', true], ['b', false], ['missing', false]])
      return { a: 72, b: -1 }
    },
    async proxyDelay() { assert.fail('A core group cannot issue individual IPv6 or main requests') },
  })
  await tester.testGroup('automatic', ['a', 'b', 'missing'].map(name => target(name)), preferences,
    (...result) => { results.push(result) }, (...result) => { statuses.push(result) })
  assert.deepEqual(calls, [['automatic', IPV6_TEST_URL, 5000], ['automatic', preferences.url, 5000]])
  assert.deepEqual(results, [['a', 72], ['b', 0], ['missing', 0]])
})

test('failed core IPv6 reports false without preventing the main group measurement', async () => {
  const statuses: unknown[] = []
  const results: unknown[] = []
  const tester = createDelayTester({
    async groupDelay(_group, url) {
      if (url === IPV6_TEST_URL) throw new Error('No IPv6 route')
      return { node: 48 }
    },
    async proxyDelay() { assert.fail('Unexpected node request') },
  })
  await tester.testGroup('core', [target('node')], settings({ ipv6: true }),
    (...result) => { results.push(result) }, (...result) => { statuses.push(result) })
  assert.deepEqual(statuses, [['node', false]])
  assert.deepEqual(results, [['node', 48]])
})

test('disposal during node IPv6 rejects queued work and prevents main requests and late callbacks', async () => {
  const gate = deferred<{ delay: number }>()
  const calls: string[] = []
  let signal: AbortSignal | undefined
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, url, _timeout, requestSignal) {
      assert.equal(url, IPV6_TEST_URL, 'A disposed IPv6 pipeline cannot start its main request')
      calls.push(selected.name)
      signal = requestSignal
      return gate.promise
    },
  }, 1)
  const jobs = Promise.allSettled(['active', 'queued'].map(name =>
    tester.testNode(target(name), settings({ ipv6: true }), () => assert.fail('No late IPv6 callback'))))
  await tick()
  tester.dispose()
  assert.equal(signal?.aborted, true)
  gate.resolve({ delay: 30 })
  assert((await jobs).every(result => result.status === 'rejected'))
  assert.deepEqual(calls, ['active'])
})

test('disposal during core IPv6 ignores its late result and never starts the main group request', async () => {
  const gate = deferred<Record<string, number>>()
  let calls = 0
  const tester = createDelayTester({
    async groupDelay(_group, url) { calls++; assert.equal(url, IPV6_TEST_URL); return gate.promise },
    async proxyDelay() { assert.fail('Unexpected node request') },
  })
  const job = tester.testGroup('core', [target('node')], settings({ ipv6: true }),
    () => assert.fail('No late main result'), () => assert.fail('No late probe result'))
  tester.dispose()
  gate.resolve({ node: 28 })
  await job
  assert.equal(calls, 1)
})

test('campaigns reuse the complete probe/main pipeline while replaying status to each consumer', async () => {
  const calls: string[] = []
  const statuses: unknown[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(_target, url) { calls.push(url); return { delay: 31 } },
  })
  const preferences = panel({ ipv6: true })
  const finish = tester.beginBatch()
  for (let index = 0; index < 2; index++) {
    await tester.testNode(target('node'), preferences, (...result) => { statuses.push(result) })
  }
  assert.deepEqual(calls, [IPV6_TEST_URL, preferences.url])
  assert.deepEqual(statuses, [['node', true], ['node', true]])
  finish()
  await tester.testNode(target('node'), preferences)
  assert.deepEqual(calls, [IPV6_TEST_URL, preferences.url, IPV6_TEST_URL, preferences.url])
})

test('disposing panel tests aborts active requests and prevents queued nodes and late callbacks', async () => {
  const calls: string[] = []
  const signals: AbortSignal[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, _url, _timeout, signal) {
      calls.push(selected.name)
      assert(signal instanceof AbortSignal)
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })
      })
    },
  }, 1)
  const job = tester.testGroup('group', [target('active'), target('queued-a'), target('queued-b')], panel(), () => assert.fail('Disposed page must not receive results'))
  const stopped = assert.rejects(job)
  await tick()
  assert.deepEqual(calls, ['active'])
  assert.equal(signals[0].aborted, false)
  tester.dispose()
  await stopped
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(calls, ['active'])
  await assert.rejects(tester.testGroup('later', [target('new')], panel(), () => assert.fail('Disposed tester cannot report results')))
  assert.deepEqual(calls, ['active'])
})

test('disposing core tests aborts its request and ignores a late successful response', async () => {
  const gate = deferred<Record<string, number>>()
  let signal: AbortSignal | undefined
  const tester = createDelayTester({
    async groupDelay(_group, _url, _timeout, requestSignal) {
      signal = requestSignal
      return gate.promise
    },
    async proxyDelay() { assert.fail('Unexpected per-node request') },
  })
  const job = tester.testGroup('group', [target('node')], settings(), () => assert.fail('Disposed page must ignore late results'))
  assert(signal instanceof AbortSignal)
  assert.equal(signal.aborted, false)
  tester.dispose()
  assert.equal(signal.aborted, true)
  gate.resolve({ node: 50 })
  await job
})

test('leaving immediately after starting a panel test sends no node requests', async () => {
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { assert.fail('Cancelled before the request started') },
  })
  const job = tester.testGroup('group', [target('first'), target('second')], panel(), () => assert.fail('No late result'))
  const stopped = assert.rejects(job)
  tester.dispose()
  await stopped
})

test('single-node tests use the provider endpoint and current settings even in core mode', async () => {
  const calls: unknown[][] = []
  const selected = target('node / east', 'subscription / one')
  const prefs = settings({ url: 'https://single.test/check', timeout: 12345 })
  const tester = createDelayTester({
    async groupDelay() { assert.fail('A ping click must not test an entire group') },
    async proxyDelay(...args) { calls.push(args); return { delay: 47 } },
  })
  assert.deepEqual(await tester.testNode(selected, prefs), { delay: 47 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 3), [selected, prefs.url, prefs.timeout])
  assert(calls[0][3] instanceof AbortSignal)
  assert.equal(calls[0][3].aborted, false)
})

test('single-node tests normalize failed values without hiding request errors or caching retries', async () => {
  const values = [0, -5, NaN, Infinity, -Infinity, 37]
  const failure = new Error('Node endpoint unavailable')
  let calls = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() {
      const index = calls++
      if (index === values.length) throw failure
      return { delay: values[index] ?? 51 }
    },
  })
  for (const value of values) {
    assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: Number.isFinite(value) && value > 0 ? value : 0 })
  }
  await assert.rejects(tester.testNode(target('node'), settings()), (error) => error === failure)
  assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: 51 })
  assert.equal(calls, values.length + 2)
})

test('a single-node test and an overlapping panel group share one in-flight request', async () => {
  const gate = deferred<{ delay: number }>()
  const results: unknown[] = []
  let calls = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { calls++; return gate.promise },
  })
  const selected = target('shared', 'provider')
  const single = tester.testNode(selected, settings())
  const group = tester.testGroup('group', [selected], panel(), (...result) => { results.push(result) })
  await tick()
  assert.equal(calls, 1, 'Orchestration mode must not prevent sharing the same node/URL measurement')
  gate.resolve({ delay: 63 })
  assert.deepEqual(await single, { delay: 63 })
  await group
  assert.deepEqual(results, [['shared', 63]])
})

test('single-node tests share the concurrency limit with group tests', async () => {
  const gates: ReturnType<typeof deferred<{ delay: number }>>[] = []
  const calls: string[] = []
  const results: string[] = []
  let active = 0
  let maximum = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected) {
      calls.push(selected.name)
      active++
      maximum = Math.max(maximum, active)
      const gate = deferred<{ delay: number }>()
      gates.push(gate)
      try { return await gate.promise } finally { active-- }
    },
  }, 2)
  const jobs = [
    tester.testNode(target('single-a'), settings()),
    tester.testNode(target('single-b'), settings()),
    tester.testGroup('group', [target('group-a'), target('group-b')], panel(), (name) => { results.push(name) }),
  ]
  await tick()
  assert.deepEqual(calls, ['single-a', 'single-b'])
  assert.equal(active, 2)
  while (gates.length) {
    gates.shift()!.resolve({ delay: 50 })
    await tick()
  }
  await Promise.all(jobs)
  assert.equal(maximum, 2)
  assert.equal(active, 0)
  assert.deepEqual(calls, ['single-a', 'single-b', 'group-a', 'group-b'])
  assert.deepEqual(results, ['group-a', 'group-b'])
})

test('disposing single-node tests aborts active requests, rejects queued tests and blocks future calls', async () => {
  const calls: string[] = []
  let requestSignal: AbortSignal | undefined
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, _url, _timeout, signal) {
      calls.push(selected.name)
      assert(signal instanceof AbortSignal)
      requestSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true })
      })
    },
  }, 1)
  const jobs = Promise.allSettled([
    tester.testNode(target('active'), settings()),
    tester.testNode(target('queued'), settings()),
  ])
  await tick()
  assert.deepEqual(calls, ['active'])
  assert.equal(requestSignal?.aborted, false)
  tester.dispose()
  assert((await jobs).every((result) => result.status === 'rejected'))
  assert.equal(requestSignal?.aborted, true)
  assert.deepEqual(calls, ['active'])
  await assert.rejects(tester.testNode(target('future'), settings()), /cancelled/)
  assert.deepEqual(calls, ['active'])
})

test('a late single-node response cannot succeed after the tester is disposed', async () => {
  const gate = deferred<{ delay: number }>()
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { return gate.promise },
  })
  const job = tester.testNode(target('node'), settings())
  const stopped = assert.rejects(job, /cancelled/)
  await tick()
  tester.dispose()
  gate.resolve({ delay: 25 })
  await stopped
})

test('a batch reuses settled node results across sequential overlapping groups and ends with a real retest', async () => {
  const calls: string[] = []
  const results: unknown[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected) { calls.push(selected.name); return { delay: calls.length * 10 } },
  })
  const finish = tester.beginBatch()
  await tester.testGroup('first', [target('first'), target('shared', 'subscription')], panel(), (...result) => { results.push(result) })
  await tester.testGroup('second', [target('shared', 'subscription'), target('second')], panel(), (...result) => { results.push(result) })
  assert.deepEqual(calls, ['first', 'shared', 'second'])
  assert.deepEqual(results, [['first', 10], ['shared', 20], ['shared', 20], ['second', 30]])
  assert.deepEqual(await tester.testNode(target('shared', 'subscription'), settings()), { delay: 20 })
  assert.equal(calls.length, 3, 'Single-node access uses the same active campaign')
  finish()
  assert.deepEqual(await tester.testNode(target('shared', 'subscription'), settings()), { delay: 40 })
  assert.equal(calls.length, 4, 'Campaign results must not suppress a later ping click')
})

test('batch results remain isolated by provider, URL and timeout', async () => {
  let calls = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { return { delay: ++calls } },
  })
  const finish = tester.beginBatch()
  assert.deepEqual(await tester.testNode(target('same', 'one'), panel()), { delay: 1 })
  assert.deepEqual(await tester.testNode(target('same', 'two'), panel()), { delay: 2 })
  assert.deepEqual(await tester.testNode(target('same', 'one'), panel({ url: 'https://other.test/check' })), { delay: 3 })
  assert.deepEqual(await tester.testNode(target('same', 'one'), panel({ timeout: 1234 })), { delay: 4 })
  assert.deepEqual(await tester.testNode(target('same', 'one'), settings()), { delay: 1 }, 'Orchestration mode is not part of a per-node request')
  assert.equal(calls, 4)
  finish()
})

test('failed probes are reused only within the campaign and are retried after cleanup', async () => {
  const failure = new Error('Unavailable during campaign')
  const results: unknown[] = []
  let calls = 0
  let failing = true
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { calls++; if (failing) throw failure; return { delay: 55 } },
  })
  const finish = tester.beginBatch()
  await assert.rejects(tester.testNode(target('shared'), settings()), (error) => error === failure)
  await assert.rejects(tester.testGroup('group', [target('shared')], panel(), (...result) => { results.push(result) }), (error) => error === failure)
  assert.equal(calls, 1)
  assert.deepEqual(results, [['shared', 0]])
  finish()
  failing = false
  assert.deepEqual(await tester.testNode(target('shared'), settings()), { delay: 55 })
  assert.equal(calls, 2)
})

test('cleanup from an older campaign cannot clear the current campaign cache', async () => {
  let calls = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { return { delay: ++calls } },
  })
  const old = tester.beginBatch()
  assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: 1 })
  const current = tester.beginBatch()
  assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: 2 })
  old()
  assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: 2 })
  current()
  current()
  assert.deepEqual(await tester.testNode(target('node'), settings()), { delay: 3 })
  assert.equal(calls, 3)
})

test('campaigns cache IPv6 probes while leaving core group requests uncached', async () => {
  let groups = 0
  const calls: { target: DelayTarget; url: string; timeout: number }[] = []
  const tester = createDelayTester({
    async groupDelay() { groups++; return { node: 66 } },
    async proxyDelay(selected, url, timeout) { calls.push({ target: selected, url, timeout }); return { delay: 88 } },
  })
  const finish = tester.beginBatch()
  await tester.testGroup('group', [target('node')], settings(), () => {})
  await tester.testGroup('group', [target('node')], settings(), () => {})
  assert.equal(groups, 2, 'Core mode keeps its original group endpoint semantics')
  const statuses: unknown[] = []
  for (let index = 0; index < 2; index++) {
    await tester.testIPv6([target('node', 'subscription')], 15000, (...result) => { statuses.push(result) })
  }
  assert.deepEqual(calls, [{ target: target('node', 'subscription'), url: IPV6_TEST_URL, timeout: 2000 }])
  assert.deepEqual(statuses, [['node', true], ['node', true]])
  finish()
  await tester.testIPv6([target('node', 'subscription')], 15000, () => {})
  assert.equal(calls.length, 2)
})

test('a batch retains an already pending probe after it settles', async () => {
  const gate = deferred<{ delay: number }>()
  let calls = 0
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay() { calls++; return gate.promise },
  })
  const before = tester.testNode(target('shared'), settings())
  const finish = tester.beginBatch()
  const during = tester.testNode(target('shared'), settings())
  await tick()
  assert.equal(calls, 1)
  gate.resolve({ delay: 77 })
  await Promise.all([before, during])
  assert.deepEqual(await tester.testNode(target('shared'), settings()), { delay: 77 })
  assert.equal(calls, 1)
  finish()
})

test('disposing an active campaign rejects queued work and cannot serve cached results', async () => {
  const calls: string[] = []
  const tester = createDelayTester({
    async groupDelay() { assert.fail('Unexpected group request') },
    async proxyDelay(selected, _url, _timeout, signal) {
      calls.push(selected.name)
      if (selected.name === 'cached') return { delay: 43 }
      assert(signal instanceof AbortSignal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      })
    },
  }, 1)
  const finish = tester.beginBatch()
  assert.deepEqual(await tester.testNode(target('cached'), settings()), { delay: 43 })
  const jobs = Promise.allSettled([
    tester.testNode(target('active'), settings()),
    tester.testNode(target('queued'), settings()),
  ])
  await tick()
  assert.deepEqual(calls, ['cached', 'active'])
  tester.dispose()
  assert((await jobs).every((result) => result.status === 'rejected'))
  finish()
  const afterDispose = tester.beginBatch()
  await assert.rejects(tester.testNode(target('cached'), settings()), /cancelled/)
  afterDispose()
  assert.deepEqual(calls, ['cached', 'active'])
})
