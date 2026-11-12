import type { Proxy } from './api'

export const BROWSER_ALERTS_KEY = 'miboard.browser-alerts.v1'
export const BROWSER_ALERTS_EVENT = 'miboard:browser-alerts'
export type BrowserAlertPreferences = { enabled: boolean; nodes: boolean; core: boolean; subscriptions: boolean }
export function readBrowserAlertPreferences(value: unknown): BrowserAlertPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { enabled: source.enabled === true, nodes: source.nodes !== false, core: source.core !== false, subscriptions: source.subscriptions !== false }
}
export const sameBrowserAlertPreferences = (a: BrowserAlertPreferences, b: BrowserAlertPreferences): boolean =>
  a.enabled === b.enabled && a.nodes === b.nodes && a.core === b.core && a.subscriptions === b.subscriptions
type PreferenceListener = (value: BrowserAlertPreferences, saved: boolean) => void
/** Failed persistence never reverses an explicit choice made in this tab. */
export class BrowserAlertPreferenceStore {
  #value: BrowserAlertPreferences | null = null
  #saved = true
  #listeners = new Set<PreferenceListener>()
  #read: () => unknown
  #write: (value: BrowserAlertPreferences) => void
  constructor(read: () => unknown, write: (value: BrowserAlertPreferences) => void) { this.#read = read; this.#write = write }
  load(): BrowserAlertPreferences {
    if (!this.#value) {
      try { this.#value = readBrowserAlertPreferences(this.#read()) }
      catch { this.#value = readBrowserAlertPreferences(null); this.#saved = false }
    }
    return this.#value
  }
  get saved() { this.load(); return this.#saved }
  #commit(value: BrowserAlertPreferences, saved: boolean) {
    const changed = !sameBrowserAlertPreferences(this.load(), value)
    const storageChanged = this.#saved !== saved
    if (changed) this.#value = value
    this.#saved = saved
    if (changed || storageChanged) for (const listener of this.#listeners) listener(this.#value!, saved)
  }
  save(value: BrowserAlertPreferences): boolean {
    const next = readBrowserAlertPreferences(value)
    let saved = true
    try { this.#write(next) } catch { saved = false }
    this.#commit(next, saved)
    return saved
  }
  storageChanged(key: string | null): void {
    if ((key !== BROWSER_ALERTS_KEY && key !== null) || !this.saved) return
    try { this.#commit(readBrowserAlertPreferences(this.#read()), true) }
    catch { /* Keep the current choice if browser storage becomes unreadable. */ }
  }
  subscribe(listener: PreferenceListener): () => void {
    this.#listeners.add(listener); listener(this.load(), this.#saved)
    return () => { this.#listeners.delete(listener) }
  }
}
let preferenceStore: BrowserAlertPreferenceStore | undefined
function sharedPreferences(): BrowserAlertPreferenceStore {
  return preferenceStore ??= new BrowserAlertPreferenceStore(
    () => JSON.parse(localStorage.getItem(BROWSER_ALERTS_KEY) ?? 'null'),
    value => localStorage.setItem(BROWSER_ALERTS_KEY, JSON.stringify(value)),
  )
}
export function loadBrowserAlertPreferences(): BrowserAlertPreferences { return sharedPreferences().load() }
export function subscribeBrowserAlertPreferences(listener: PreferenceListener): () => void {
  const store = sharedPreferences()
  // Catch changes made while neither settings nor the monitor was mounted.
  store.storageChanged(BROWSER_ALERTS_KEY)
  const unsubscribe = store.subscribe(listener)
  const storage = (event: StorageEvent) => { store.storageChanged(event.key) }
  window.addEventListener('storage', storage)
  return () => { unsubscribe(); window.removeEventListener('storage', storage) }
}
export function saveBrowserAlertPreferences(value: BrowserAlertPreferences): boolean {
  const saved = sharedPreferences().save(value)
  window.dispatchEvent(new CustomEvent(BROWSER_ALERTS_EVENT, { detail: sharedPreferences().load() }))
  return saved
}
export function browserNotificationsAvailable(): boolean {
  return typeof Notification !== 'undefined' && globalThis.isSecureContext === true
}
export async function showBrowserNotification(title: string, body: string, tag: string, route = '#/proxies', signal?: AbortSignal, sourceUrl?: string): Promise<boolean> {
  const permitted = () => !signal?.aborted && browserNotificationsAvailable() && Notification.permission === 'granted'
  if (!permitted()) return false
  try {
    // Alerts may outlive the selected backend. The fleet is safe to open from any
    // tab; never silently show another core's details or put secrets in a URL.
    if (sourceUrl) {
      const source = new URL(sourceUrl)
      title = `${title} · ${source.host}${source.pathname === '/' ? '' : source.pathname}`
      route = '#/fleet'
    }
    const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
    if (!permitted()) return false
    if (registration?.active) await registration.showNotification(title, { body, tag, data: { route } })
    else {
      const notice = new Notification(title, { body, tag })
      notice.onclick = () => { window.focus(); location.hash = route; notice.close() }
    }
    return !signal?.aborted
  } catch { return false }
}

/** Repeated polling of a cached failure is not a second failed health check. */
export class NodeFailureTracker {
  #nodes = new Map<string, { time: number; failures: number; armed: boolean }>()
  inspect(proxies: Record<string, Proxy>, now = Date.now()): string[] {
    const result: string[] = []
    const present = new Set<string>()
    for (const [name, node] of Object.entries(proxies).slice(0, 10000)) {
      if (!node || node.all || ['Direct', 'Reject', 'Compatible', 'Pass'].includes(node.type)) continue
      present.add(name)
      const sample = node.history?.at(-1)
      if (!sample || !Number.isFinite(sample.delay) || sample.delay < 0) continue
      const time = Date.parse(sample.time)
      if (!Number.isFinite(time) || now - time > 5 * 60_000 || time > now + 10_000) continue
      const previous = this.#nodes.get(name)
      if (previous && time <= previous.time) continue
      if (sample.delay > 0) this.#nodes.set(name, { time, failures: 0, armed: true })
      else {
        const state = { time, failures: Math.min(2, (previous?.failures ?? 0) + 1), armed: previous?.armed ?? false }
        if (state.failures >= 2 && state.armed) { result.push(name); state.armed = false }
        this.#nodes.set(name, state)
      }
    }
    for (const name of this.#nodes.keys()) if (!present.has(name)) this.#nodes.delete(name)
    return result
  }
}
