import { MOBILE_NAV_KEY, normalizeMobileNav, readMobileNav, type NavRoute } from './mobile-nav'
import { PROXY_CARD_SIZE_KEY, readProxyCardSize, validProxyCardSize, type ProxyCardSize, PROXY_GROUP_HEIGHT_KEY, readProxyGroupHeight, validProxyGroupHeight, type ProxyGroupHeight } from './appearance'

class AppearanceState {
  proxyCardSize = $state<ProxyCardSize>(readProxyCardSize())
  proxyGroupHeight = $state<ProxyGroupHeight>(readProxyGroupHeight())
  mobileNav = $state<NavRoute[]>(readMobileNav())

  setMobileNav(value: readonly NavRoute[]): boolean {
    this.mobileNav = normalizeMobileNav(value)
    try {
      localStorage.setItem(MOBILE_NAV_KEY, JSON.stringify(this.mobileNav))
      return true
    } catch { return false }
  }

  setProxyGroupHeight(value: ProxyGroupHeight): boolean {
    if (!validProxyGroupHeight(value)) return false
    this.proxyGroupHeight = value
    try {
      localStorage.setItem(PROXY_GROUP_HEIGHT_KEY, value)
      return true
    } catch { return false }
  }

  setProxyCardSize(value: ProxyCardSize): boolean {
    if (!validProxyCardSize(value)) return false
    this.proxyCardSize = value
    try {
      localStorage.setItem(PROXY_CARD_SIZE_KEY, value)
      return true
    } catch {
      // The selected layout remains usable for this session without storage.
      return false
    }
  }
}

export const appearance = new AppearanceState()
