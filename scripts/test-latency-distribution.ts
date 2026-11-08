import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeLatencyDistribution } from '../src/lib/latency-distribution.ts'

test('threshold boundaries match low, medium and high latency bands', () => {
  assert.deepEqual(summarizeLatencyDistribution([0.5, 399, 400, 799, 800, 1200], 400, 800), {
    fast: 2, ok: 2, slow: 2, none: 0, total: 6,
  })
  assert.deepEqual(summarizeLatencyDistribution([9, 10, 19, 20], 10, 20), {
    fast: 1, ok: 2, slow: 1, none: 0, total: 4,
  })
})

test('failed, missing and non-finite measurements stay neutral', () => {
  assert.deepEqual(summarizeLatencyDistribution([undefined, 0, -1, NaN, Infinity, -Infinity, 50, 450, 900], 400, 800), {
    fast: 1, ok: 1, slow: 1, none: 6, total: 9,
  })
  assert.deepEqual(summarizeLatencyDistribution([undefined, 0, -100], 400, 800), {
    fast: 0, ok: 0, slow: 0, none: 3, total: 3,
  })
})

test('empty groups produce zero counts without an artificial node', () => {
  assert.deepEqual(summarizeLatencyDistribution([], 400, 800), {
    fast: 0, ok: 0, slow: 0, none: 0, total: 0,
  })
})

test('every entry contributes to exactly one band and frozen inputs remain unchanged', () => {
  const values = Object.freeze([15, 300, 400, 799, 800, 9000, 0, undefined, NaN])
  const before = [...values]
  const result = summarizeLatencyDistribution(values, 400, 800)
  assert.equal(result.fast + result.ok + result.slow + result.none, values.length)
  assert.equal(result.total, values.length)
  assert.deepEqual(values, before)
})
