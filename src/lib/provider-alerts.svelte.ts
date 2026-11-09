import type { ProxyProvider } from './api'
import { evaluateProviderAlerts, readProviderAlertState, type ProviderAlertState } from './provider-alerts'

class ProviderAlertPreferences {
  #revision = $state(0)
  #states = new Map<string, ProviderAlertState>()
  #memoryOnly = new Set<string>()
  #key(url: string) { return `miboard.provider-alerts:${encodeURIComponent(url)}` }
  #load(url: string) {
    let state = this.#states.get(url)
    if (!state) {
      try { state = readProviderAlertState(JSON.parse(localStorage.getItem(this.#key(url)) ?? 'null')) }
      catch { state = readProviderAlertState(null); this.#memoryOnly.add(url) }
      this.#states.set(url, state)
    }
    return state
  }
  enabled(url: string) { this.#revision; return this.#load(url).enabled }
  memoryOnly(url: string) { this.#revision; this.#load(url); return this.#memoryOnly.has(url) }
  #save(url: string, state: ProviderAlertState) {
    this.#states.set(url, state)
    try { localStorage.setItem(this.#key(url), JSON.stringify(state)); this.#memoryOnly.delete(url) }
    catch { this.#memoryOnly.add(url) }
    this.#revision++
  }
  setEnabled(url: string, enabled: boolean) { this.#save(url, { ...this.#load(url), enabled }) }
  inspect(url: string, providers: Record<string, ProxyProvider>, now = Date.now()) {
    const previous = this.#load(url)
    const result = evaluateProviderAlerts(providers, previous, now)
    if (JSON.stringify(previous) !== JSON.stringify(result.state)) this.#save(url, result.state)
    return result.alerts
  }
}

export const providerAlertPreferences = new ProviderAlertPreferences()
