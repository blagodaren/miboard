import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerSubscription, providerUpdatedAt, visibleProxyProviders, updateProxyProvider, ProviderRefreshError, providerNodeHealth, providerHealthSummary, providerQuotaStatus, healthCheckProxyProvider, ProviderHealthRefreshError } from '../src/lib/provider-tools.ts'
import type { Proxy } from '../src/lib/api.ts'

test('providers omit built-in default/Compatible entries and use API map keys as identities', () => {
  assert.deepEqual(visibleProxyProviders({ default: {}, compatible: { vehicleType: 'Compatible' }, 'actual / key': { name: 'display name', vehicleType: 'HTTP' } }).map((row) => row.name), ['actual / key'])
})

test('subscription amounts never invent missing fields, quota or expiry', () => {
  assert.equal(providerSubscription(undefined), null)
  assert.equal(providerSubscription({}), null)
  assert.deepEqual(providerSubscription({ Download: 50 }), { download: 50, upload: null, used: null, total: null, remaining: null, expiresAt: null })
  assert.deepEqual(providerSubscription({ Download: 50, Upload: 10, Total: 100, Expire: 1800000000 }), {
    download: 50, upload: 10, used: 60, total: 100, remaining: 40, expiresAt: 1800000000000,
  })
  assert.equal(providerSubscription({ Download: 150, Upload: 0, Total: 100 })?.remaining, 0)
  assert.equal(providerSubscription({ Download: 50, Upload: 10, Total: 0, Expire: 0 })?.remaining, null)
  assert.equal(providerSubscription({ Total: 100 })?.remaining, null)
  assert.equal(providerSubscription({ Download: -1, Upload: NaN, Total: Infinity, Expire: Number.MAX_VALUE }), null)
})

test('provider timestamps omit unknown and Go zero dates', () => {
  assert.equal(providerUpdatedAt(undefined), null)
  assert.equal(providerUpdatedAt('0001-01-01T00:00:00Z'), null)
  assert.equal(providerUpdatedAt('invalid'), null)
  assert.equal(providerUpdatedAt('2026-11-09T12:00:00Z'), 1794225600000)
  assert.equal(providerUpdatedAt('2026-11-09T15:00:00.123456789+03:00'), 1794225600123)
  assert.equal(providerUpdatedAt('2024-02-29T00:00:00Z'), Date.UTC(2024, 1, 29))
  for (const value of ['2026-02-29T00:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-11-09T24:00:00Z', '2026-11-09', '11/09/2026', '0', '2026-11-09T12:00:00', 1794225600000, {}, null]) assert.equal(providerUpdatedAt(value), null, JSON.stringify(value))
})

test('provider update encodes names, passes cancellation and waits for fresh metadata before success', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  let metadata = 'old'
  await updateProxyProvider('subscription / A?x=#', async (path, options) => {
    assert.equal(path, '/providers/proxies/subscription%20%2F%20A%3Fx%3D%23')
    assert.equal(options.method, 'PUT')
    assert.equal(options.signal, controller.signal)
    calls.push('put')
  }, async (signal) => {
    assert.equal(signal, controller.signal)
    calls.push('reload')
    metadata = 'new'
    return true
  }, controller.signal)
  assert.deepEqual(calls, ['put', 'reload'])
  assert.equal(metadata, 'new')
})

test('provider errors propagate and failed refresh is distinguishable from a failed update', async () => {
  const controller = new AbortController()
  await assert.rejects(updateProxyProvider('provider', async () => { throw new Error('HTTP 500') }, async () => assert.fail('Do not reload a failed update'), controller.signal), /HTTP 500/)
  await assert.rejects(updateProxyProvider('provider', async () => {}, async () => false, controller.signal), ProviderRefreshError)
})

test('provider cancellation stops follow-up metadata and supports safe retry', async () => {
  const controller = new AbortController()
  let calls = 0
  await updateProxyProvider('provider', async () => { calls++; controller.abort() }, async () => assert.fail('No reload after abort'), controller.signal)
  await updateProxyProvider('provider', async () => { calls++ }, async () => assert.fail('No work after abort'), controller.signal)
  assert.equal(calls, 1)
  const retry = new AbortController()
  await updateProxyProvider('provider', async () => { calls++ }, async () => true, retry.signal)
  assert.equal(calls, 2)
})

const node = (name: string, delay?: number, time = '2026-11-09T12:00:00Z'): Proxy => ({
  name, type: 'Vless', alive: true, history: delay === undefined ? [] : [{ time, delay }],
})
const providerUrl = 'https://check.example/generate_204'

test('provider health summaries use configured URL histories and never treat an untested alive flag as a successful check', () => {
  const measured = node('URL result', 900)
  measured.extra = { [providerUrl]: { alive: true, history: [{ time: '2026-11-09T13:00:00Z', delay: 45 }] } }
  const failed = node('URL failure', 800)
  failed.extra = { [providerUrl]: { alive: false, history: [{ time: '2026-11-09T14:00:00Z', delay: 0 }] } }
  const empty = node('No checks')
  const foreign = node('Other URL', 15)
  foreign.extra = { 'https://another.example/check': { alive: true, history: [{ time: '2026-11-09T15:00:00Z', delay: 15 }] } }
  const legacy = node('Legacy', 55)
  const summary = providerHealthSummary({ testUrl: providerUrl, proxies: [measured, failed, empty, foreign, legacy] })
  assert.deepEqual({ total: summary.total, alive: summary.alive, dead: summary.dead, unknown: summary.unknown, lastCheckedAt: summary.lastCheckedAt }, {
    total: 5, alive: 2, dead: 1, unknown: 2, lastCheckedAt: Date.parse('2026-11-09T14:00:00Z'),
  })
  assert.deepEqual(summary.nodes.map(({ status, delay, source }) => ({ status, delay, source })), [
    { status: 'alive', delay: 45, source: 'url' }, { status: 'dead', delay: 0, source: 'url' },
    { status: 'unknown', delay: null, source: 'none' }, { status: 'unknown', delay: null, source: 'none' },
    { status: 'alive', delay: 55, source: 'history' },
  ])
  assert.deepEqual(providerHealthSummary({}), { total: 0, alive: 0, dead: 0, unknown: 0, lastCheckedAt: null, nodes: [] })
})

test('provider node health keeps empty and malformed newest samples unknown without reviving stale success', () => {
  const emptyUrl = node('empty URL', 80)
  emptyUrl.extra = { [providerUrl]: { alive: true, history: [] } }
  assert.equal(providerNodeHealth(emptyUrl, providerUrl).status, 'unknown')
  for (const delay of [NaN, Infinity, -1, '20', null, undefined]) {
    const malformed = node('malformed', 50)
    malformed.history.push({ time: '2026-11-09T15:00:00Z', delay } as never)
    assert.equal(providerNodeHealth(malformed).status, 'unknown')
    assert.equal(providerNodeHealth(malformed).delay, null)
  }
  const malformedTime = providerNodeHealth(node('unknown time', 25, '2026-02-30T00:00:00Z'))
  assert.equal(malformedTime.status, 'alive')
  assert.equal(malformedTime.checkedAt, null)
  const zero = providerNodeHealth(node('failed', 0))
  assert.equal(zero.status, 'dead', 'An alive flag cannot override the latest failed record')
  assert.equal(providerNodeHealth({ ...node('missing'), history: null as never }).status, 'unknown')
  for (const type of [undefined, null, 123, {}, []]) {
    const summary = providerHealthSummary({ proxies: [{ ...node('missing protocol', 25), type } as never] })
    assert.equal(summary.nodes[0].type, '')
    assert.equal(summary.nodes[0].status, 'alive')
    assert.doesNotThrow(() => summary.nodes.map((item) => item.type).sort((a, b) => a.localeCompare(b)))
  }
})

test('quota states distinguish unknown, remaining, exhausted and expired without inventing incomplete totals', () => {
  const now = 1800000000000
  assert.deepEqual(providerQuotaStatus(undefined, now), { ratio: null, expired: null, exhausted: null })
  assert.deepEqual(providerQuotaStatus({ Total: 100 }, now), { ratio: null, expired: null, exhausted: null })
  assert.deepEqual(providerQuotaStatus({ Upload: 0, Download: 0, Total: 100, Expire: 1800000001 }, now), { ratio: 0, expired: false, exhausted: false })
  assert.deepEqual(providerQuotaStatus({ Upload: 10, Download: 40, Total: 100, Expire: 1800000000 }, now), { ratio: 0.5, expired: true, exhausted: false })
  assert.deepEqual(providerQuotaStatus({ Upload: 20, Download: 100, Total: 100, Expire: 1700000000 }, now), { ratio: 1, expired: true, exhausted: true })
  assert.deepEqual(providerQuotaStatus({ Upload: 20, Download: 100, Total: 0, Expire: 0 }, now), { ratio: null, expired: null, exhausted: null })
  assert.deepEqual(providerQuotaStatus({ Upload: Number.MAX_VALUE, Download: Number.MAX_VALUE, Total: 100, Expire: Number.MAX_VALUE }, now), { ratio: null, expired: null, exhausted: null })
  assert.deepEqual(providerQuotaStatus({ Upload: '0', Download: '100', Total: '100', Expire: '1800000000' } as never, now), { ratio: null, expired: null, exhausted: null })
  assert.equal(providerQuotaStatus({ Expire: 1800000000 }, NaN).expired, null)
  assert.equal(providerSubscription([] as never), null)
})

test('native provider health check encodes the provider as one segment and waits for its response before reloading', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  let finish!: () => void
  const response = new Promise<void>((resolve) => { finish = resolve })
  const checking = healthCheckProxyProvider('provider / A?key=#%', async (path, options) => {
    assert.equal(path, '/providers/proxies/provider%20%2F%20A%3Fkey%3D%23%25/healthcheck')
    assert.deepEqual(options, { method: 'GET', signal: controller.signal })
    calls.push('check')
    await response
  }, async (signal) => { assert.equal(signal, controller.signal); calls.push('reload'); return true }, controller.signal)
  await Promise.resolve()
  assert.deepEqual(calls, ['check'])
  finish()
  await checking
  assert.deepEqual(calls, ['check', 'reload'])
})

test('health-check failures and cancellation preserve the distinction between checking and refreshing metadata', async () => {
  const controller = new AbortController()
  await assert.rejects(healthCheckProxyProvider('provider', async () => { throw new Error('HTTP 503') }, async () => assert.fail('Failed check must not reload'), controller.signal), /HTTP 503/)
  await assert.rejects(healthCheckProxyProvider('provider', async () => {}, async () => false, controller.signal), ProviderHealthRefreshError)
  let calls = 0
  await healthCheckProxyProvider('provider', async () => { calls++; controller.abort() }, async () => assert.fail('Aborted check must not reload'), controller.signal)
  await healthCheckProxyProvider('provider', async () => { calls++ }, async () => assert.fail('Already aborted check must not start'), controller.signal)
  assert.equal(calls, 1)
  const duringRefresh = new AbortController()
  await healthCheckProxyProvider('provider', async () => {}, async () => { duringRefresh.abort(); return false }, duringRefresh.signal)
})
