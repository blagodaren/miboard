import type { Proxy } from './api'

export type ProxySortKey = 'config' | 'latency' | 'name' | 'protocol'
export type ProxySortDirection = 'asc' | 'desc'
export type ProxySort = { key: ProxySortKey; direction: ProxySortDirection }

export const DEFAULT_PROXY_SORT: Readonly<ProxySort> = Object.freeze({ key: 'config', direction: 'asc' })

const STORAGE_PREFIX = 'miboard.proxy-sort.v1'
const SORT_KEYS = new Set<ProxySortKey>(['config', 'latency', 'name', 'protocol'])

function validSettings(value: unknown): value is ProxySort {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const settings = value as Record<string, unknown>
  return typeof settings.key === 'string' && SORT_KEYS.has(settings.key as ProxySortKey)
    && (settings.direction === 'asc' || settings.direction === 'desc')
}

function storageKey(backendUrl: string, group: string): string {
  // JSON tuple avoids collisions between backend addresses and arbitrary group names.
  return STORAGE_PREFIX + JSON.stringify([backendUrl, group])
}

export function readProxySort(backendUrl: string, group: string): ProxySort {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(backendUrl, group)) ?? 'null')
    if (validSettings(value)) return { key: value.key, direction: value.direction }
  } catch {
    // Private mode, unavailable storage and stale preferences use configuration order.
  }
  return { ...DEFAULT_PROXY_SORT }
}

export function saveProxySort(backendUrl: string, group: string, settings: ProxySort): void {
  const value = validSettings(settings) ? { key: settings.key, direction: settings.direction } : { ...DEFAULT_PROXY_SORT }
  try {
    localStorage.setItem(storageKey(backendUrl, group), JSON.stringify(value))
  } catch {
    // Sorting still applies for this session when preferences cannot be persisted.
  }
}

export function saveProxySortForGroups(backendUrl: string, groups: readonly string[], settings: ProxySort): void {
  const value = validSettings(settings) ? { key: settings.key, direction: settings.direction } : { ...DEFAULT_PROXY_SORT }
  for (const group of new Set(groups)) saveProxySort(backendUrl, group, value)
}

function comparableName(name: string): string {
  return name.replace(/^[^\p{L}\p{N}]+/u, '') || name
}

function latency(proxy: Proxy | undefined, measured?: { value: number | undefined }): { status: number; value: number } {
  const history = proxy?.history
  const value = measured ? measured.value : history?.[history.length - 1]?.delay
  if (typeof value !== 'number' || !Number.isFinite(value)) return { status: 2, value: 0 }
  return { status: value > 0 ? 0 : 1, value }
}

/** Presentation order only: group membership and API names are never changed. */
export function sortProxyNames(
  names: readonly string[],
  settings: ProxySort,
  metadata: (name: string) => Proxy | undefined,
  locale: string,
  delay?: (name: string) => number | undefined,
  isProvider?: (name: string) => boolean,
): string[] {
  const pinned: string[] = []
  let sortable: readonly string[] = names
  if (isProvider) {
    // Explicit configuration entries keep their order; only provider nodes are sortable.
    const providers: string[] = []
    const membership = new Map<string, boolean>()
    for (const name of names) {
      if (!membership.has(name)) membership.set(name, isProvider(name))
      if (membership.get(name)) providers.push(name)
      else pinned.push(name)
    }
    sortable = providers
  }
  if (settings.key === 'config') return [...pinned, ...sortable]

  const direction = settings.direction === 'desc' ? -1 : 1
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
  const rows = sortable.map((name, index) => {
    const proxy = settings.key === 'name' ? undefined : metadata(name)
    return { name, index, comparableName: comparableName(name), protocol: proxy?.type?.trim() ?? '', latency: latency(proxy, delay ? { value: delay(name) } : undefined) }
  })

  rows.sort((a, b) => {
    let result = 0
    if (settings.key === 'latency') {
      // Unreachable and untested nodes stay behind measured nodes in both directions.
      result = a.latency.status - b.latency.status
      if (!result && a.latency.status === 0) result = direction * (a.latency.value - b.latency.value)
    } else if (settings.key === 'protocol') {
      result = Number(!a.protocol) - Number(!b.protocol)
      if (!result) {
        result = direction * (collator.compare(a.protocol, b.protocol)
          || collator.compare(a.comparableName, b.comparableName))
      }
    } else {
      result = direction * collator.compare(a.comparableName, b.comparableName)
    }
    return result || a.index - b.index
  })
  return [...pinned, ...rows.map((row) => row.name)]
}
