import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateProviderAlerts, readProviderAlertState, PROVIDER_EXPIRY_WARNING } from '../src/lib/provider-alerts.ts'
import type { ProxyProvider } from '../src/lib/api.ts'

const now = Date.UTC(2026, 10, 10)
const initial = () => readProviderAlertState(null)
const provider = (subscriptionInfo: ProxyProvider['subscriptionInfo']): Record<string, ProxyProvider> => ({ Main: { vehicleType: 'HTTP', subscriptionInfo } })

test('quota warning starts below 10%, expiry at 3 days, missing quota stays unknown', () => {
  assert.equal(evaluateProviderAlerts(provider({ Download: 90, Upload: 0, Total: 100 }), initial(), now).alerts.length, 0)
  assert.equal(evaluateProviderAlerts(provider({ Download: 91, Upload: 0, Total: 100 }), initial(), now).alerts[0]?.kind, 'lowQuota')
  assert.equal(evaluateProviderAlerts(provider({ Download: 100, Upload: 10, Total: 100 }), initial(), now).alerts[0]?.kind, 'exhausted')
  assert.equal(evaluateProviderAlerts(provider({ Download: 99, Total: 100 }), initial(), now).alerts.length, 0)
  assert.equal(evaluateProviderAlerts(provider({ Download: 99, Upload: 0, Total: 0, Expire: 0 }), initial(), now).alerts.length, 0)
  assert.equal(evaluateProviderAlerts(provider({ Expire: (now + PROVIDER_EXPIRY_WARNING) / 1000 }), initial(), now).alerts[0]?.kind, 'expiring')
  assert.equal(evaluateProviderAlerts(provider({ Expire: (now + PROVIDER_EXPIRY_WARNING + 1000) / 1000 }), initial(), now).alerts.length, 0)
  assert.equal(evaluateProviderAlerts(provider({ Expire: now / 1000 }), initial(), now).alerts[0]?.kind, 'expired')
})

test('repeated polls/reloads do not re-notify; exhaustion and actual renewal rearm', () => {
  const low = provider({ Download: 91, Upload: 0, Total: 100 })
  const first = evaluateProviderAlerts(low, initial(), now)
  assert.equal(first.alerts.length, 1)
  const restored = readProviderAlertState(JSON.parse(JSON.stringify(first.state)))
  assert.equal(evaluateProviderAlerts(low, restored, now + 100000).alerts.length, 0)
  const partial = evaluateProviderAlerts(provider({ Download: 99, Total: 100 }), restored, now)
  assert.equal(evaluateProviderAlerts(low, partial.state, now).alerts.length, 0, 'partial metadata does not rearm')
  const spent = evaluateProviderAlerts(provider({ Download: 100, Upload: 0, Total: 100 }), restored, now)
  assert.equal(spent.alerts[0]?.kind, 'exhausted')
  const renewed = evaluateProviderAlerts(provider({ Download: 0, Upload: 0, Total: 100 }), spent.state, now)
  assert.equal(evaluateProviderAlerts(low, renewed.state, now).alerts.length, 1)
  assert.equal(evaluateProviderAlerts(low, { ...restored, enabled: false }, now).alerts.length, 0)
})

test('expiry transition and changed subscription period notify once each', () => {
  const expire = (now + 1000) / 1000
  const expiring = evaluateProviderAlerts(provider({ Expire: expire }), initial(), now)
  const expired = evaluateProviderAlerts(provider({ Expire: expire }), expiring.state, now + 1000)
  assert.equal(expired.alerts[0]?.kind, 'expired')
  assert.equal(evaluateProviderAlerts(provider({ Expire: expire }), expired.state, now + 2000).alerts.length, 0)
  assert.equal(evaluateProviderAlerts(provider({ Expire: expire + 3600 }), expired.state, now).alerts[0]?.kind, 'expiring')
})

test('default/Compatible, invalid values and disabled state never raise warnings', () => {
  assert.deepEqual(evaluateProviderAlerts({ default: { subscriptionInfo: { Expire: 1 } }, compatible: { vehicleType: 'Compatible', subscriptionInfo: { Expire: 1 } } }, initial(), now).alerts, [])
  assert.deepEqual(evaluateProviderAlerts(provider({ Download: Infinity, Upload: 0, Total: 100, Expire: Infinity }), initial(), now).alerts, [])
  assert.equal(readProviderAlertState({ enabled: false, seen: { a: 42, b: 'valid' } }).enabled, false)
  assert.deepEqual(readProviderAlertState({ seen: { a: 42, b: 'valid' } }).seen, { b: 'valid' })
  assert.equal(evaluateProviderAlerts(provider({ Expire: 1 }), { ...initial(), enabled: false }, now).alerts.length, 0)
})
