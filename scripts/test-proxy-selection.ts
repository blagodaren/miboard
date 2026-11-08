import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Proxy } from '../src/lib/api.ts'
import { planProxySelection, SELECTABLE_PROXY_TYPES } from '../src/lib/proxy-selection.ts'

const node = (name: string): Proxy => ({ name, type: 'Vless', history: [] })
const group = (name: string, all: string[], now?: string, type = 'Selector'): Proxy => ({ name, type, all, now, history: [] })
const record = (...proxies: Proxy[]) => Object.fromEntries(proxies.map(proxy => [proxy.name, proxy]))

test('plans all matching selectable groups, including hidden and GLOBAL, while reporting skips', () => {
  const proxies = record(
    group('Select', ['node-a', 'node-b'], 'node-a'),
    group('Video', ['node-b', 'node-a'], 'node-b'),
    group('Fallback', ['node-a', 'node-b'], 'node-b', 'Fallback'),
    { ...group('Hidden', ['node-a', 'node-b'], 'node-b'), hidden: true },
    group('GLOBAL', ['node-a', 'node-b'], 'node-b'),
    group('Already selected', ['node-a', 'node-b'], 'node-a'),
    group('Missing', ['node-b'], 'node-b'),
    group('Automatic', ['node-a', 'node-b'], 'node-b', 'URLTest'),
    group('Smart', ['node-a', 'node-b'], 'node-b', 'Smart'),
    node('node-a'), node('node-b'),
  )
  assert.deepEqual(planProxySelection(proxies, 'Select'), {
    node: 'node-a',
    targets: ['Video', 'Fallback', 'Hidden', 'GLOBAL'],
    unchanged: ['Already selected'],
    missing: ['Missing'],
    unsupported: ['Automatic', 'Smart'],
    unsafe: [],
  })
  assert.equal(SELECTABLE_PROXY_TYPES.has('Selector'), true)
  assert.equal(SELECTABLE_PROXY_TYPES.has('Fallback'), true)
  assert.equal(SELECTABLE_PROXY_TYPES.has('URLTest'), false)
})

test('copies the exact member name without matching prefixes, normalizing flags or resolving a nested group', () => {
  const name = '🇳🇱 Amsterdam'
  const exact = record(
    group('Source', [name], name),
    group('Exact', [name, 'other'], 'other'),
    group('Similar', ['Amsterdam', `${name} 2`], 'Amsterdam'),
  )
  assert.deepEqual(planProxySelection(exact, 'Source').targets, ['Exact'])
  assert.deepEqual(planProxySelection(exact, 'Source').missing, ['Similar'])

  const nested = record(
    group('Source', ['Auto'], 'Auto'),
    group('Auto', ['leaf'], 'leaf', 'URLTest'),
    group('Target', ['Auto', 'other'], 'other'),
    group('Leaf only', ['leaf', 'other'], 'other'),
    node('leaf'), node('other'),
  )
  const plan = planProxySelection(nested, 'Source')
  assert.equal(plan.node, 'Auto')
  assert.deepEqual(plan.targets, ['Target'])
  assert.ok(plan.missing.includes('Leaf only'))
})

test('provider-only leaves do not need to exist in the root proxy metadata', () => {
  const proxies = record(group('Source', ['provider-node'], 'provider-node'), group('Target', ['provider-node', 'other'], 'other'))
  assert.deepEqual(planProxySelection(proxies, 'Source').targets, ['Target'])
})

test('rejects missing, non-group and stale source selections without planning any writes', () => {
  const empty = { node: '', targets: [], unchanged: [], missing: [], unsupported: [], unsafe: [] }
  const proxies = record(
    node('Leaf'),
    group('Unset', ['node-a']),
    group('Empty', ['node-a'], ''),
    group('Stale', ['node-a'], 'node-b'),
    group('Valid target', ['node-b', 'node-a'], 'node-a'),
  )
  for (const source of ['Missing', 'Leaf', 'Unset', 'Empty', 'Stale']) assert.deepEqual(planProxySelection(proxies, source), empty, source)
})

test('a target cannot select itself, including a pre-existing self-selection', () => {
  for (const now of ['leaf', 'Nested']) {
    const proxies = record(
      group('Source', ['Nested'], 'Nested'),
      group('Nested', ['Nested', 'leaf'], now),
      node('leaf'),
    )
    const plan = planProxySelection(proxies, 'Source')
    assert.deepEqual(plan.targets, [])
    assert.deepEqual(plan.unsafe, ['Nested'])
  }
})

test('leaves every target on the selected nested path unchanged, while applying safe independent targets', () => {
  const proxies = record(
    group('Source', ['Nested'], 'Nested'),
    group('Nested', ['First'], 'First'),
    group('First', ['Nested', 'Second'], 'Second'),
    group('Second', ['Nested', 'leaf'], 'leaf'),
    group('Safe', ['Nested', 'leaf'], 'leaf'),
    node('leaf'),
  )
  const plan = planProxySelection(proxies, 'Source')
  assert.deepEqual(plan.targets, ['Safe'])
  assert.deepEqual(plan.unsafe, ['First', 'Second'])
  assert.equal(proxies.First.now, 'Second')
  assert.equal(proxies.Second.now, 'leaf')
})

test('does not send other groups into an already cyclic selected chain', () => {
  const proxies = record(
    group('Source', ['Nested'], 'Nested'),
    group('Nested', ['Relay'], 'Relay'),
    group('Relay', ['Nested'], 'Nested'),
    group('Target', ['Nested', 'leaf'], 'leaf'),
    node('leaf'),
  )
  const plan = planProxySelection(proxies, 'Source')
  assert.deepEqual(plan.targets, [])
  assert.deepEqual(plan.unsafe, ['Target'])
  assert.deepEqual(plan.unchanged, ['Relay'])
})

test('does not mutate frozen input, its selections or group member arrays', () => {
  const proxies = record(group('Source', ['node-a'], 'node-a'), group('Target', ['node-b', 'node-a'], 'node-b'))
  const before = structuredClone(proxies)
  for (const proxy of Object.values(proxies)) {
    if (proxy.all) Object.freeze(proxy.all)
    Object.freeze(proxy)
  }
  Object.freeze(proxies)
  const plan = planProxySelection(proxies, 'Source')
  plan.targets.push('unrelated')
  assert.deepEqual(proxies, before)
})
