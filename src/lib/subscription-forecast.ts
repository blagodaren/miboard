import type { ProxyProvider } from './api'

export const FORECAST_DAY = 86_400_000
export const FORECAST_STALE = 3 * FORECAST_DAY
export const FORECAST_MIN_SPAN = 15 * 60_000
export const FORECAST_RETENTION = 30 * FORECAST_DAY
export const FORECAST_POINTS = 32
export type SubscriptionSample = { at: number; used: number; total: number; expiresAt: number | null }
export type ForecastResult = { state: 'missing' | 'learning' | 'stale' | 'noRate' | 'expired' | 'exhausted' | 'ready'; bytesPerDay?: number; daysLeft?: number; quotaDays?: number; limitedByExpiry?: boolean; sampledAt?: number }
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
export function subscriptionSample(provider: ProxyProvider, now = Date.now()): SubscriptionSample | null {
  const info = provider.subscriptionInfo, updated = provider.updatedAt
  if (!info || !numeric(info.Download) || !numeric(info.Upload) || !numeric(info.Total) || !info.Total
    || typeof updated !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(updated) || updated.startsWith('0001-')) return null
  const at = Date.parse(updated), used = info.Download + info.Upload
  if (!Number.isFinite(at) || at > now + 300_000 || !Number.isSafeInteger(used) || used < 0) return null
  const expiresAt = numeric(info.Expire) && info.Expire > 0 && Number.isFinite(info.Expire * 1000) ? info.Expire * 1000 : null
  return { at, used, total: info.Total, expiresAt }
}
export function readSubscriptionSamples(value: unknown, now = Date.now()): SubscriptionSample[] {
  if (!Array.isArray(value)) return []
  const samples = value.filter((sample): sample is SubscriptionSample => !!sample && typeof sample === 'object'
    && numeric(sample.at) && sample.at >= now - FORECAST_RETENTION && sample.at <= now + 300_000
    && numeric(sample.used) && numeric(sample.total) && sample.total > 0 && (sample.expiresAt === null || numeric(sample.expiresAt)))
    .sort((a, b) => a.at - b.at).slice(-FORECAST_POINTS)
  let result: SubscriptionSample[] = []
  for (const sample of samples) result = appendSubscriptionSample(result, sample)
  return result
}
/** Polling cached provider metadata never creates a new sample or freshens its age. */
export function appendSubscriptionSample(samples: readonly SubscriptionSample[], sample: SubscriptionSample): SubscriptionSample[] {
  const last = samples.at(-1)
  if (last && sample.at <= last.at) return [...samples]
  const reset = !!last && (sample.used < last.used || sample.total !== last.total || sample.expiresAt !== last.expiresAt)
  return [...(reset ? [] : samples.filter(row => row.at >= sample.at - FORECAST_RETENTION)), { ...sample }].slice(-FORECAST_POINTS)
}
export function subscriptionForecast(samples: readonly SubscriptionSample[], now = Date.now()): ForecastResult {
  const last = samples.at(-1)
  if (!last) return { state: 'missing' }
  if (last.expiresAt !== null && last.expiresAt <= now) return { state: 'expired', sampledAt: last.at }
  if (now - last.at > FORECAST_STALE) return { state: 'stale', sampledAt: last.at }
  if (last.used >= last.total) return { state: 'exhausted', sampledAt: last.at }
  const first = samples.find(row => last.at - row.at >= FORECAST_MIN_SPAN && row.at >= now - FORECAST_RETENTION)
  if (!first) return { state: 'learning', sampledAt: last.at }
  const bytesPerDay = (last.used - first.used) / ((last.at - first.at) / FORECAST_DAY)
  if (bytesPerDay <= 0 || !Number.isFinite(bytesPerDay)) return { state: 'noRate', sampledAt: last.at }
  // Project from the metadata timestamp, not from browser poll time.
  const quotaDays = Math.max(0, (last.total - last.used) / bytesPerDay - (now - last.at) / FORECAST_DAY)
  const expiryDays = last.expiresAt === null ? Infinity : (last.expiresAt - now) / FORECAST_DAY
  return { state: 'ready', bytesPerDay, quotaDays, daysLeft: Math.min(quotaDays, expiryDays), limitedByExpiry: expiryDays < quotaDays, sampledAt: last.at }
}

export const forecastStorageKey = (backend: string) => `miboard.forecast.v1:${encodeURIComponent(backend)}`
export class SubscriptionForecastStore {
  #storage: Pick<Storage, 'getItem' | 'setItem'> | undefined
  #cache = new Map<string, Record<string, SubscriptionSample[]>>()
  memoryOnly = false
  constructor(storage?: Pick<Storage, 'getItem' | 'setItem'>) { this.#storage = storage }
  inspect(backend: string, providerName: string, provider: ProxyProvider, now = Date.now()): ForecastResult {
    if (!backend || providerName.length > 160 || providerName === 'default' || provider.vehicleType === 'Compatible') return { state: 'missing' }
    let data = this.#cache.get(backend)
    if (!data) {
      data = Object.create(null) as Record<string, SubscriptionSample[]>
      try {
        const text = this.#storage?.getItem(forecastStorageKey(backend))
        const saved = text && text.length <= 256 * 1024 ? JSON.parse(text) : null
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) for (const [name, samples] of Object.entries(saved).slice(0, 64)) {
          if (name.length <= 160) data[name] = readSubscriptionSamples(samples, now)
        }
      } catch { this.memoryOnly = true }
      if (this.#cache.size >= 8) this.#cache.delete(this.#cache.keys().next().value!)
      this.#cache.set(backend, data)
    }
    const sample = subscriptionSample(provider, now)
    if (!sample) return { state: 'missing' }
    const previous = Object.hasOwn(data, providerName) ? data[providerName] : []
    if (sample.at !== previous.at(-1)?.at) {
      if (!Object.hasOwn(data, providerName) && Object.keys(data).length >= 64) delete data[Object.keys(data)[0]]
      data[providerName] = appendSubscriptionSample(previous, sample)
      try {
        if (!this.#storage) throw new Error('Storage unavailable')
        const serialized = JSON.stringify(data)
        if (serialized.length > 256 * 1024) throw new Error('Forecast history full')
        this.#storage.setItem(forecastStorageKey(backend), serialized)
      } catch { this.memoryOnly = true }
    }
    return subscriptionForecast(data[providerName], now)
  }
}
