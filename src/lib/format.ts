import { i18n, t, type MessageKey } from './i18n.svelte'

const UNITS: MessageKey[] = ['units.byte', 'units.kilobyte', 'units.megabyte', 'units.gigabyte', 'units.terabyte']
const formats = new Map<string, { nf0: Intl.NumberFormat; nf1: Intl.NumberFormat }>()

function numberFormats() {
  const locale = i18n.intlLocale
  let cached = formats.get(locale)
  if (!cached) {
    cached = {
      nf0: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      nf1: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    }
    formats.set(locale, cached)
  }
  return cached
}

/** Один формат на весь экран: < 10 — один знак, ≥ 10 — без дробной части */
export function splitBytes(n: number): [string, string] {
  if (!Number.isFinite(n) || n <= 0) return ['0', t('units.byte')]
  const { nf0, nf1 } = numberFormats()
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  return [i === 0 || n >= 10 ? nf0.format(n) : nf1.format(n), t(UNITS[i])]
}

export function bytes(n: number): string {
  const [v, u] = splitBytes(n)
  return `${v} ${u}`
}

export function speed(n: number): string {
  return `${bytes(n)}${t('units.perSecond')}`
}

export function count(n: number): string {
  return numberFormats().nf0.format(n)
}

export function since(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return t('time.seconds', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutes', { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('time.hoursMinutes', { hours: h, minutes: m % 60 })
  return t('time.daysHours', { days: Math.floor(h / 24), hours: h % 24 })
}

export type DelayBand = 'fast' | 'ok' | 'slow' | 'dead' | 'none'
export function delayBand(ms: number | undefined, yellow = 300, red = 800): DelayBand {
  if (ms === undefined) return 'none'
  if (ms <= 0) return 'dead'
  if (ms < yellow) return 'fast'
  if (ms < red) return 'ok'
  return 'slow'
}
