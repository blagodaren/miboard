export const PROXY_GROUPS_KEY = 'miboard.groups'
export const SHOW_HIDDEN_GROUPS_KEY = 'miboard.groups.show-hidden'

export function readProxyGroups(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROXY_GROUPS_KEY) ?? '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    // fromEntries creates own properties, including groups named __proto__.
    return Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === 'boolean'))
  } catch {
    return {}
  }
}

export function readShowHiddenGroups(): boolean {
  try { return localStorage.getItem(SHOW_HIDDEN_GROUPS_KEY) === '1' } catch { return false }
}
