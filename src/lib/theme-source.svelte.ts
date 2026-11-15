import { applyStyle, MAX_CUSTOM_CSS } from './custom-css.svelte'
import { embedParams } from './embed'
import { parseThemeParam, THEME_SOURCE_KEY, validThemeSource, type ThemeSource } from './theme-source'

const STYLE_ID = 'miboard-theme-source'

class ThemeSourceState {
  source = $state<ThemeSource | null>(null)
  loading = $state(false)
  error = $state('')

  constructor() {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(THEME_SOURCE_KEY) ?? 'null')
      if (validThemeSource(saved)) this.source = saved
    } catch { /* A broken or blocked entry means no link theme. */ }
  }

  apply() { applyStyle(STYLE_ID, this.source?.enabled ? this.source.css : '') }

  /** Applies the saved copy at once, then follows the link parameter and checks the URL for changes. */
  start() {
    const param = embedParams(location.search, location.hash).get('theme')
    // Consume theme-only links too: otherwise Remove is undone on the next reload.
    // Leave credentials and UI flags for their own startup handlers.
    if (param !== null) {
      const clean = (query: string) => {
        const params = new URLSearchParams(query)
        params.delete('theme')
        const value = params.toString()
        return value ? '?' + value : ''
      }
      const [route, query = ''] = location.hash.split('?')
      history.replaceState(history.state, '', location.pathname + clean(location.search) + route + clean(query))
    }
    const url = parseThemeParam(param, location.origin)
    if (url === null) this.remove()
    // A new URL keeps the user's on/off choice; the old CSS stays until the new one loads.
    else if (url && url !== this.source?.url) this.save({ url, css: this.source?.css ?? '', updatedAt: 0, enabled: this.source?.enabled ?? true })
    this.apply()
    if (this.source) void this.refresh()
  }

  async refresh() {
    const source = this.source
    if (!source || this.loading) return
    this.loading = true
    this.error = ''
    try {
      // no-cache revalidates with ETag/Last-Modified, so an unchanged theme costs a 304.
      const response = await fetch(source.url, { cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const css = await response.text()
      if (css.length > MAX_CUSTOM_CSS) throw new Error('> 64 KB')
      if (this.source?.url !== source.url) return
      this.save({ ...this.source, css, updatedAt: Date.now() })
      this.apply()
    } catch (error) {
      if (this.source?.url === source.url) this.error = error instanceof Error ? error.message : String(error)
    } finally { this.loading = false }
  }

  setEnabled(enabled: boolean) {
    if (!this.source) return
    this.save({ ...this.source, enabled })
    this.apply()
  }

  remove() {
    this.source = null
    this.error = ''
    this.apply()
    try { localStorage.removeItem(THEME_SOURCE_KEY) } catch { /* Nothing to keep. */ }
  }

  private save(source: ThemeSource) {
    this.source = source
    try { localStorage.setItem(THEME_SOURCE_KEY, JSON.stringify(source)) } catch { /* Applied for this session. */ }
  }
}

export const themeSource = new ThemeSourceState()
