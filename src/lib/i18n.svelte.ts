import en from './locales/en'
import ru from './locales/ru'
import type { Message, TranslationParams } from './i18n-types'

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, Message>

type LocaleDefinition = {
  label: string
  intlLocale: string
  dir: 'ltr' | 'rtl'
  messages: Partial<Messages>
}

// Add each language here; omitted messages fall back to English.
export const locales = {
  en: { label: 'English', intlLocale: 'en-US', dir: 'ltr', messages: en },
  ru: { label: 'Русский', intlLocale: 'ru-RU', dir: 'ltr', messages: ru },
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

  set(value: string) {
    this.#locale = isLocale(value) ? value : DEFAULT_LOCALE
    this.#updateDocument()
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, this.#locale)
    } catch {
      // The language still changes when persistence is unavailable.
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
  const messages: Partial<Messages> = locales[i18n.locale].messages
  const translated = messages[key]
  const message: Message = translated ?? en[key]
  let template: string
  if (typeof message === 'string') {
    template = message
  } else {
    const locale = translated === undefined ? locales[DEFAULT_LOCALE].intlLocale : i18n.intlLocale
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
