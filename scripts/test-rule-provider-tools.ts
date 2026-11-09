import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuleProvider } from '../src/lib/api.ts'
import { canUpdateRuleProvider, orderedRuleProviders, ruleProviderUpdateTargets } from '../src/lib/rule-provider-tools.ts'

const provider = (vehicleType: string, name = 'display name'): RuleProvider => ({
  name, vehicleType, behavior: 'Domain', ruleCount: 3, type: 'Rule',
})

test('Inline sets move last without changing either section’s API order or source data', () => {
  const providers = Object.freeze({
    inlineFirst: Object.freeze(provider('Inline')),
    http: Object.freeze(provider('HTTP')),
    inlineSecond: Object.freeze(provider('iNlInE')),
    file: Object.freeze(provider('File')),
    unknown: Object.freeze(provider('future')),
  })
  const before = Object.entries(providers)
  assert.deepEqual(orderedRuleProviders(providers).map(([name]) => name), ['http', 'file', 'unknown', 'inlineFirst', 'inlineSecond'])
  assert.deepEqual(Object.entries(providers), before)
  assert.equal(orderedRuleProviders(providers)[0][1], providers.http)
})

test('only HTTP and File providers can be updated, case-insensitively', () => {
  for (const kind of ['HTTP', 'http', 'HtTp', 'File', 'file', 'FiLe']) assert.equal(canUpdateRuleProvider(provider(kind)), true, kind)
  for (const kind of ['Inline', 'INLINE', 'Compatible', '', 'future', 'http-extra']) assert.equal(canUpdateRuleProvider(provider(kind)), false, kind)
  assert.equal(canUpdateRuleProvider(undefined), false)
})

test('bulk targets use every updatable record key, including special names and duplicate display names', () => {
  const providers: Record<string, RuleProvider> = Object.create(null)
  providers['inline entry'] = provider('Inline')
  providers['HTTP / provider?#'] = provider('HTTP', 'same display name')
  providers.__proto__ = provider('File', 'same display name')
  Object.defineProperty(providers, 'constructor', { value: provider('HTTP', 'different display name'), enumerable: true })
  providers['not supported'] = provider('future')
  assert.deepEqual(ruleProviderUpdateTargets(providers), ['HTTP / provider?#', '__proto__', 'constructor'])
  assert.deepEqual(orderedRuleProviders(providers).map(([name]) => name), ['HTTP / provider?#', '__proto__', 'constructor', 'not supported', 'inline entry'])
})

test('null, empty and Inline-only provider collections have no update targets', () => {
  assert.deepEqual(orderedRuleProviders(null), [])
  assert.deepEqual(orderedRuleProviders({}), [])
  assert.deepEqual(ruleProviderUpdateTargets(null), [])
  assert.deepEqual(ruleProviderUpdateTargets({}), [])
  const providers = { first: provider('Inline'), second: provider('inline') }
  assert.deepEqual(orderedRuleProviders(providers).map(([name]) => name), ['first', 'second'])
  assert.deepEqual(ruleProviderUpdateTargets(providers), [])
})
