// Theme CSS delivered by the app that opens MIBoard (often taken from a subscription header).
export const THEME_SOURCE_KEY = 'miboard.theme-source'
export type ThemeSource = { url: string; css: string; updatedAt: number; enabled: boolean }
const OFF = new Set(['', '0', 'off', 'false', 'none'])
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * `theme=` link value: undefined — no parameter, null — remove the theme, string — the CSS URL.
 * HTTPS anywhere; any scheme from this page's own origin (an app serving MIBoard under its own scheme);
 * plain HTTP also from loopback (a local client serving its own CSS).
 */
export function parseThemeParam(value: string | null, pageOrigin: string): string | null | undefined {
  if (value === null) return undefined
  if (OFF.has(value.trim().toLowerCase())) return null
  try {
    const url = new URL(value.trim(), pageOrigin)
    // The page's own origin under any scheme: an app may serve MIBoard under its own (miboard://app).
    // protocol + host rather than url.origin, which is "null" for such schemes in Node and Chromium.
    if (url.protocol === 'https:' || `${url.protocol}//${url.host}` === pageOrigin || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return url.href
  } catch { /* An invalid URL is ignored like a missing parameter. */ }
  return undefined
}

export function validThemeSource(value: unknown): value is ThemeSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Record<string, unknown>
  return typeof source.url === 'string' && typeof source.css === 'string' && typeof source.updatedAt === 'number' && typeof source.enabled === 'boolean'
}
