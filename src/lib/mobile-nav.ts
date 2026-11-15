// Order of the sections in the shell; the first MOBILE_NAV_SLOTS form the mobile bottom bar.
export const NAV_ROUTES = ['overview', 'proxies', 'devices', 'connections', 'analysis', 'geography', 'rules', 'logs', 'history', 'fleet', 'settings'] as const
export type NavRoute = typeof NAV_ROUTES[number]
export const MOBILE_NAV_KEY = 'miboard.mobile-nav.v1'
export const MOBILE_NAV_SLOTS = 4
const FIRST: NavRoute[] = ['overview', 'proxies', 'connections', 'settings']
export const DEFAULT_MOBILE_NAV: readonly NavRoute[] = [...FIRST, ...NAV_ROUTES.filter(route => !FIRST.includes(route))]

/** Partial orders remain portable when later versions add navigation sections. */
export function validMobileNav(value: unknown): value is NavRoute[] {
  return Array.isArray(value) && value.length <= NAV_ROUTES.length && new Set(value).size === value.length
    && value.every(route => typeof route === 'string' && NAV_ROUTES.includes(route as NavRoute))
}

/** Keeps known sections once, in the saved order; sections added in later versions go last. */
export function normalizeMobileNav(value: unknown): NavRoute[] {
  const saved = Array.isArray(value) ? value.filter((route, index): route is NavRoute => NAV_ROUTES.includes(route) && value.indexOf(route) === index) : []
  return [...saved, ...DEFAULT_MOBILE_NAV.filter(route => !saved.includes(route))]
}

export function moveMobileNav(order: readonly NavRoute[], index: number, delta: -1 | 1): NavRoute[] {
  const next = [...order]
  const target = index + delta
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function readMobileNav(): NavRoute[] {
  try { return normalizeMobileNav(JSON.parse(localStorage.getItem(MOBILE_NAV_KEY) ?? 'null')) } catch { return [...DEFAULT_MOBILE_NAV] }
}
