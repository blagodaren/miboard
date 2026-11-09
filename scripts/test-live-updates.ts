import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Connection } from '../src/lib/api.ts'
import { ConnectionRates, validLiveUpdateMode } from '../src/lib/live-updates.ts'

const connection = (download: number, upload = 0, start = '2026-01-01T00:00:00Z') => ({ id: 'one', start, download, upload, metadata: {} }) as Connection

test('connection rates use elapsed time and isolate reused IDs, counter resets and observation gaps', () => {
  const rates = new ConnectionRates()
  assert.equal(rates.sample([connection(100)], 1000)[0].dl, 0)
  assert.equal(rates.sample([connection(600, 150)], 1500)[0].dl, 1000)
  assert.equal(rates.sample([connection(2600, 1150)], 3500)[0].ul, 500)
  assert.equal(rates.sample([connection(0)], 4500)[0].dl, 0)
  assert.equal(rates.sample([connection(900, 0, 'new-start')], 5500)[0].dl, 0)
  assert.equal(rates.sample([connection(100000, 0, 'new-start')], 25500)[0].dl, 0)
  rates.reset()
  assert.equal(rates.sample([connection(100000)], 26500)[0].dl, 0)
  assert.equal(rates.sample([connection(200000)], 26000)[0].dl, 0)
  assert.equal(rates.sample([connection(NaN, Infinity)], 27000)[0].dl, 0)
  assert.equal(rates.sample([connection(NaN, Infinity)], 28000)[0].ul, 0)
})

test('live update mode accepts only the two supported capture policies', () => {
  assert.equal(validLiveUpdateMode('realtime'), true)
  assert.equal(validLiveUpdateMode('eco'), true)
  for (const value of [null, undefined, '', 'hidden', {}, 0]) assert.equal(validLiveUpdateMode(value), false)
})
