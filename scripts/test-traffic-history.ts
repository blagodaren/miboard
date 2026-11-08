import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TrafficHistory, TRAFFIC_HISTORY_LIMIT, TRAFFIC_HISTORY_SECONDS } from '../src/lib/traffic-history.ts'

test('first observation is not fabricated traffic; irregular intervals integrate real elapsed time', () => {
  const history = new TrafficHistory()
  assert.deepEqual(history.snapshot(1800), { t: [], down: [], up: [], download: 0, upload: 0, startedAt: null })
  history.append(100, 1000, 100)
  assert.equal(history.snapshot(1800).download, 0)
  history.append(101.5, 2000, 200)
  history.append(104, 3000, 300)
  const snapshot = history.snapshot(1800)
  assert.equal(snapshot.download, 10_500)
  assert.equal(snapshot.upload, 1050)
  assert.equal(snapshot.startedAt, 100)
  assert.deepEqual(snapshot.t, [104])
  assert.deepEqual(snapshot.down, [2625])
})

test('range boundaries clip intervals exactly and long views aggregate without changing byte totals', () => {
  const history = new TrafficHistory()
  for (let time = 0; time <= 7200; time++) history.append(time, 100, 10)
  for (const range of [1800, 3600, 86400]) {
    const snapshot = history.snapshot(range)
    assert.equal(snapshot.download, Math.min(range, 7200) * 100)
    assert.equal(snapshot.upload, Math.min(range, 7200) * 10)
    assert(snapshot.t.every((time, index) => index === 0 || time > snapshot.t[index - 1]))
  }
  const clipped = history.snapshot(2.5)
  assert.equal(clipped.download, 250)
  assert.equal(clipped.startedAt, 7197.5)
  assert(history.snapshot(86400).t.length < history.snapshot(3600).t.length)
})

test('disconnected gaps do not add traffic and produce a break instead of zero observations', () => {
  const history = new TrafficHistory()
  history.append(100, 1000, 100)
  history.append(101, 1000, 100)
  history.append(160, 9000, 900)
  history.append(161, 2000, 200)
  assert.equal(history.snapshot(1800).download, 3000)
  assert(history.snapshot(1800).down.includes(null))
  history.pause()
  history.append(163, 9000, 900)
  assert.equal(history.snapshot(1800).download, 3000)
  history.append(164, 1000, 100)
  assert.equal(history.snapshot(1800).download, 4000)
})

test('duplicate/backward timestamps and invalid rates cannot inflate or corrupt history', () => {
  const history = new TrafficHistory()
  history.append(10, 10, 10)
  history.append(10, 1000, 1000)
  history.append(9, 1000, 1000)
  history.append(Number.NaN, 1000, 1000)
  history.append(11, Number.NaN, -100)
  history.append(12, Number.POSITIVE_INFINITY, 20)
  assert.equal(history.size, 3)
  assert.equal(history.snapshot(1800).download, 0)
  assert.equal(history.snapshot(1800).upload, 20)
  assert(history.snapshot(1800).down.every((value) => value === null || Number.isFinite(value)))
})

test('retention is bounded by 24 hours and by count even if a controller floods samples', () => {
  const history = new TrafficHistory()
  for (let time = 0; time <= TRAFFIC_HISTORY_SECONDS * 2; time++) history.append(time, 100, 10)
  assert(history.size <= TRAFFIC_HISTORY_LIMIT)
  assert.equal(history.snapshot(86400).download, TRAFFIC_HISTORY_SECONDS * 100)
  assert.equal(history.snapshot(86400).t.length, 1440)
  const flood = new TrafficHistory()
  for (let index = 0; index < TRAFFIC_HISTORY_LIMIT + 2000; index++) flood.append(index / 100, 1, 1)
  assert.equal(flood.size, TRAFFIC_HISTORY_LIMIT)
})

test('reset removes previous controller data; stale snapshots do not invent current traffic', () => {
  const history = new TrafficHistory()
  history.append(10, 100, 100)
  history.append(11, 100, 100)
  assert.equal(history.snapshot(1800, 10000).startedAt, null)
  history.reset()
  assert.equal(history.size, 0)
  assert.deepEqual(history.snapshot(1800), { t: [], down: [], up: [], download: 0, upload: 0, startedAt: null })
  history.append(1000, 5000, 5000)
  assert.equal(history.snapshot(1800).download, 0)
})
