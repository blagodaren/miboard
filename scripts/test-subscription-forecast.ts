import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendSubscriptionSample, subscriptionForecast, subscriptionSample, FORECAST_DAY, FORECAST_STALE, FORECAST_POINTS, SubscriptionForecastStore } from '../src/lib/subscription-forecast.ts'
import type { SubscriptionSample } from '../src/lib/subscription-forecast.ts'
const now = Date.UTC(2026, 10, 13)
const sample = (at: number, used: number, total = 1000, expiresAt: number | null = null): SubscriptionSample => ({ at, used, total, expiresAt })
test('cached polls do not add samples or refresh stale provider data', () => {
  const first = sample(now, 100)
  assert.deepEqual(appendSubscriptionSample([first], { ...first, used: 200 }), [first])
  assert.equal(subscriptionForecast([first], now + FORECAST_STALE + 1).state, 'stale')
  assert.equal(subscriptionForecast([first], now).state, 'learning')
  assert.equal(subscriptionForecast([first, sample(now + 1000, 101)], now + 1000).state, 'learning')
})
test('quota depletion projects from update time; expiry can be the earlier limit', () => {
  const samples = [sample(now - FORECAST_DAY, 100), sample(now, 200)]
  const result = subscriptionForecast(samples, now + FORECAST_DAY)
  assert.equal(result.bytesPerDay, 100); assert.equal(result.quotaDays, 7); assert.equal(result.daysLeft, 7)
  const limited = subscriptionForecast(samples.map(s => ({ ...s, expiresAt: now + 2 * FORECAST_DAY })), now)
  assert.equal(limited.daysLeft, 2); assert.equal(limited.limitedByExpiry, true)
})
test('renewal, new quota or expiry resets history; zero rate, expiry and exhaustion remain distinct', () => {
  const previous = [sample(now - FORECAST_DAY, 100), sample(now, 200)]
  assert.equal(appendSubscriptionSample(previous, sample(now + 1000, 0)).length, 1)
  assert.equal(appendSubscriptionSample(previous, sample(now + 1000, 200, 2000)).length, 1)
  assert.equal(appendSubscriptionSample(previous, sample(now + 1000, 200, 1000, now + FORECAST_DAY)).length, 1)
  assert.equal(subscriptionForecast([sample(now - FORECAST_DAY, 100), sample(now, 100)], now).state, 'noRate')
  assert.equal(subscriptionForecast([sample(now, 1000)], now).state, 'exhausted')
  assert.equal(subscriptionForecast([sample(now, 100, 1000, now)], now).state, 'expired')
})
test('forecast rejects missing counters and false timestamps and bounds retained samples', () => {
  assert.equal(subscriptionSample({ updatedAt: 'yesterday', subscriptionInfo: { Download: 1, Upload: 0, Total: 100 } }, now), null)
  assert.equal(subscriptionSample({ updatedAt: new Date(now).toISOString(), subscriptionInfo: { Download: 1, Total: 100 } }, now), null)
  assert.equal(subscriptionSample({ updatedAt: new Date(now + FORECAST_DAY).toISOString(), subscriptionInfo: { Download: 1, Upload: 0, Total: 100 } }, now), null)
  let points: SubscriptionSample[] = []
  for (let i = 0; i < 100; i++) points = appendSubscriptionSample(points, sample(now + i * 1000, i))
  assert.equal(points.length, FORECAST_POINTS)
})
test('samples survive reloads per controller and missing storage is reported', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const provider = (at: number, used: number) => ({ updatedAt: new Date(at).toISOString(), subscriptionInfo: { Download: used, Upload: 0, Total: 1000 } })
  const store = new SubscriptionForecastStore(storage)
  store.inspect('one', 'Main', provider(now - FORECAST_DAY, 100), now)
  const fresh = new SubscriptionForecastStore(storage)
  assert.equal(fresh.inspect('one', 'Main', provider(now, 200), now).state, 'ready')
  assert.equal(fresh.inspect('two', 'Main', provider(now, 200), now).state, 'learning')
  const unavailable = new SubscriptionForecastStore()
  unavailable.inspect('one', 'Main', provider(now, 200), now)
  assert.equal(unavailable.memoryOnly, true)
})
