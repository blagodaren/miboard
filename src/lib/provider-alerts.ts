import type { ProxyProvider } from './api'

export const PROVIDER_ALERT_INTERVAL = 10 * 60 * 1000
export const PROVIDER_EXPIRY_WARNING = 3 * 24 * 60 * 60 * 1000
export type ProviderAlertKind = 'lowQuota' | 'exhausted' | 'expiring' | 'expired'
export type ProviderAlert = { provider: string; kind: ProviderAlertKind; remaining?: number; total?: number; expiresAt?: number }
export type ProviderAlertState = { enabled: boolean; seen: Record<string, string> }
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function readProviderAlertState(value: unknown): ProviderAlertState {
  const state: ProviderAlertState = { enabled: true, seen: {} }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state
  const source = value as Record<string, unknown>
  if (typeof source.enabled === 'boolean') state.enabled = source.enabled
  if (source.seen && typeof source.seen === 'object' && !Array.isArray(source.seen)) {
    for (const [key, fingerprint] of Object.entries(source.seen).slice(-1000)) {
      if (key.length <= 1024 && typeof fingerprint === 'string' && fingerprint.length <= 512) Object.defineProperty(state.seen, key, { value: fingerprint, writable: true, enumerable: true, configurable: true })
    }
  }
  return state
}

/** Only fresh reported values rearm a warning. Partial metadata does not erase deduplication. */
export function evaluateProviderAlerts(providers: Record<string, ProxyProvider>, previous: ProviderAlertState, now = Date.now()): { state: ProviderAlertState; alerts: ProviderAlert[] } {
  const state = readProviderAlertState(previous)
  const alerts: ProviderAlert[] = []
  if (!state.enabled || !Number.isFinite(now)) return { state, alerts }
  const apply = (provider: string, category: 'quota' | 'expiry', condition: string | null, alert?: ProviderAlert) => {
    const key = JSON.stringify([provider, category])
    if (condition === null) { delete state.seen[key]; return }
    if (state.seen[key] !== condition && alert) alerts.push(alert)
    state.seen[key] = condition
  }
  for (const [provider, source] of Object.entries(providers).slice(0, 500)) {
    if (!source || provider === 'default' || source.vehicleType === 'Compatible') continue
    const info = source.subscriptionInfo
    if (!info || typeof info !== 'object') continue
    const expiresAt = validNumber(info.Expire) && info.Expire > 0 && Number.isFinite(new Date(info.Expire * 1000).getTime()) ? info.Expire * 1000 : null
    if (validNumber(info.Download) && validNumber(info.Upload) && validNumber(info.Total) && info.Total > 0 && Number.isFinite(info.Download + info.Upload)) {
      const remaining = Math.max(0, info.Total - info.Download - info.Upload)
      const kind = remaining === 0 ? 'exhausted' : remaining / info.Total < .1 ? 'lowQuota' : null
      apply(provider, 'quota', kind ? JSON.stringify([kind, info.Total, expiresAt]) : null, kind ? { provider, kind, remaining, total: info.Total } : undefined)
    }
    if (expiresAt !== null) {
      const kind = expiresAt <= now ? 'expired' : expiresAt - now <= PROVIDER_EXPIRY_WARNING ? 'expiring' : null
      apply(provider, 'expiry', kind ? JSON.stringify([kind, expiresAt]) : null, kind ? { provider, kind, expiresAt } : undefined)
    }
  }
  // Bound persisted provider identities even after repeated subscription replacements.
  state.seen = Object.fromEntries(Object.entries(state.seen).slice(-1000))
  return { state, alerts }
}
