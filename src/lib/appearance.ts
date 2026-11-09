export const PROXY_CARD_SIZE_KEY = 'miboard.proxy-card-size'
export type ProxyCardSize = 'large' | 'compact'
export const PROXY_GROUP_HEIGHT_KEY = 'miboard.proxy-group-height'
export type ProxyGroupHeight = 'compact' | 'large' | 'full'

export function validProxyGroupHeight(value: unknown): value is ProxyGroupHeight {
  return value === 'compact' || value === 'large' || value === 'full'
}

export function readProxyGroupHeight(): ProxyGroupHeight {
  try {
    const value = localStorage.getItem(PROXY_GROUP_HEIGHT_KEY)
    return validProxyGroupHeight(value) ? value : 'large'
  } catch { return 'large' }
}

export function validProxyCardSize(value: unknown): value is ProxyCardSize {
  return value === 'large' || value === 'compact'
}

export function readProxyCardSize(): ProxyCardSize {
  try {
    const value = localStorage.getItem(PROXY_CARD_SIZE_KEY)
    return validProxyCardSize(value) ? value : 'large'
  } catch {
    return 'large'
  }
}
