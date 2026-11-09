import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerSubscription, providerUpdatedAt, visibleProxyProviders, updateProxyProvider, ProviderRefreshError } from '../src/lib/provider-tools.ts'

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
