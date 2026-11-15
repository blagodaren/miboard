/**
 * Параметры встраивания панели (например, в iframe веб-интерфейса роутера).
 * Читаются один раз при загрузке из ?query и #/route?query: навигация внутри панели
 * меняет hash, а флаг должен действовать всю сессию страницы.
 *
 * hideMode — скрыть переключатель режима rule / global / direct, когда режим
 * задаёт внешняя система (например, профиль на роутере).
 * disableUpgradeCore — скрыть обновление ядра, когда ядро обновляет внешнее приложение
 * или прошивка роутера; обновления UI и geo-баз остаются.
 * disableTunMode — скрыть переключатель TUN, когда TUN включает внешняя система.
 * `?hideMode`, `?hideMode=1`, `?hideMode=true` включают; `0`, `false`, `no`, `off` — нет.
 * Значения из формата zashboard `disableUpgradeCore=core` и `disableTunMode=tun` тоже включают.
 */

const OFF = new Set(['0', 'false', 'no', 'off'])

export function flag(params: URLSearchParams, name: string): boolean {
  const value = params.get(name)
  return value !== null && !OFF.has(value.trim().toLowerCase())
}

export function embedParams(search: string, hash: string): URLSearchParams {
  const params = new URLSearchParams(search)
  const hashQuery = hash.split('?')[1]
  if (hashQuery) new URLSearchParams(hashQuery).forEach((value, key) => params.set(key, value))
  return params
}

export interface EmbedOptions {
  hideMode: boolean
  disableUpgradeCore: boolean
  disableTunMode: boolean
}

export function parseEmbed(search: string, hash: string): EmbedOptions {
  const params = embedParams(search, hash)
  return {
    hideMode: flag(params, 'hideMode'),
    disableUpgradeCore: flag(params, 'disableUpgradeCore'),
    disableTunMode: flag(params, 'disableTunMode'),
  }
}

export const embed: EmbedOptions = typeof location === 'undefined'
  ? { hideMode: false, disableUpgradeCore: false, disableTunMode: false }
  : parseEmbed(location.search, location.hash)
