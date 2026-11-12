import type { ProxyProvider } from './api'
import { SubscriptionForecastStore } from './subscription-forecast'

let storage: Storage | undefined
try { storage = localStorage } catch { /* The forecast component reports temporary history. */ }
export const subscriptionForecasts = new SubscriptionForecastStore(storage)
/** Reuses already-fetched metadata; never updates a provider or adds network traffic. */
export function observeSubscriptionForecasts(backend: string, providers: Record<string, ProxyProvider>, now = Date.now()): void {
  for (const [name, provider] of Object.entries(providers).slice(0, 64)) {
    if (provider && typeof provider === 'object') subscriptionForecasts.inspect(backend, name, provider, now)
  }
}
