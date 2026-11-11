import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { evaluateProviderAlerts, readProviderAlertState, PROVIDER_EXPIRY_WARNING, PROVIDER_ALERT_PREFERENCES_CHANGED, providerAlertsKey } from '../src/lib/provider-alerts.ts'
import type { ProxyProvider } from '../src/lib/api.ts'
import type * as Transfer from '../src/lib/settings-transfer.ts'

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

type AlertPreferences = {
  enabled: (url: string) => boolean
  memoryOnly: (url: string) => boolean
  setEnabled: (url: string, enabled: boolean) => void
  inspect: (url: string, providers: Record<string, ProxyProvider>, now: number) => unknown[]
}
const moduleSources = new Map(['api', 'devices', 'latency', 'appearance', 'live-updates', 'proxy-test-selection', 'connection-columns', 'provider-alerts', 'journal-preferences', 'settings-transfer', 'provider-alerts.svelte'].map(file => [
  './' + file,
  ts.transpileModule(readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
]))
function preferenceSession(urls: string[]) {
  const store = new Map(urls.map(url => [providerAlertsKey(url), JSON.stringify({ enabled: true, seen: {} })]))
  const target = new EventTarget()
  const changes: unknown[] = []
  target.addEventListener(PROVIDER_ALERT_PREFERENCES_CHANGED, event => { changes.push((event as CustomEvent<unknown>).detail) })
  let failedRead: string | null = null
  let failedWrite: string | null = null
  const modules = new Map<string, Record<string, unknown>>()
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, btoa, AbortController, CustomEvent, window: target,
    // These tests exercise the store's cache and persistence; no component render is needed.
    $state: (value: unknown) => value,
    localStorage: {
      get length() { return store.size }, key(index: number) { return [...store.keys()][index] ?? null },
      getItem(key: string) {
        if (key === failedRead) { failedRead = null; throw new Error('Storage temporarily unavailable') }
        return store.get(key) ?? null
      },
      setItem(key: string, value: string) {
        if (key === failedWrite) { failedWrite = null; throw new Error('Storage temporarily full') }
        store.set(key, String(value))
      },
      removeItem(key: string) { store.delete(key) },
    },
    fetch() { throw new Error('Unexpected network request') },
    WebSocket: class { constructor() { throw new Error('Unexpected socket') } },
  })
  function load(id: string): Record<string, unknown> {
    id = id.replace(/\.ts$/, '')
    if (id === './i18n.svelte') return { t: (key: string) => key }
    const existing = modules.get(id)
    if (existing) return existing
    assert.ok(moduleSources.has(id), `Unexpected module ${id}`)
    const exports: Record<string, unknown> = {}
    modules.set(id, exports)
    vm.runInContext(`(function(exports, require) {\n${moduleSources.get(id)}\n})`, context, { filename: id })(exports, load)
    return exports
  }
  return {
    prefs: load('./provider-alerts.svelte').providerAlertPreferences as AlertPreferences,
    transfer: load('./settings-transfer') as unknown as typeof Transfer,
    store, changes,
    failRead(key: string) { failedRead = key },
    failWrite(key: string) { failedWrite = key },
  }
}
const alertImport = (backendUrl: string, enabled: boolean, preferences = {}) => JSON.stringify({
  format: 'miboard-settings', version: 1, servers: [], deviceAliases: [], proxySort: [], preferences,
  providerAlerts: [{ backendUrl, enabled }],
})

test('successful alert import recovers from transient storage failures without resetting another backend', () => {
  const a = 'http://a.test:9090', b = 'http://b.test:9090'
  const s = preferenceSession([a, b])
  s.failRead(providerAlertsKey(a))
  assert.equal(s.prefs.enabled(a), true)
  assert.equal(s.prefs.memoryOnly(a), true)
  s.failWrite(providerAlertsKey(b))
  s.prefs.setEnabled(b, false)
  assert.equal(s.prefs.memoryOnly(b), true)

  s.transfer.applySettingsImport(s.transfer.previewSettingsImport(alertImport(a, false)))
  assert.deepEqual(JSON.parse(JSON.stringify(s.changes)), [[a]], 'Only a successfully imported backend is invalidated')
  assert.equal(s.prefs.enabled(a), false)
  assert.equal(s.prefs.memoryOnly(a), false)
  assert.equal(s.prefs.inspect(a, provider({ Download: 99, Upload: 0, Total: 100 }), now).length, 0)
  assert.equal(JSON.parse(s.store.get(providerAlertsKey(a))!).enabled, false, 'Inspection must not overwrite the imported opt-out')
  assert.equal(s.prefs.enabled(b), false, 'An unrelated unsaved choice remains in memory')
  assert.equal(s.prefs.memoryOnly(b), true)
  assert.equal(JSON.parse(s.store.get(providerAlertsKey(b))!).enabled, true)
})

test('a rolled-back settings import does not invalidate in-memory alert preferences', () => {
  const url = 'http://a.test:9090'
  const s = preferenceSession([url])
  s.store.set('miboard.theme', 'dark')
  s.failWrite(providerAlertsKey(url))
  s.prefs.setEnabled(url, false)
  const preview = s.transfer.previewSettingsImport(alertImport(url, true, { theme: 'light' }))
  s.failWrite('miboard.theme')
  assert.throws(() => s.transfer.applySettingsImport(preview), { code: 'storage' })
  assert.equal(s.changes.length, 0, 'A failure after the alert write emits no successful-import event')
  assert.equal(s.prefs.enabled(url), false)
  assert.equal(s.prefs.memoryOnly(url), true)
  assert.equal(JSON.parse(s.store.get(providerAlertsKey(url))!).enabled, true)
  assert.equal(s.store.get('miboard.theme'), 'dark')
})
