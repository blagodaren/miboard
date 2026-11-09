import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { remainingRuleProviderNames, runRuleProviderBatch, type RuleProviderBatchOutcome } from '../src/lib/rule-provider-batch.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('two workers snapshot and deduplicate names; callbacks report initial state and each completion', async () => {
  const controller = new AbortController()
  const names = ['first', 'second', 'first', 'third', 'fourth']
  const gates = new Map(['first', 'second', 'third', 'fourth'].map(name => [name, deferred()]))
  const started: string[] = []
  const dispatched: string[] = []
  const progress: RuleProviderBatchOutcome[] = []
  let active = 0
  let peak = 0
  const batch = runRuleProviderBatch(names, {
    signal: controller.signal,
    onStart: name => { started.push(name) },
    onProgress: value => { progress.push(value) },
    update: async (name, signal) => {
      assert.equal(signal, controller.signal)
      dispatched.push(name)
      peak = Math.max(peak, ++active)
      await gates.get(name)!.promise
      active--
    },
  })
  assert.deepEqual(started, ['first', 'second'])
  names[0] = 'renamed'
  names.push('added later')
  gates.get('second')!.resolve()
  await tick()
  assert.deepEqual(started, ['first', 'second', 'third'])
  assert.equal(active, 2)
  gates.get('third')!.resolve()
  await tick()
  assert.deepEqual(started, ['first', 'second', 'third', 'fourth'])
  gates.get('fourth')!.resolve()
  gates.get('first')!.resolve()
  assert.deepEqual(await batch, { succeeded: ['first', 'second', 'third', 'fourth'], failed: [], interrupted: [], pending: [], cancelled: false })
  assert.equal(peak, 2)
  assert.deepEqual(dispatched, started)
  assert.equal(progress.length, 5)
  assert.deepEqual(progress[0], { succeeded: [], failed: [], interrupted: [], pending: ['first', 'second', 'third', 'fourth'], cancelled: false })
  assert.deepEqual(progress.map(value => value.succeeded.length), [0, 1, 2, 3, 4])
})

test('a real failure does not stop the queue; cancellation preserves earlier outcomes and leaves queued work pending', async () => {
  const controller = new AbortController()
  const names = ['success', 'failure', 'active-a', 'active-b', 'queued']
  const gates = new Map(names.map(name => [name, deferred()]))
  const started: string[] = []
  const failure = new Error('HTTP 500')
  const batch = runRuleProviderBatch(names, {
    signal: controller.signal,
    onStart: name => { started.push(name) },
    update: async (name, signal) => {
      const gate = gates.get(name)!
      const abort = () => gate.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      try { await gate.promise } finally { signal.removeEventListener('abort', abort) }
    },
  })
  gates.get('success')!.resolve()
  await tick()
  gates.get('failure')!.reject(failure)
  await tick()
  assert.deepEqual(started, ['success', 'failure', 'active-a', 'active-b'])
  controller.abort()
  assert.deepEqual(await batch, {
    succeeded: ['success'], failed: [{ name: 'failure', error: failure }],
    interrupted: ['active-a', 'active-b'], pending: ['queued'], cancelled: true,
  })
  assert.deepEqual(started, ['success', 'failure', 'active-a', 'active-b'])
})

test('abort waits for active requests and treats even a late successful response as interrupted', async () => {
  const controller = new AbortController()
  const gates = [deferred(), deferred()]
  const started: string[] = []
  let finished = false
  const batch = runRuleProviderBatch(['first', 'second', 'queued'], {
    signal: controller.signal,
    update: name => {
      started.push(name)
      return gates[name === 'first' ? 0 : 1].promise
    },
  }).then(value => { finished = true; return value })
  controller.abort()
  await tick()
  assert.equal(finished, false)
  gates[0].resolve()
  await tick()
  assert.equal(finished, false)
  assert.deepEqual(started, ['first', 'second'])
  gates[1].reject(new Error('connection aborted'))
  assert.deepEqual(await batch, { succeeded: [], failed: [], interrupted: ['first', 'second'], pending: ['queued'], cancelled: true })
})

test('pre-aborted and empty batches dispatch nothing and report their initial snapshot', async () => {
  const controller = new AbortController()
  controller.abort()
  const progress: RuleProviderBatchOutcome[] = []
  const forbidden = async () => { assert.fail('No request should start') }
  const result = await runRuleProviderBatch(['a', 'b', 'a'], {
    signal: controller.signal, update: forbidden, onStart: forbidden,
    onProgress: value => { progress.push(value) },
  })
  assert.deepEqual(result, { succeeded: [], failed: [], interrupted: [], pending: ['a', 'b'], cancelled: true })
  assert.deepEqual(progress, [result])
  assert.deepEqual(await runRuleProviderBatch([], { signal: new AbortController().signal, update: forbidden }), {
    succeeded: [], failed: [], interrupted: [], pending: [], cancelled: false,
  })
})

test('failed names retain input order even with out-of-order responses and undefined rejection reasons', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const firstError = new Error('first')
  const secondError = new Error('second')
  const started: string[] = []
  const batch = runRuleProviderBatch(['first', 'second', 'third'], {
    signal: new AbortController().signal,
    update: name => {
      started.push(name)
      return gates[['first', 'second', 'third'].indexOf(name)].promise
    },
  })
  gates[1].reject(secondError)
  await tick()
  assert.deepEqual(started, ['first', 'second', 'third'])
  gates[2].reject(undefined)
  await tick()
  gates[0].reject(firstError)
  assert.deepEqual(await batch, {
    succeeded: [], failed: [{ name: 'first', error: firstError }, { name: 'second', error: secondError }, { name: 'third', error: undefined }],
    interrupted: [], pending: [], cancelled: false,
  })
})

test('progress snapshots cannot mutate scheduling, later snapshots or the final result', async () => {
  const gates = [deferred(), deferred()]
  const failure = new Error('failed')
  const progress: RuleProviderBatchOutcome[] = []
  const batch = runRuleProviderBatch(['first', 'second'], {
    signal: new AbortController().signal,
    update: name => gates[name === 'first' ? 0 : 1].promise,
    onProgress: value => { progress.push(value) },
  })
  progress[0].pending.length = 0
  progress[0].succeeded.push('invented')
  gates[0].reject(failure)
  await tick()
  progress[1].failed[0].name = 'changed externally'
  progress[1].failed.push({ name: 'invented', error: null })
  gates[1].resolve()
  const result = await batch
  assert.deepEqual(result, { succeeded: ['second'], failed: [{ name: 'first', error: failure }], interrupted: [], pending: [], cancelled: false })
  assert.deepEqual(progress[2], result)
  progress[2].failed[0].name = 'changed again'
  progress[2].succeeded.length = 0
  assert.equal(result.failed[0].name, 'first')
  assert.deepEqual(result.succeeded, ['second'])
})

test('synchronous update errors are isolated and special provider names are safe identities', async () => {
  const failure = new Error('sync error')
  const result = await runRuleProviderBatch(['__proto__', 'constructor', '__proto__', 'remote / a?#'], {
    signal: new AbortController().signal,
    update: name => {
      if (name === '__proto__') throw failure
      return Promise.resolve()
    },
  })
  assert.deepEqual(result, {
    succeeded: ['constructor', 'remote / a?#'], failed: [{ name: '__proto__', error: failure }], interrupted: [], pending: [], cancelled: false,
  })
})

test('cancellation before dispatch keeps the claimed request pending', async () => {
  const controller = new AbortController()
  const result = await runRuleProviderBatch(['first', 'second'], {
    signal: controller.signal,
    onStart: () => { controller.abort() },
    update: async () => { assert.fail('Cancelled request must not be dispatched') },
  })
  assert.deepEqual(result, { succeeded: [], failed: [], interrupted: [], pending: ['first', 'second'], cancelled: true })
})

test('remaining work after cancellation excludes successful and failed providers', () => {
  const previous = Object.freeze(['older pending', 'success', 'failed'])
  const outcome: RuleProviderBatchOutcome = {
    succeeded: ['success'], failed: [{ name: 'failed', error: new Error('HTTP 500') }],
    interrupted: ['active first', 'active second'], pending: ['queued first', 'queued second'], cancelled: true,
  }
  assert.deepEqual(remainingRuleProviderNames(previous, outcome), ['older pending', 'active first', 'active second', 'queued first', 'queued second'])
  assert.deepEqual(previous, ['older pending', 'success', 'failed'])
  assert.deepEqual(outcome.interrupted, ['active first', 'active second'])
  assert.deepEqual(outcome.pending, ['queued first', 'queued second'])
})

test('successive cancelled resumes keep the remaining order and still queued providers', () => {
  const first = remainingRuleProviderNames([], {
    succeeded: ['done'], failed: [], interrupted: ['first', 'second'], pending: ['third', 'fourth'], cancelled: true,
  })
  const second = remainingRuleProviderNames(first, {
    succeeded: ['second'], failed: [], interrupted: ['first', 'third'], pending: ['fourth'], cancelled: true,
  })
  assert.deepEqual(first, ['first', 'second', 'third', 'fourth'])
  assert.deepEqual(second, ['first', 'third', 'fourth'])
  assert.deepEqual(remainingRuleProviderNames(second, {
    succeeded: ['first'], failed: [{ name: 'third', error: 'failed' }], interrupted: ['fourth'], pending: [], cancelled: true,
  }), ['fourth'])
})

test('a separate failed-provider retry does not erase previously unfinished providers', () => {
  const previous = ['remaining first', 'remaining second']
  assert.deepEqual(remainingRuleProviderNames(previous, {
    succeeded: ['retry success'], failed: [{ name: 'retry failed', error: 'still unavailable' }],
    interrupted: [], pending: [], cancelled: false,
  }), previous)
  assert.deepEqual(remainingRuleProviderNames(previous, {
    succeeded: ['retry success'], failed: [], interrupted: ['retry interrupted'], pending: ['retry pending'], cancelled: true,
  }), ['remaining first', 'remaining second', 'retry interrupted', 'retry pending'])
})

test('an uncancelled job removes only touched outcomes and does not append interrupted or pending arrays', () => {
  assert.deepEqual(remainingRuleProviderNames(['unrelated', 'success', 'failure', 'still pending'], {
    succeeded: ['success'], failed: [{ name: 'failure', error: null }],
    interrupted: ['unexpected interrupted'], pending: ['unexpected pending'], cancelled: false,
  }), ['unrelated', 'still pending'])
})

test('remaining names are deduplicated safely while respecting previous, interrupted and queued order', () => {
  const result = remainingRuleProviderNames(['__proto__', 'constructor', '__proto__', 'done'], {
    succeeded: ['done'], failed: [{ name: 'failed', error: undefined }],
    interrupted: ['constructor', 'new / provider?#', 'failed', 'done'],
    pending: ['__proto__', 'new / provider?#', 'last', 'last'], cancelled: true,
  })
  assert.deepEqual(result, ['__proto__', 'constructor', 'new / provider?#', 'last'])
})
