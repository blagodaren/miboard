import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measuredRuleRange, pinnedRuleIndices, ruleOffsets } from '../src/lib/rules-virtualization.ts'

test('variable-height rules reach the entire list past row 500 without rendering it all', () => {
  const heights = Array.from({ length: 2000 }, (_, index) => 61 + (index % 3) * 16)
  const offsets = ruleOffsets(heights)
  const range = measuredRuleRange(offsets, offsets[1250] + 12, 600)
  assert.ok(range.start <= 1250 && range.end > 1250)
  assert.ok(range.end - range.start < 25)
  assert.equal(range.top + heights.slice(range.start, range.end).reduce((a, b) => a + b, 0) + range.bottom, offsets.at(-1))
  assert.equal(measuredRuleRange(offsets, offsets.at(-1)! + 500, 600).end, 2000)
})

test('large expanded detail remains in the visible range until its whole measured height passes', () => {
  const heights = Array(1000).fill(77); heights[700] += 1400
  const offsets = ruleOffsets(heights)
  const range = measuredRuleRange(offsets, offsets[700] + 900, 400, 0)
  assert.equal(range.start, 700); assert.equal(range.end, 701)
})

test('a pinned expanded or focused row adds one row rather than filling a distant gap', () => {
  const rows = pinnedRuleIndices(1500, 1520, 2000, [10, 10, 900, -1, 2000, NaN])
  assert.equal(rows.length, 22); assert.deepEqual(rows.slice(0, 3), [10, 900, 1500])
  assert.equal(rows.at(-1), 1519)
})

test('empty tables and invalid measurements produce finite spacer bounds', () => {
  assert.deepEqual(measuredRuleRange([0], 0, 0), { start: 0, end: 0, top: 0, bottom: 0 })
  assert.deepEqual(ruleOffsets([0, -1, NaN, Infinity, 80]), [0, 1, 2, 3, 4, 84])
  assert.deepEqual(pinnedRuleIndices(0, 0, 0, [0]), [])
})
