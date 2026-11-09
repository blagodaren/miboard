import type { ProxyProvider } from './api'

export function visibleProxyProviders(providers: Record<string, ProxyProvider>): Array<{ name: string; provider: ProxyProvider }> {
  return Object.entries(providers)
    .filter(([name, provider]) => name !== 'default' && provider.vehicleType !== 'Compatible')
    .map(([name, provider]) => ({ name, provider }))
}

const nonnegative = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export function providerSubscription(info: ProxyProvider['subscriptionInfo']) {
  if (!info) return null
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

export function providerUpdatedAt(value?: string): number | null {
  if (!value || value.startsWith('0001-')) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export class ProviderRefreshError extends Error {}

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
