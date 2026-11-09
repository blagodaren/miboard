import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runStabilitySeries, summarizeStability, STABILITY_ATTEMPTS, type StabilitySample } from '../src/lib/stability.ts'

const samples = (...values: Array<number | null>): StabilitySample[] => values.map((delay, index) => ({ attempt: index + 1, delay }))

test('stability statistics count failed checks without including them in latency percentiles', () => {
  assert.deepEqual(summarizeStability(samples(70, null, 10, 40, 20, 50, 60, 80, 30, null)), {
    completed: 10, successful: 8, failed: 2, median: 45, p95: 80, min: 10, max: 80,
  })
  assert.deepEqual(summarizeStability(samples(null, 0, -1, Infinity, NaN)), {
    completed: 5, successful: 0, failed: 5, median: null, p95: null, min: null, max: null,
  })
  assert.equal(summarizeStability(samples(12, 3, 8)).median, 8)
  assert.equal(summarizeStability([]).median, null)
})

test('a manual series performs exactly ten sequential HTTP calls and retains URL/timeout/target snapshot', async () => {
  let active = 0
  let maximum = 0
  let calls = 0
  const target = { name: 'node / one', provider: 'provider ? one' }
  const preferences = { url: 'https://example.org/check', timeout: 7123 }
  const progress: readonly StabilitySample[][] = []
  const controller = new AbortController()
  const result = await runStabilitySeries(target, preferences, async (endpoint, url, timeout, signal) => {
    calls++
    active++
    maximum = Math.max(maximum, active)
    assert.deepEqual(endpoint, { name: 'node / one', provider: 'provider ? one' })
    assert.equal(url, 'https://example.org/check')
    assert.equal(timeout, 7123)
    assert.equal(signal, controller.signal)
    target.name = 'later target'
    preferences.url = 'https://example.org/later'
    preferences.timeout = 99
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
    if (calls === 3) throw new Error('HTTP 504')
    return { delay: calls === 7 ? 0 : calls * 10 }
  }, controller.signal, (value) => { (progress as StabilitySample[][]).push([...value]) })
  assert.equal(calls, STABILITY_ATTEMPTS)
  assert.equal(maximum, 1)
  assert.equal(result.cancelled, false)
  assert.equal(summarizeStability(result.samples).failed, 2)
  assert.deepEqual(progress.map((value) => value.length), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.equal(progress[0].length, 1, 'Earlier progress snapshots are immutable')
})

test('cancel aborts the in-flight check, excludes it from failures, and never starts another', async () => {
  const controller = new AbortController()
  let calls = 0
  let progress = 0
  const result = await runStabilitySeries({ name: 'node' }, { url: 'https://example.org', timeout: 5000 }, async (_target, _url, _timeout, signal) => {
    calls++
    if (calls === 1) return { delay: 22 }
    return await new Promise<{ delay: number }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
      controller.abort()
    })
  }, controller.signal, () => { progress++ })
  assert.equal(calls, 2)
  assert.equal(progress, 1)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.samples, [{ attempt: 1, delay: 22 }])
  assert.equal(summarizeStability(result.samples).failed, 0)
})

test('late success after cancellation is ignored, including a signal already aborted before launch', async () => {
  const controller = new AbortController()
  let calls = 0
  const result = await runStabilitySeries({ name: 'node' }, { url: 'https://example.org', timeout: 5000 }, async () => {
    calls++
    controller.abort()
    return { delay: 90 }
  }, controller.signal, () => assert.fail('No cancelled sample is published'))
  assert.deepEqual(result, { samples: [], cancelled: true })
  await runStabilitySeries({ name: 'node' }, { url: 'https://example.org', timeout: 5000 }, async () => {
    calls++
    return { delay: 90 }
  }, controller.signal, () => assert.fail('No work after abort'))
  assert.equal(calls, 1)
})
