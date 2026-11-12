import type en from './locales/en'
import type { Message, TranslationParams } from './i18n-types'

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, Message>

type LocaleDefinition = {
  label: string
  intlLocale: string
  dir: 'ltr' | 'rtl'
  load: () => Promise<{ default: Messages }>
}

// Dictionaries must be complete, so opening a non-English locale never needs
// to fetch the English dictionary as well. Type-only imports erase at build time.
export const locales = {
  en: { label: 'English', intlLocale: 'en-US', dir: 'ltr', load: () => import('./locales/en') },
  ru: { label: 'Русский', intlLocale: 'ru-RU', dir: 'ltr', load: () => import('./locales/ru') },
} satisfies Record<string, LocaleDefinition>

export type Locale = keyof typeof locales
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'miboard.locale'
export const supportedLocales = (Object.keys(locales) as Locale[]).map((value) => ({
  value,
  label: locales[value].label,
}))

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(locales, value)
}

class I18n {
  #locale = $state<Locale>(DEFAULT_LOCALE)
  #messages = $state.raw<Messages | null>(null)
  #pending = $state<Locale | null>(null)
  #request = 0
  #loaded = new Map<Locale, Promise<Messages>>()

  constructor() {
    try {
      const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
      if (isLocale(saved)) this.#locale = saved
    } catch {
      // Storage can be unavailable in private or embedded contexts.
    }
    this.#updateDocument()
  }

  get locale(): Locale {
    return this.#locale
  }

  get intlLocale(): string {
    return locales[this.#locale].intlLocale
  }

  get selectedLocale(): Locale {
    return this.#pending ?? this.#locale
  }

  get loading(): boolean {
    return this.#pending !== null
  }

  get messages(): Messages {
    if (!this.#messages) throw new Error('Translations are not initialized')
    return this.#messages
  }

  initialize() {
    return this.set(this.#locale)
  }

  async set(value: string): Promise<boolean> {
    const locale = isLocale(value) ? value : DEFAULT_LOCALE
    const request = ++this.#request
    if (locale === this.#locale && this.#messages) {
      this.#pending = null
      return true
    }
    this.#pending = locale
    try {
      let loaded = this.#loaded.get(locale)
      if (!loaded) {
        loaded = locales[locale].load().then(module => module.default)
        this.#loaded.set(locale, loaded)
        void loaded.catch(() => { if (this.#loaded.get(locale) === loaded) this.#loaded.delete(locale) })
      }
      const messages = await loaded
      // A slower request must not undo a later language selection.
      if (request !== this.#request) return false
      this.#messages = messages
      this.#locale = locale
      this.#updateDocument()
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, locale)
      } catch {
        // The language still changes when persistence is unavailable.
      }
      return true
    } catch (error) {
      if (request !== this.#request) return false
      throw error
    } finally {
      if (request === this.#request) this.#pending = null
    }
  }

  #updateDocument() {
    if (typeof document === 'undefined') return
    document.documentElement.lang = this.#locale
    document.documentElement.dir = locales[this.#locale].dir
  }
}

export const i18n = new I18n()
const pluralRules = new Map<string, Intl.PluralRules>()
const numberFormats = new Map<string, Intl.NumberFormat>()

export function t(key: MessageKey, params: TranslationParams = {}): string {
  const message: Message = i18n.messages[key]
  let template: string
  if (typeof message === 'string') {
    template = message
  } else {
    const locale = i18n.intlLocale
    let rules = pluralRules.get(locale)
    if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(locale)))
    const category = rules.select(typeof params.count === 'number' ? params.count : 0)
    template = message[category] ?? message.other
  }

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    if (value === undefined) return placeholder
    if (typeof value !== 'number') return value
    const locale = i18n.intlLocale
    let format = numberFormats.get(locale)
    if (!format) numberFormats.set(locale, (format = new Intl.NumberFormat(locale)))
    return format.format(value)
  })
}
