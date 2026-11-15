import { CUSTOM_CSS_KEY, MAX_CUSTOM_CSS } from './custom-css'
export { CUSTOM_CSS_KEY, MAX_CUSTOM_CSS } from './custom-css'
const STYLE_ID = 'miboard-custom-css'

/**
 * One <style> per source, appended after the app stylesheet so equal selectors win.
 * Empty elements stay in place: the creation order (link theme, then custom CSS) is the cascade order.
 */
export function applyStyle(id: string, css: string) {
  let element = document.getElementById(id)
  if (!element) {
    element = document.createElement('style')
    element.id = id
    document.head.append(element)
  }
  element.textContent = css
}

class CustomCss {
  value = $state('')

  constructor() {
    try { this.value = localStorage.getItem(CUSTOM_CSS_KEY) ?? '' } catch { /* Storage is optional. */ }
  }

  apply() { applyStyle(STYLE_ID, this.value) }

  save(css: string): 'saved' | 'memory' | 'size' {
    if (css.length > MAX_CUSTOM_CSS) return 'size'
    this.value = css.trim() ? css : ''
    this.apply()
    try {
      if (this.value) localStorage.setItem(CUSTOM_CSS_KEY, this.value)
      else localStorage.removeItem(CUSTOM_CSS_KEY)
      return 'saved'
    } catch { return 'memory' }
  }
}

export const customCss = new CustomCss()
