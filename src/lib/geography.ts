import type { Connection } from './api'

// Страны и территории ISO 3166-1; XK также встречается в базах GeoIP.
const COUNTRY_CODES = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
    'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT ' +
    'JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
    'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
    'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
    'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' '),
)

const nameFormats = new Map<string, Intl.DisplayNames>()

/** Normalize only recognized ISO destination countries, including XK used by GeoIP. */
export function countryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return COUNTRY_CODES.has(code) ? code : null
}

export type GeographyConnection = Connection & { dl?: number; ul?: number }

export type CountryTraffic = {
  code: string
  name: string
  count: number
  download: number
  upload: number
  dl: number
  ul: number
}

export type GeographySummary = {
  countries: CountryTraffic[]
  total: number
  located: number
  unknown: number
  download: number
  upload: number
}

export function countryName(code: string, locale = 'ru'): string {
  const normalized = code.trim().toUpperCase()
  let names = nameFormats.get(locale)
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: 'region' })
    nameFormats.set(locale, names)
  }
  return COUNTRY_CODES.has(normalized) ? names.of(normalized) ?? normalized : normalized
}

/** Страна только из метаданных назначения: домен, правило и расположение прокси её не определяют. */
export function destinationCountry(connection: Connection, fallback?: (connection: Connection) => string | null): string | null {
  const codes = connection.metadata.destinationGeoIP
  for (const value of Array.isArray(codes) ? codes : []) {
    const code = countryCode(value)
    if (code) return code
  }
  return countryCode(fallback?.(connection))
}

function nonnegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Агрегируем текущий снимок: повторные кадры WebSocket не увеличивают счётчик соединений. */
export function summarizeGeography(
  connections: readonly GeographyConnection[],
  fallback?: (connection: Connection) => string | null,
): GeographySummary {
  const countries = new Map<string, CountryTraffic>()
  let located = 0
  let download = 0
  let upload = 0

  for (const connection of connections) {
    const d = nonnegative(connection.download)
    const u = nonnegative(connection.upload)
    download += d
    upload += u
    const code = destinationCountry(connection, fallback)
    if (!code) continue

    located++
    let country = countries.get(code)
    if (!country) {
      country = { code, name: countryName(code), count: 0, download: 0, upload: 0, dl: 0, ul: 0 }
      countries.set(code, country)
    }
    country.count++
    country.download += d
    country.upload += u
    country.dl += nonnegative(connection.dl)
    country.ul += nonnegative(connection.ul)
  }

  return {
    countries: [...countries.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    total: connections.length,
    located,
    unknown: connections.length - located,
    download,
    upload,
  }
}
