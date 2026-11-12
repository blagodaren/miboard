export const SHORTCUT_ROUTES = ['overview', 'proxies', 'devices', 'connections', 'analysis', 'geography', 'rules', 'logs', 'settings'] as const
export function shortcutAction(event: { key: string; code?: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean }, editing: boolean, dialog: boolean): string | null {
  if (editing || dialog || event.repeat || event.ctrlKey || event.metaKey) return null
  // macOS Option+digit reports a symbol in `key`; the physical key stays in `code`.
  const digit = /^Digit([1-9])$/.exec(event.code ?? '')?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : undefined)
  if (event.altKey && !event.shiftKey && digit) return SHORTCUT_ROUTES[Number(digit) - 1]
  if (event.altKey) return null
  return event.key === '/' ? 'search' : event.key === '?' ? 'help' : null
}
