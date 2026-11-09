import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendMemorySample, memoryChart, MEMORY_WINDOW_MS, visibleConfigUrl } from '../src/lib/core-status.ts'

test('memory history is bounded, replaces duplicate timestamps and rejects invalid samples', () => {
  let samples = [] as ReturnType<typeof appendMemorySample>
  for (let i = 0; i < 400; i++) samples = appendMemorySample(samples, i * 1000, i * 100)
  assert.equal(samples.length, MEMORY_WINDOW_MS / 1000)
  assert.equal(samples[0].time, 100000)
  samples = appendMemorySample(samples, 399000, 7)
  assert.equal(samples.length, 300)
  assert.equal(samples.at(-1)?.value, 7)
  samples = appendMemorySample(samples, 400000, NaN)
  assert.equal(samples.at(-1)?.value, null)
  assert.strictEqual(appendMemorySample(samples, NaN, 1), samples)
})

test('memory chart uses real byte values and gaps instead of fake zeroes offline', () => {
  const chart = memoryChart([{ time: 0, value: 100 }, { time: 1000, value: 200 }, { time: 2000, value: null }, { time: 3000, value: 50 }, { time: 4000, value: 80 }])
  assert.equal(chart.paths.length, 2)
  assert.equal(chart.peak, 200)
  assert.equal(chart.count, 4)
  assert.equal(chart.spanSeconds, 4)
  assert.ok(chart.paths.every(path => !path.includes('NaN') && !path.includes('Infinity')))
  assert.equal(memoryChart([{ time: 1, value: null }]).count, 0)
  assert.equal(memoryChart([{ time: 1, value: 0 }]).maximum, 1)
})

test('runtime database sources hide URL credentials and signed query values', () => {
  assert.equal(visibleConfigUrl('https://user:secret@db.example/path.mmdb?token=private#private'), 'https://db.example/path.mmdb')
  assert.equal(visibleConfigUrl('javascript:alert(1)'), '—')
  assert.equal(visibleConfigUrl('not a url'), '—')
  assert.equal(visibleConfigUrl(undefined), '')
})
