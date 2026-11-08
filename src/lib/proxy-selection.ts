import type { Proxy } from './api'

export const SELECTABLE_PROXY_TYPES: ReadonlySet<string> = new Set(['Selector', 'Fallback'])

export type ProxySelectionPlan = {
  node: string
  targets: string[]
  unchanged: string[]
  missing: string[]
  unsupported: string[]
  unsafe: string[]
}

/** Plan exact member selections without changing the source data or resolving a leaf. */
export function planProxySelection(
  proxies: Readonly<Record<string, Proxy>>,
  sourceName: string,
): ProxySelectionPlan {
  const result: ProxySelectionPlan = { node: '', targets: [], unchanged: [], missing: [], unsupported: [], unsafe: [] }
  const source = proxies[sourceName]
  if (!source || !Array.isArray(source.all) || typeof source.now !== 'string'
    || !source.now || !source.all.includes(source.now)) return result

  result.node = source.now
  // Every changed group will point to the same member. A group on that member's
  // existing selected path must keep its old edge, otherwise it would point back
  // to itself. Other candidates cannot change that path and are independent.
  const selectedPath = new Set<string>()
  let current = result.node
  let cyclic = false
  while (current) {
    if (selectedPath.has(current)) { cyclic = true; break }
    selectedPath.add(current)
    const proxy = proxies[current]
    if (!proxy || !Array.isArray(proxy.all) || !proxy.now) break
    current = proxy.now
  }

  for (const [name, proxy] of Object.entries(proxies)) {
    if (name === sourceName || !Array.isArray(proxy.all)) continue
    if (!proxy.all.includes(result.node)) result.missing.push(name)
    else if (!SELECTABLE_PROXY_TYPES.has(proxy.type)) result.unsupported.push(name)
    else if (name === result.node) result.unsafe.push(name)
    else if (proxy.now === result.node) result.unchanged.push(name)
    else if (cyclic || selectedPath.has(name)) result.unsafe.push(name)
    else result.targets.push(name)
  }
  return result
}
