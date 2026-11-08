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
  proxyDelayValue,
  readDelaySettings,
  saveDelaySettings,
  resolveProxyLeaf,
  validDelaySettings,
} from '../src/lib/latency.ts'
import type { DelayClient, DelaySettings, DelayTarget } from '../src/lib/latency.ts'

const settings = (patch: Partial<DelaySettings> = {}): DelaySettings => ({ ...DEFAULT_DELAY_SETTINGS, ...patch })
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
  assert.deepEqual(delayHistorySample('group', url, false, metadata), history(21, 22)[1])
  assert.deepEqual(delayHistorySample('group', url, true, metadata), history(81, 82)[1])
  assert.deepEqual(delayHistorySample('leaf', url, true, metadata), history(11, 12)[1])
  assert.equal(delayHistorySample('group', 'https://untested.test/', true, metadata), undefined)
  assert.equal(delayHistorySample('missing', url, false, metadata), undefined)
  delete group.extra
  assert.deepEqual(delayHistorySample('group', url, true, metadata), history(21, 22)[1], 'Old cores fall back to the resolved leaf history')
  group.extra = {}
  assert.equal(delayHistorySample('group', url, true, metadata), undefined, 'Known URL histories must not fall back to unrelated measurements')
  leaf.history = history(22, 0)
  assert.deepEqual(delayHistorySample('group', url, false, metadata), history(22, 0)[1], 'Unreachable latest results stay visible')
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

test('IPv6 probes use individual provider-aware requests and cap their timeout at two seconds', async () => {
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
  assert.equal(calls[0].timeout, 500)
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
