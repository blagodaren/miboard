import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HistoryAccumulator, HISTORY_HOUR, HISTORY_DAY, HISTORY_GAP, HISTORY_ENTITIES, HISTORY_BUCKET_BYTES, HISTORY_COLLECTOR_MAX, validHistoryCollector, historyShareKey, emptyHistoryBucket, mergeHistoryBucket, leaseAvailable, createHistoryShare, parseHistoryShare, writeHistoryShare, HistoryShareError } from '../src/lib/long-history.ts'
import type { Connection } from '../src/lib/api.ts'

const now = Date.UTC(2026, 10, 13, 10)
const conn = (download: number, upload = 0, id = 'a', host = 'example.com'): Connection => ({ id, download, upload, start: '2026-11-13T09:00:00Z', metadata: { sourceIP: '192.168.1.2', host, destinationIP: '1.1.1.1' } as Connection['metadata'], chains: [], rule: '', rulePayload: '' })

test('initial counters are a baseline; repeats and duplicate IDs never double count', () => {
  const tracker = new HistoryAccumulator()
  assert.equal(tracker.observe([conn(100)], now)[0].down, 0)
  const second = tracker.observe([conn(150), conn(150)], now + 1000)[0]
  assert.equal(second.down, 50)
  assert.equal(second.devices[0].down, 50)
  assert.equal(second.observedMs, 1000)
  assert.equal(tracker.observe([conn(150)], now + 2000)[0].down, 0)
  assert.deepEqual(tracker.observe([conn(999)], now + 1000), [])
  assert.equal(tracker.observe([conn(160)], now + 3000)[0].down, 10)
})
test('gaps, resets, new IDs and changed start time never reconstruct unobserved traffic', () => {
  const tracker = new HistoryAccumulator()
  tracker.observe([conn(100)], now)
  const gap = tracker.observe([conn(500)], now + HISTORY_GAP + 1)[0]
  assert.equal(gap.down, 0); assert.equal(gap.gaps, 1)
  assert.equal(tracker.observe([conn(10)], now + HISTORY_GAP + 1000)[0].down, 0)
  tracker.reset()
  assert.equal(tracker.observe([conn(700)], now + HISTORY_GAP + 2000)[0].down, 0)
  assert.equal(tracker.observe([conn(100, 0, 'new')], now + HISTORY_GAP + 3000)[0].down, 0)
  assert.equal(tracker.observe([{ ...conn(500, 0, 'new'), start: 'new incarnation' }], now + HISTORY_GAP + 4000)[0].down, 0)
})
test('hour boundary shares time and bytes without rounding loss', () => {
  const tracker = new HistoryAccumulator()
  tracker.observe([conn(0)], now + HISTORY_HOUR - 1000)
  const rows = tracker.observe([conn(101, 3)], now + HISTORY_HOUR + 1000)
  assert.deepEqual(rows.map(row => row.down), [50, 51])
  assert.deepEqual(rows.map(row => row.up), [1, 2])
  assert.deepEqual(rows.map(row => row.observedMs), [1000, 1000])
})
test('entity and byte limits retain totals, including hostile long Unicode names', () => {
  const tracker = new HistoryAccumulator()
  const list = Array.from({ length: 1000 }, (_, i) => conn(0, 0, String(i), `${i}${'😀'.repeat(200)}`))
  tracker.observe(list, now)
  const row = tracker.observe(list.map(item => ({ ...item, download: 1, upload: 2 })), now + 1000)[0]
  assert.equal(row.down, 1000); assert.equal(row.up, 2000)
  assert.ok(row.domains.length <= HISTORY_ENTITIES)
  assert.equal(row.domains.reduce((sum, item) => sum + item.down, 0), 1000)
  assert.ok(new TextEncoder().encode(JSON.stringify(row)).length <= HISTORY_BUCKET_BYTES)
  const merged = mergeHistoryBucket(row, row)
  assert.equal(merged.down, 2000)
  assert.equal(merged.domains.reduce((sum, item) => sum + item.down, 0), 2000)
})
test('one tab lease owns capture until expiry; clock rollback does not lock history forever', () => {
  assert.equal(leaseAvailable({ owner: 'a', until: now + 1000 }, 'b', now), false)
  assert.equal(leaseAvailable({ owner: 'a', until: now + 1000 }, 'a', now), true)
  assert.equal(leaseAvailable({ owner: 'a', until: now }, 'b', now), true)
  assert.equal(leaseAvailable({ owner: 'a', until: now + HISTORY_GAP * 3 }, 'b', now), true)
})
test('shared snapshots use UTC days, prune old data, validate duplicate days and strip fields', () => {
  const rows = [now - 31 * HISTORY_DAY, now, now + HISTORY_HOUR].map(hour => ({ ...emptyHistoryBucket(hour), down: 10, up: 5, observedMs: 1000 }))
  const share = createHistoryShare(rows, 'collector123', 'Browser', 'revision123', now + HISTORY_HOUR)
  assert.equal(share.days.length, 1); assert.equal(share.days[0].down, 20)
  assert.equal(share.days[0].day % HISTORY_DAY, 0)
  assert.deepEqual(parseHistoryShare({ ...share, secret: 'never retained' }), share)
  assert.throws(() => parseHistoryShare({ ...share, days: [...share.days, share.days[0]] }), HistoryShareError)
})
test('share conflict prevents writes; concurrent overwrite after PUT fails verification', async () => {
  const first = createHistoryShare([], 'collector123', 'A', 'revision123', now)
  const next = { ...first, revision: 'revision456' }
  let writes = 0
  await assert.rejects(writeHistoryShare(null, next, async () => first, async () => { writes++ }), (error: unknown) => error instanceof HistoryShareError && error.code === 'changed')
  assert.equal(writes, 0)
  await assert.rejects(writeHistoryShare(first, next, async () => first, async () => { writes++ }), (error: unknown) => error instanceof HistoryShareError && error.code === 'verify')
  let remote = first
  await writeHistoryShare(first, next, async () => remote, async value => { remote = value })
  assert.deepEqual(remote, next)
})

test('shared snapshot dates stay renderable and within their own capture window, including archived snapshots', () => {
  const archivedAt = Date.UTC(2020, 0, 15, 12)
  const share = createHistoryShare([{ ...emptyHistoryBucket(archivedAt), down: 10 }], 'collector123', 'Archive', 'revision123', archivedAt)
  assert.deepEqual(parseHistoryShare(share), share)
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en').format(parseHistoryShare(share)!.days[0].day))
  const day = share.days[0]
  for (const invalidDay of [9007199222400000, day.day + HISTORY_DAY, day.day - 31 * HISTORY_DAY]) {
    assert.throws(() => parseHistoryShare({ ...share, days: [{ ...day, day: invalidDay }] }), HistoryShareError)
  }
  assert.throws(() => parseHistoryShare({ ...share, updatedAt: 9007199222400000 }), HistoryShareError)
})

test('collector validation keeps complete storage keys within the core 64-byte limit', () => {
  for (const length of [8, 32, HISTORY_COLLECTOR_MAX]) {
    const code = 'a'.repeat(length)
    assert.equal(validHistoryCollector(code), true)
    assert.ok(Buffer.byteLength(historyShareKey(code)) <= 64)
    assert.equal(parseHistoryShare(createHistoryShare([], code, 'Browser', 'revision123', now))!.collector, code)
  }
  assert.equal(Buffer.byteLength(historyShareKey('a'.repeat(HISTORY_COLLECTOR_MAX))), 64)
  for (const code of ['a'.repeat(7), 'a'.repeat(HISTORY_COLLECTOR_MAX + 1), 'a'.repeat(64), 'é'.repeat(8), 'a/bcdefgh']) {
    assert.equal(validHistoryCollector(code), false)
    assert.throws(() => historyShareKey(code), HistoryShareError)
    assert.throws(() => createHistoryShare([], code, 'Browser', 'revision123', now), HistoryShareError)
  }
})
