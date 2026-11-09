import type { Proxy, ProxyProvider } from './api'
import { isBulkLatencyNode, type DelayTarget } from './latency.ts'

export const PROXY_TEST_SELECTION_PREFIX = 'miboard.proxy-test-selection.v1.'
export type ProxyTestSelection = { mode: 'all' | 'selected'; groups: string[] }
export const proxyTestSelectionKey = (backendUrl: string) => PROXY_TEST_SELECTION_PREFIX + encodeURIComponent(backendUrl)

export function validProxyTestSelection(value: unknown): value is ProxyTestSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as ProxyTestSelection
  return (candidate.mode === 'all' || candidate.mode === 'selected') && Array.isArray(candidate.groups)
    && candidate.groups.length <= 5000 && candidate.groups.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 1024)
}

export function readProxyTestSelection(backendUrl: string): ProxyTestSelection {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(proxyTestSelectionKey(backendUrl)) ?? 'null')
    if (validProxyTestSelection(value)) return { mode: value.mode, groups: [...new Set(value.groups)] }
  } catch { /* Use a session preference when storage is unavailable. */ }
  return { mode: 'all', groups: [] }
}

export function saveProxyTestSelection(backendUrl: string, value: ProxyTestSelection): boolean {
  if (!validProxyTestSelection(value)) return false
  try {
    localStorage.setItem(proxyTestSelectionKey(backendUrl), JSON.stringify({ mode: value.mode, groups: [...new Set(value.groups)] }))
    return true
  } catch { return false }
}

export type ProxyEndpoint = { node: Proxy; target: DelayTarget }
export const proxyEndpointKey = (target: DelayTarget) => JSON.stringify([target.provider ?? null, target.name])

/** Provider names are part of identity. A group API only returns member names,
 * so ownership cannot be inferred when multiple providers reuse that name. */
export function proxyCatalog(proxies: Record<string, Proxy>, providers: Record<string, ProxyProvider>) {
  const byName = new Map<string, ProxyEndpoint[]>()
  const entries: ProxyEndpoint[] = []
  for (const [provider, data] of Object.entries(providers)) {
    if (provider === 'default' || data.vehicleType === 'Compatible') continue
    for (const node of data.proxies ?? []) {
      const entry = { node, target: { name: node.name, provider } }
      const values = byName.get(node.name) ?? []
      if (values.some((value) => value.target.provider === provider)) continue
      values.push(entry)
      byName.set(node.name, values)
      entries.push(entry)
    }
  }
  const ambiguous = (name: string) => !proxies[name]?.all && (byName.get(name)?.length ?? 0) > 1
  function resolve(name: string): ProxyEndpoint | undefined {
    const root = proxies[name]
    if (root?.all) return { node: root, target: { name } }
    const values = byName.get(name) ?? []
    if (values.length > 1) return undefined
    const hint = root?.['provider-name']
    if (hint === 'default' || (hint && providers[hint]?.vehicleType === 'Compatible')) return root ? { node: root, target: { name } } : undefined
    if (values.length === 1) return values[0]
    return root ? { node: root, target: { name } } : undefined
  }
  const lookup = (name: string) => resolve(name)?.node
  const providerNode = (provider: string, name: string) => byName.get(name)?.find((entry) => entry.target.provider === provider)?.node
  const all = new Map(entries.filter((entry) => isBulkLatencyNode(entry.node)).map((entry) => [proxyEndpointKey(entry.target), entry]))
  for (const node of Object.values(proxies)) {
    const hint = node['provider-name']
    if ((hint === 'default' || (hint && providers[hint]?.vehicleType === 'Compatible')) && isBulkLatencyNode(node)) {
      const target = { name: node.name }
      all.set(proxyEndpointKey(target), { node, target })
      continue
    }
    const resolved = resolve(node.name)
    if (resolved && isBulkLatencyNode(resolved.node)) all.set(proxyEndpointKey(resolved.target), resolved)
  }
  function members(groupNames: readonly string[]) {
    const result = new Map<string, ProxyEndpoint>()
    const ambiguousNames = new Set<string>()
    const seen = new Set<string>()
    function visit(name: string) {
      if (seen.has(name)) return
      seen.add(name)
      if (proxies[name]?.all) { for (const child of proxies[name].all!) visit(child); return }
      if (ambiguous(name)) { ambiguousNames.add(name); return }
      const entry = resolve(name)
      if (entry && isBulkLatencyNode(entry.node)) result.set(proxyEndpointKey(entry.target), entry)
    }
    for (const name of groupNames) visit(name)
    return { entries: [...result.values()], ambiguousNames: [...ambiguousNames] }
  }
  return { resolve, lookup, ambiguous, providerNode, all: [...all.values()], members }
}
