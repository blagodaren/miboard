import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proxy } from '../src/lib/api.ts'
import { applyScene, captureScene, parseScenes, planScene, pushScenes, readScenes, saveScenes, sceneDocument, sceneLocalKey, SceneError, type ProxyScene } from '../src/lib/proxy-scenes.ts'

const group = (name: string, now: string, all: string[], type = 'Selector', fixed?: string): Proxy => ({ name, now, all, type, history: [], ...(fixed !== undefined ? { fixed } : {}) })
const scene = (entries: ProxyScene['entries']): ProxyScene => ({ id: 'test-scene', name: 'Work', createdAt: '2026-11-13T00:00:00Z', entries })
const map = (...values: Proxy[]) => Object.fromEntries(values.map(value => [value.name, value]))

test('capture preserves exact nested selections and explicit fallback automatic/fixed state', () => {
  const proxies = map(group('Main', 'Auto', ['Auto', 'leaf']), group('Auto', 'leaf', ['leaf'], 'URLTest', ''), group('Pinned', 'leaf', ['leaf', 'other'], 'Fallback', 'other'))
  const saved = captureScene('  Work  ', proxies, 'one')
  assert.equal(saved.name, 'Work')
  assert.deepEqual(saved.entries, [{ group: 'Main', mode: 'select', node: 'Auto' }, { group: 'Auto', mode: 'auto' }, { group: 'Pinned', mode: 'select', node: 'other' }])
  assert.equal(proxies.Pinned.now, 'leaf')
})

test('preview separates missing/unsupported/unchanged and rejects combined cycles', () => {
  const proxies = map(group('A', 'leaf', ['B', 'leaf']), group('B', 'leaf', ['A', 'leaf']), group('auto', 'leaf', ['leaf'], 'LoadBalance'), group('same', 'leaf', ['leaf']))
  const rows = planScene(scene([{ group: 'A', mode: 'select', node: 'B' }, { group: 'B', mode: 'select', node: 'A' }, { group: 'gone', mode: 'select', node: 'leaf' }, { group: 'auto', mode: 'select', node: 'leaf' }, { group: 'same', mode: 'select', node: 'leaf' }]), proxies)
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.group, row.status])), { A: 'unsafe', B: 'unsafe', gone: 'missing', auto: 'unsupported', same: 'unchanged' })
})

test('orders writes to avoid temporary cycles; a failed prerequisite prevents the dependent write', async () => {
  const proxies = map(group('A', 'B', ['B', 'leaf']), group('B', 'leaf', ['A', 'leaf']))
  const value = scene([{ group: 'B', mode: 'select', node: 'A' }, { group: 'A', mode: 'select', node: 'leaf' }])
  assert.deepEqual(planScene(value, proxies).map(row => row.group), ['A', 'B'])
  const sent: string[] = []
  const results = await applyScene(value, proxies, async entry => { sent.push(entry.group); throw new Error('offline') }, new AbortController().signal)
  assert.deepEqual(sent, ['A'])
  assert.equal(results[0].result, 'failed')
  assert.equal(results[1].status, 'unsafe')
  assert.equal(proxies.A.now, 'B')
})

test('cancellation stops unsent commands without undoing completed choices', async () => {
  const abort = new AbortController()
  const value = scene([{ group: 'A', mode: 'select', node: 'b' }, { group: 'B', mode: 'select', node: 'b' }])
  const sent: string[] = []
  const results = await applyScene(value, map(group('A', 'a', ['a', 'b']), group('B', 'a', ['a', 'b'])), async entry => { sent.push(entry.group); abort.abort() }, abort.signal)
  assert.deepEqual(sent, ['A'])
  assert.equal(results[0].result, 'applied')
  assert.equal(results[1].result, 'cancelled')
})

test('automatic group fallback branches cannot introduce a cycle hidden by the current now value', async () => {
  for (const type of ['Fallback', 'URLTest']) {
    const proxies = map(group('A', 'leaf', ['leaf', 'Auto']), group('Auto', 'leaf', ['A', 'leaf'], type, 'leaf'))
    const value = scene([{ group: 'A', mode: 'select', node: 'Auto' }, { group: 'Auto', mode: 'auto' }])
    const rows = planScene(value, proxies)
    assert.ok(rows.every(row => row.status === 'unsafe'))
    const sent: string[] = []
    await applyScene(value, proxies, async entry => { sent.push(entry.group) }, new AbortController().signal)
    assert.deepEqual(sent, [])
  }
})

test('shared graph descendants are not mistaken for cycles and prototype-named groups remain ordinary keys', () => {
  const proxies = map(group('__proto__', 'leaf', ['leaf', 'Auto']), group('Auto', 'leaf', ['B', 'C'], 'URLTest', ''), group('B', 'leaf', ['leaf']), group('C', 'leaf', ['leaf']))
  assert.equal(planScene(scene([{ group: '__proto__', mode: 'select', node: 'Auto' }]), proxies)[0].status, 'ready')
})

test('scene storage is controller-scoped and rejects malformed/oversized imports', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const value = sceneDocument([scene([{ group: '__proto__', mode: 'select', node: 'leaf' }])])
  saveScenes('http://first', value, storage)
  assert.deepEqual(readScenes('http://first', storage), value)
  assert.equal(readScenes('http://second', storage).scenes.length, 0)
  assert.notEqual(sceneLocalKey('http://first'), sceneLocalKey('http://second'))
  assert.throws(() => parseScenes(sceneDocument([{ ...value.scenes[0], name: ' ' }])), SceneError)
  assert.throws(() => parseScenes(sceneDocument([{ ...value.scenes[0], entries: [...value.scenes[0].entries, ...value.scenes[0].entries] }])), SceneError)
  assert.throws(() => parseScenes({ ...value, ignored: 'x'.repeat(131073) }), (error: unknown) => error instanceof SceneError && error.code === 'size')
  assert.throws(() => readScenes('bad', { getItem: () => '{'.repeat(131073) }), (error: unknown) => error instanceof SceneError && error.code === 'size')
})

test('sync refuses changed remote state and verifies the written document', async () => {
  const value = sceneDocument([scene([{ group: 'A', mode: 'select', node: 'leaf' }])])
  let remote: unknown = null
  let writes = 0
  await pushScenes(value, null, async () => remote, async next => { remote = next; writes++ })
  assert.equal(writes, 1)
  await assert.rejects(pushScenes(value, null, async () => remote, async () => { writes++ }), (error: unknown) => error instanceof SceneError && error.code === 'conflict')
  assert.equal(writes, 1)
  await assert.rejects(pushScenes(value, value, async () => remote, async () => { remote = null }), (error: unknown) => error instanceof SceneError && error.code === 'verify')
})
