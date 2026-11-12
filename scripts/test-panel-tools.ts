import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeConnectionBatch, csvDocument, matchesConnectionScope, virtualRange } from '../src/lib/table-tools.ts'
import { BROWSER_ALERTS_KEY, BrowserAlertPreferenceStore, NodeFailureTracker, readBrowserAlertPreferences, showBrowserNotification } from '../src/lib/browser-alerts.ts'
import { shortcutAction } from '../src/lib/keyboard-shortcuts.ts'
import type { Connection, Proxy } from '../src/lib/api.ts'

test('device/domain/node matching uses exact identity, not substrings', () => {
  const c = { metadata: { sourceIP: '::ffff:192.168.1.2', host: 'Sub.Example.com.', sniffHost: '', destinationIP: '1.2.3.4' }, chains: ['Group', 'Node A'] } as Connection
  assert(matchesConnectionScope(c, 'device', '192.168.1.2'))
  assert(!matchesConnectionScope(c, 'device', '192.168.1.20'))
  assert(matchesConnectionScope(c, 'domain', 'sub.example.com'))
  assert(!matchesConnectionScope(c, 'domain', 'example.com'))
  assert(matchesConnectionScope(c, 'node', 'Node A'))
  assert(!matchesConnectionScope(c, 'node', 'Node'))
})
test('batch closes more than rendered rows, bounds parallelism and reports partial errors', async () => {
  const ids = Array.from({ length: 350 }, (_, i) => String(i))
  let inFlight = 0, maximum = 0
  const result = await closeConnectionBatch([...ids, '0'], async id => {
    maximum = Math.max(maximum, ++inFlight)
    await new Promise(resolve => setTimeout(resolve, 0)); --inFlight
    if (id === '4') throw { status: 404 }
    if (id === '9') throw new Error('offline')
  }, new AbortController().signal)
  assert.equal(result.succeeded.length, 349)
  assert.deepEqual(result.failed, ['9'])
  assert.equal(result.pending.length, 0)
  assert(maximum <= 4)
})
test('cancellation preserves unconfirmed and unstarted targets', async () => {
  const controller = new AbortController()
  const result = await closeConnectionBatch(['a', 'b', 'c', 'd', 'e', 'f'], async () => { controller.abort(); throw new Error('cancelled') }, controller.signal)
  assert.equal(result.succeeded.length, 0)
  assert.equal(result.failed.length, 0)
  assert.equal(result.pending.length, 6)
  assert.equal(new Set(result.pending).size, 6)
})
test('CSV protects formula cells and preserves commas, quotes, newlines and Unicode', () => {
  const csv = csvDocument(['name'], [['=WEBSERVICE("bad")'], [' \t+1'], ['обычный,текст\nстрока'], ['@SUM(A1)']])
  assert(csv.startsWith('\uFEFF'))
  assert(csv.includes('"\'=WEBSERVICE(""bad"")"'))
  assert(csv.includes('"\' \t+1"'))
  assert(csv.includes('"обычный,текст\nстрока"'))
  assert(csv.includes('"\'@SUM(A1)"'))
})
test('virtual window reaches the last item without rendering the entire table', () => {
  const first = virtualRange(10000, 0, 600)
  const last = virtualRange(10000, 10000 * 64 - 600, 600)
  assert.equal(first.start, 0)
  assert(first.end < 40)
  assert.equal(last.end, 10000)
  assert.equal(last.bottom, 0)
  assert.equal(last.top + (last.end - last.start) * 64, 10000 * 64)
})
test('node alert requires two distinct fresh failed checks after success and rearms on recovery', () => {
  const tracker = new NodeFailureTracker(), now = Date.now()
  const inspect = (delay: number, time: number) => tracker.inspect({ Node: { name: 'Node', type: 'Shadowsocks', history: [{ delay, time: new Date(time).toISOString() }] } as Proxy }, now)
  assert.deepEqual(inspect(0, now - 5000), [])
  assert.deepEqual(inspect(10, now - 4000), [])
  assert.deepEqual(inspect(0, now - 3000), [])
  assert.deepEqual(inspect(0, now - 3000), [])
  assert.deepEqual(inspect(0, now - 2000), ['Node'])
  assert.deepEqual(inspect(0, now - 1000), [])
  assert.deepEqual(inspect(10, now), [])
  assert.deepEqual(inspect(0, now + 1000), [])
  assert.deepEqual(inspect(0, now + 2000), ['Node'])
})
test('stale health data cannot trigger node notifications', () => {
  const tracker = new NodeFailureTracker(), now = Date.now()
  const proxy = { name: 'Node', type: 'Shadowsocks', history: [{ delay: 0, time: new Date(now - 600000).toISOString() }] } as Proxy
  assert.deepEqual(tracker.inspect({ Node: proxy }, now), [])
  assert.equal(readBrowserAlertPreferences({ enabled: 'yes' }).enabled, false)
})
test('shortcuts leave text input, native modifiers and modal interactions alone', () => {
  const event = { key: '2', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false }
  assert.equal(shortcutAction(event, false, false), 'proxies')
  assert.equal(shortcutAction({ ...event, key: '™', code: 'Digit2' }, false, false), 'proxies')
  assert.equal(shortcutAction(event, true, false), null)
  assert.equal(shortcutAction(event, false, true), null)
  assert.equal(shortcutAction({ ...event, ctrlKey: true }, false, false), null)
  assert.equal(shortcutAction({ ...event, altKey: false, key: '/' }, false, false), 'search')
})

test('unrelated storage and identical preference writes never restart monitor subscriptions', () => {
  let persisted = { enabled: true, nodes: true, core: true, subscriptions: true }
  const store = new BrowserAlertPreferenceStore(() => persisted, value => { persisted = { ...value } })
  let changes = 0
  const unsubscribe = store.subscribe(() => { changes++ })
  assert.equal(changes, 1)
  store.storageChanged('miboard.forecast.v1:fixture')
  store.storageChanged(BROWSER_ALERTS_KEY)
  store.save({ ...persisted })
  assert.equal(changes, 1)
  persisted = { ...persisted, nodes: false }
  store.storageChanged(BROWSER_ALERTS_KEY)
  assert.equal(changes, 2); assert.equal(store.load().nodes, false)
  unsubscribe()
})

test('quota failure preserves explicit opt-out across reads, remounts and storage events', () => {
  let persisted = { enabled: true, nodes: true, core: true, subscriptions: true }
  let fails = true
  const store = new BrowserAlertPreferenceStore(() => persisted, value => {
    if (fails) throw new Error('Quota exceeded')
    persisted = { ...value }
  })
  const delivered: boolean[] = []
  store.subscribe(value => { delivered.push(value.enabled) })
  assert.equal(store.save({ ...persisted, enabled: false }), false)
  assert.equal(store.saved, false)
  assert.equal(store.load().enabled, false)
  store.storageChanged('another setting')
  store.storageChanged(BROWSER_ALERTS_KEY)
  store.storageChanged(null)
  assert.equal(store.load().enabled, false)
  let remounted = true
  store.subscribe(value => { remounted = value.enabled })()
  assert.equal(remounted, false)
  assert.deepEqual(delivered, [true, false])
  fails = false
  assert.equal(store.save(store.load()), true)
  assert.equal(persisted.enabled, false)
  persisted = { ...persisted, enabled: true }
  store.storageChanged(BROWSER_ALERTS_KEY)
  assert.equal(store.load().enabled, true, 'A fresh cross-tab choice is accepted after persistence recovers')
})

test('a real storage clear disables saved alerts but cannot erase an unsaved local decision', () => {
  let persisted: unknown = { enabled: true }
  const store = new BrowserAlertPreferenceStore(() => persisted, value => { persisted = value })
  assert.equal(store.load().enabled, true)
  persisted = null
  store.storageChanged(null)
  assert.equal(store.load().enabled, false)
})

test('notification delivery rechecks cancellation after awaiting the service worker', async () => {
  const names = ['Notification', 'navigator', 'isSecureContext'] as const
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  let release!: (value: unknown) => void
  let shown = 0
  const registration = { active: {}, async showNotification() { shown++ } }
  const waiting = new Promise(resolve => { release = resolve })
  try {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted' } })
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { getRegistration: () => waiting } } })
    const abort = new AbortController()
    const operation = showBrowserNotification('Title', 'Body', 'tag', '#/proxies', abort.signal)
    abort.abort(); release(registration)
    assert.equal(await operation, false)
    assert.equal(shown, 0)
  } finally {
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test('core-bound notifications identify the source and open the fleet without leaking URL secrets', async () => {
  const names = ['Notification', 'navigator', 'isSecureContext'] as const
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const displayed: Array<{ title: string; options: NotificationOptions }> = []
  try {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: { permission: 'granted' } })
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { async getRegistration() { return {
      active: {}, async showNotification(title: string, options: NotificationOptions) { displayed.push({ title, options }) },
    } } } } })
    assert.equal(await showBrowserNotification('Offline', 'Body', 'tag', '#/settings?category=core', undefined, 'https://user:PRIVATE@router.example:9443/api?secret=PRIVATE'), true)
    assert.equal(displayed[0].title, 'Offline · router.example:9443/api')
    assert.equal(displayed[0].options.data.route, '#/fleet')
    assert.ok(!JSON.stringify(displayed).includes('PRIVATE'))
  } finally {
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
