export const PROXY_GROUPS_KEY = 'miboard.groups'

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
