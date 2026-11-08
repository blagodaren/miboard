import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { runProxyGroupBatch } from '../src/lib/proxy-batch.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('default scheduling keeps two active groups and reports every settlement once', async () => {
  const groups = Object.freeze([0, 1, 2, 3, 4])
  const gates = groups.map(deferred)
  const started: number[] = []
  const progress: number[][] = []
  let active = 0
  let peak = 0
  const batch = runProxyGroupBatch(groups, async (group) => {
    started.push(group)
    peak = Math.max(peak, ++active)
    await gates[group].promise
    active--
  }, (done, total) => { progress.push([done, total]) })

  assert.deepEqual(started, [0, 1])
  gates[1].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  assert.equal(active, 2)
  gates[0].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[2].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  gates[3].resolve()
  gates[4].resolve()

  assert.deepEqual(await batch, { completed: 5, failed: 0, errors: [], cancelled: false })
  assert.equal(peak, 2)
  assert.deepEqual(progress, [[0, 5], [1, 5], [2, 5], [3, 5], [4, 5], [5, 5]])
  assert.deepEqual(groups, [0, 1, 2, 3, 4])
})

test('custom concurrency is respected and duplicate inputs are intentionally processed', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const started: string[] = []
  let index = 0
  const batch = runProxyGroupBatch(['same', 'same', 'last'], async (group) => {
    const position = index++
    started.push(group)
    await gates[position].promise
  }, () => {}, { concurrency: 1 })

  assert.deepEqual(started, ['same'])
  gates[0].resolve()
  await tick()
  assert.deepEqual(started, ['same', 'same'])
  gates[1].resolve()
  await tick()
  assert.deepEqual(started, ['same', 'same', 'last'])
  gates[2].resolve()
  assert.equal((await batch).completed, 3)
})

test('failed groups do not block later groups and errors retain input order', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()]
  const errors = [new Error('first'), new Error('second')]
  const started: number[] = []
  const progress: number[] = []
  const batch = runProxyGroupBatch([0, 1, 2, 3], async (group) => {
    started.push(group)
    await gates[group].promise
    if (group < 2) throw errors[group]
  }, (done) => { progress.push(done) })

  gates[1].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  gates[2].resolve()
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3])
  gates[3].resolve()
  gates[0].resolve()
  assert.deepEqual(await batch, { completed: 4, failed: 2, errors, cancelled: false })
  assert.deepEqual(progress, [0, 1, 2, 3, 4])
})

test('abort stops queued groups and waits for active groups to settle', async () => {
  const controller = new AbortController()
  const gates = [deferred(), deferred()]
  const started: number[] = []
  const progress: number[][] = []
  const activeError = new Error('request aborted')
  let finished = false
  const batch = runProxyGroupBatch([0, 1, 2, 3], async (group) => {
    started.push(group)
    await gates[group].promise
    if (group === 1) throw activeError
  }, (done, total) => { progress.push([done, total]) }, { signal: controller.signal })
  void batch.then(() => { finished = true })

  controller.abort()
  await tick()
  assert.deepEqual(started, [0, 1])
  assert.equal(finished, false)
  gates[0].resolve()
  await tick()
  assert.equal(finished, false)
  assert.deepEqual(started, [0, 1])
  gates[1].resolve()
  assert.deepEqual(await batch, { completed: 2, failed: 1, errors: [activeError], cancelled: true })
  assert.deepEqual(progress, [[0, 4], [1, 4], [2, 4]])
})

test('pre-aborted and empty batches report their initial total without starting work', async () => {
  const controller = new AbortController()
  controller.abort()
  const progress: number[][] = []
  const forbidden = async () => { assert.fail('must not start work') }
  assert.deepEqual(await runProxyGroupBatch([1, 2], forbidden, (done, total) => {
    progress.push([done, total])
  }, { signal: controller.signal }), { completed: 0, failed: 0, errors: [], cancelled: true })
  assert.deepEqual(await runProxyGroupBatch([], forbidden, (done, total) => {
    progress.push([done, total])
  }), { completed: 0, failed: 0, errors: [], cancelled: false })
  assert.deepEqual(progress, [[0, 2], [0, 0]])
})

test('invalid concurrency falls back to two and rejected runs are isolated', async () => {
  for (const concurrency of [0, -1, Number.NaN, Infinity, 1.5]) {
    const gate = deferred()
    const started: number[] = []
    const batch = runProxyGroupBatch([0, 1, 2], async (group) => {
      started.push(group)
      if (group === 0) throw undefined
      await gate.promise
    }, () => {}, { concurrency })
    assert.deepEqual(started, [0, 1])
    await tick()
    assert.deepEqual(started, [0, 1, 2])
    gate.resolve()
    assert.deepEqual(await batch, { completed: 3, failed: 1, errors: [undefined], cancelled: false })
  }
})

test('a synchronous throw from run is counted and does not skip queued groups', async () => {
  const failure = new Error('synchronous failure')
  const started: number[] = []
  const progress: number[] = []
  const result = await runProxyGroupBatch([0, 1, 2], (group): Promise<void> => {
    started.push(group)
    if (group === 0) throw failure
    return Promise.resolve()
  }, (done) => { progress.push(done) }, { concurrency: 1 })
  assert.deepEqual(started, [0, 1, 2])
  assert.deepEqual(progress, [0, 1, 2, 3])
  assert.deepEqual(result, { completed: 3, failed: 1, errors: [failure], cancelled: false })
})

test('the queued batch is a snapshot if the caller later changes its array', async () => {
  const groups = ['first', 'second']
  const gate = deferred()
  const started: string[] = []
  const batch = runProxyGroupBatch(groups, async (group) => {
    started.push(group)
    if (group === 'first') await gate.promise
  }, () => {}, { concurrency: 1 })
  groups[1] = 'changed'
  groups.push('new')
  gate.resolve()
  assert.deepEqual(await batch, { completed: 2, failed: 0, errors: [], cancelled: false })
  assert.deepEqual(started, ['first', 'second'])
})
