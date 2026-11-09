import type { Proxy, ProxyProvider } from './api'

export function visibleProxyProviders(providers: Record<string, ProxyProvider>): Array<{ name: string; provider: ProxyProvider }> {
  return Object.entries(providers)
    .filter(([name, provider]) => name !== 'default' && provider.vehicleType !== 'Compatible')
    .map(([name, provider]) => ({ name, provider }))
}

const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function providerSubscription(info: ProxyProvider['subscriptionInfo']) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const download = nonnegative(info.Download)
  const upload = nonnegative(info.Upload)
  const totalValue = nonnegative(info.Total)
  const expiryValue = nonnegative(info.Expire)
  const used = download !== null && upload !== null && Number.isFinite(download + upload) ? download + upload : null
  const total = totalValue !== null && totalValue > 0 ? totalValue : null
  const expiresAt = expiryValue !== null && expiryValue > 0 && Number.isFinite(new Date(expiryValue * 1000).getTime()) ? expiryValue * 1000 : null
  if (download === null && upload === null && total === null && expiresAt === null) return null
  return { download, upload, used, total, remaining: used !== null && total !== null ? Math.max(0, total - used) : null, expiresAt }
}

/** Go API timestamps are RFC3339; Date.parse alone also accepts ambiguous/normalized invalid dates. */
export function providerUpdatedAt(value?: unknown): number | null {
  if (typeof value !== 'string' || value.startsWith('0001-')) return null
  const parts = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!parts) return null
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3])
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export type ProviderNodeHealth = {
  name: string
  type: string
  status: 'alive' | 'dead' | 'unknown'
  delay: number | null
  checkedAt: number | null
  source: 'url' | 'history' | 'none'
}

/** Boolean alive defaults to true in mihomo, so only a recorded result proves a check happened. */
export function providerNodeHealth(node: Proxy, testUrl?: string): ProviderNodeHealth {
  const unknown: ProviderNodeHealth = { name: node.name, type: typeof node.type === 'string' ? node.type : '', status: 'unknown', delay: null, checkedAt: null, source: 'none' }
  const url = typeof testUrl === 'string' ? testUrl.trim() : ''
  const extra = node.extra && typeof node.extra === 'object' && !Array.isArray(node.extra) ? node.extra : null
  let history = node.history
  let source: ProviderNodeHealth['source'] = 'history'
  if (url && extra && Object.hasOwn(extra, url)) {
    history = extra[url]?.history
    source = 'url'
  } else if (url && extra && Object.keys(extra).length) {
    // Another group's check must not become this provider's result.
    return unknown
  }
  if (!Array.isArray(history) || !history.length) return unknown
  const latest = history[history.length - 1]
  if (!latest || typeof latest !== 'object') return unknown
  const delay = nonnegative(latest.delay)
  if (delay === null) return unknown
  return { ...unknown, status: delay > 0 ? 'alive' : 'dead', delay, checkedAt: providerUpdatedAt(latest.time), source }
}

export function providerHealthSummary(provider: ProxyProvider) {
  const proxies = Array.isArray(provider.proxies) ? provider.proxies : []
  const nodes = proxies.filter((node) => node && typeof node.name === 'string').map((node) => providerNodeHealth(node, provider.testUrl))
  let alive = 0, dead = 0, unknown = 0
  let lastCheckedAt: number | null = null
  for (const node of nodes) {
    if (node.status === 'alive') alive++
    else if (node.status === 'dead') dead++
    else unknown++
    if (node.checkedAt !== null) lastCheckedAt = Math.max(lastCheckedAt ?? node.checkedAt, node.checkedAt)
  }
  return { total: nodes.length, alive, dead, unknown, lastCheckedAt, nodes }
}

export function providerQuotaStatus(info: ProxyProvider['subscriptionInfo'], now = Date.now()) {
  const subscription = providerSubscription(info)
  return {
    ratio: subscription?.used !== null && subscription?.used !== undefined && subscription.total !== null
      ? Math.min(1, subscription.used / subscription.total) : null,
    expired: subscription?.expiresAt !== null && subscription?.expiresAt !== undefined && Number.isFinite(now)
      ? subscription.expiresAt <= now : null,
    exhausted: subscription?.remaining !== null && subscription?.remaining !== undefined ? subscription.remaining === 0 : null,
  }
}

export class ProviderRefreshError extends Error {}
export class ProviderHealthRefreshError extends Error {}

/** A successful PUT is not presented as updated until fresh metadata has arrived. */
export async function updateProxyProvider(
  name: string,
  send: (path: string, init: { method: string; signal: AbortSignal }) => Promise<unknown>,
  reload: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  await send(`/providers/proxies/${encodeURIComponent(name)}`, { method: 'PUT', signal })
  if (signal.aborted) return
  const refreshed = await reload(signal)
  if (!signal.aborted && !refreshed) throw new ProviderRefreshError('Provider metadata refresh failed')
}

/** Native health checks wait for core checks to finish; metadata determines individual node outcomes. */
export async function healthCheckProxyProvider(
  name: string,
  send: (path: string, init: { method: string; signal: AbortSignal }) => Promise<unknown>,
  reload: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  await send(`/providers/proxies/${encodeURIComponent(name)}/healthcheck`, { method: 'GET', signal })
  if (signal.aborted) return
  const refreshed = await reload(signal)
  if (!signal.aborted && !refreshed) throw new ProviderHealthRefreshError('Provider health metadata refresh failed')
}
