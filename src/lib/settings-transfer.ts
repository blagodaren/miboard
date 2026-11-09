import { createSavedBackend, normalizeUrl, savedBackends, updateSavedBackend, type Backend } from './api'
import { normalizeDeviceIP } from './devices'
import { DEFAULT_DELAY_SETTINGS, readDelaySettings, validDelaySettings, type DelaySettings } from './latency'
import type { ProxySort } from './proxy-sort'
import { PROXY_CARD_SIZE_KEY, readProxyCardSize, validProxyCardSize, type ProxyCardSize, PROXY_GROUP_HEIGHT_KEY, readProxyGroupHeight, validProxyGroupHeight, type ProxyGroupHeight } from './appearance'
import { LIVE_UPDATE_MODE_KEY, readLiveUpdateMode, validLiveUpdateMode, type LiveUpdateMode } from './live-updates'
import { PROXY_TEST_SELECTION_PREFIX, proxyTestSelectionKey, validProxyTestSelection, type ProxyTestSelection } from './proxy-test-selection'

export const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024
const PROFILE_KEYS = ['miboard.backends', 'miboard.secrets', 'miboard.backend']
const ALIAS_PREFIX = 'miboard.device-names.'
const SORT_PREFIX = 'miboard.proxy-sort.v1'
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
type Server = { url: string; name?: string; secret?: string }
type Aliases = { backendUrl: string; names: Record<string, string> }
type Sort = ProxySort & { backendUrl: string; group: string }
type Preferences = { theme?: 'system' | 'light' | 'dark'; locale?: 'en' | 'ru'; latency?: DelaySettings; groups?: Record<string, boolean>; proxyCardSize?: ProxyCardSize; proxyGroupHeight?: ProxyGroupHeight; liveUpdateMode?: LiveUpdateMode }
export type SettingsDocument = {
  format: 'miboard-settings'
  version: 1
  exportedAt?: string
  servers: Server[]
  deviceAliases: Aliases[]
  proxySort: Sort[]
  proxyTestSelections?: Array<ProxyTestSelection & { backendUrl: string }>
  preferences: Preferences
}
export type SettingsImportPreview = {
  document: SettingsDocument | null
  counts: { servers: number; aliases: number; sorts: number; preferences: number; secrets: number }
  conflicts: number
  existingServers: number
  invalid: number
  issues: string[]
}
export class SettingsTransferError extends Error {
  constructor(public code: 'invalid' | 'size' | 'storage' | 'rollback') {
    super(code)
    this.name = 'SettingsTransferError'
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
const ownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key))
const sortKey = (value: Pick<Sort, 'backendUrl' | 'group'>) => SORT_PREFIX + JSON.stringify([value.backendUrl, value.group])
const aliasKey = (url: string) => ALIAS_PREFIX + encodeURIComponent(url)
function backendUrl(value: unknown): string | null {
  if (!text(value, 2048) || /[\u0000-\u0020\u007f]/.test(value)) return null
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return null
  try {
    const parsed = new URL(normalizeUrl(value))
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null
    return (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  } catch { return null }
}
function safeTree(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (Array.isArray(value)) return value.length <= 10000 && value.every((item) => safeTree(item, depth + 1))
  if (record(value)) return Object.entries(value).every(([key, item]) => !FORBIDDEN.has(key) && key.length <= 2048 && safeTree(item, depth + 1))
  return typeof value !== 'number' || Number.isFinite(value)
}
function validNames(value: unknown): value is Record<string, string> {
  return record(value) && safeTree(value) && Object.keys(value).length <= 1000 && Object.entries(value).every(([ip, name]) => !!ip && normalizeDeviceIP(ip) === ip && text(name, 64) && !!name.trim())
}
function validGroups(value: unknown): value is Record<string, boolean> {
  return record(value) && safeTree(value) && Object.keys(value).length <= 10000 && Object.entries(value).every(([name, open]) => !!name && name.length <= 1024 && typeof open === 'boolean')
}
function validSort(value: unknown): value is ProxySort {
  return record(value) && typeof value.key === 'string' && typeof value.direction === 'string'
    && ['config', 'latency', 'name', 'protocol'].includes(value.key) && ['asc', 'desc'].includes(value.direction)
}
function json(key: string): unknown {
  const raw = localStorage.getItem(key)
  try { return raw === null ? null : JSON.parse(raw) } catch { return null }
}
/** Read-only counterpart of the profile migration: export/preview never writes storage. */
function localServers(): Backend[] {
  const saved = json(PROFILE_KEYS[0])
  const secrets = json(PROFILE_KEYS[1])
  const candidates = Array.isArray(saved) ? saved : [json(PROFILE_KEYS[2]), ...Object.entries(record(secrets) ? secrets : {}).map(([url, secret]) => ({ url, secret }))]
  const profiles = new Map<string, Backend>()
  for (const value of candidates) {
    if (!record(value)) continue
    const url = backendUrl(value.url)
    if (!url || typeof value.secret !== 'string' || profiles.has(url)) continue
    profiles.set(url, { url, secret: value.secret, ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}) })
  }
  return [...profiles.values()]
}
function readLocal(): SettingsDocument {
  try {
    const aliases: Aliases[] = []
    const sorts: Sort[] = []
    const testSelections: NonNullable<SettingsDocument['proxyTestSelections']> = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) ?? ''
      const value = key.startsWith(ALIAS_PREFIX) || key.startsWith(SORT_PREFIX) || key.startsWith(PROXY_TEST_SELECTION_PREFIX) ? json(key) : null
      if (key.startsWith(ALIAS_PREFIX)) {
        try {
          const url = backendUrl(decodeURIComponent(key.slice(ALIAS_PREFIX.length)))
          if (url && validNames(value)) aliases.push({ backendUrl: url, names: value })
        } catch { /* An invalid legacy key is not portable. */ }
      } else if (key.startsWith(SORT_PREFIX) && validSort(value)) {
        try {
          const tuple: unknown = JSON.parse(key.slice(SORT_PREFIX.length))
          if (!Array.isArray(tuple) || tuple.length !== 2) continue
          const url = backendUrl(tuple[0])
          if (url && text(tuple[1], 1024)) sorts.push({ backendUrl: url, group: tuple[1], key: value.key, direction: value.direction })
        } catch { /* Ignore malformed sort keys. */ }
      } else if (key.startsWith(PROXY_TEST_SELECTION_PREFIX) && validProxyTestSelection(value)) {
        try {
          const url = backendUrl(decodeURIComponent(key.slice(PROXY_TEST_SELECTION_PREFIX.length)))
          if (url) testSelections.push({ backendUrl: url, mode: value.mode, groups: [...value.groups] })
        } catch { /* Ignore malformed per-server preference keys. */ }
      }
    }
    const theme = localStorage.getItem('miboard.theme')
    const locale = localStorage.getItem('miboard.locale')
    const latency = readDelaySettings()
    const groups = json('miboard.groups')
    return {
      format: 'miboard-settings', version: 1, servers: localServers(), deviceAliases: aliases, proxySort: sorts,
      ...(testSelections.length ? { proxyTestSelections: testSelections } : {}),
      preferences: {
        theme: theme === 'light' || theme === 'dark' ? theme : 'system', locale: locale === 'ru' ? 'ru' : 'en',
        latency: validDelaySettings(latency) ? Object.fromEntries(Object.keys(DEFAULT_DELAY_SETTINGS).map((key) => [key, latency[key as keyof DelaySettings]])) as DelaySettings : { ...DEFAULT_DELAY_SETTINGS },
        groups: validGroups(groups) ? groups : {},
        proxyCardSize: readProxyCardSize(),
        proxyGroupHeight: readProxyGroupHeight(),
        liveUpdateMode: readLiveUpdateMode(),
      },
    }
  } catch { throw new SettingsTransferError('storage') }
}

function validate(value: unknown): { document: SettingsDocument | null; issues: string[] } {
  const issues: string[] = []
  if (!record(value) || !safeTree(value)) return { document: null, issues: ['file'] }
  if (!ownKeys(value, ['format', 'version', 'exportedAt', 'servers', 'deviceAliases', 'proxySort', 'proxyTestSelections', 'preferences']) || value.format !== 'miboard-settings' || value.version !== 1
    || (value.exportedAt !== undefined && (!text(value.exportedAt, 64) || !Number.isFinite(Date.parse(value.exportedAt))))) issues.push('format/version')
  const servers: Server[] = []
  const deviceAliases: Aliases[] = []
  const proxySort: Sort[] = []
  const preferences: Preferences = {}
  const proxyTestSelections: NonNullable<SettingsDocument['proxyTestSelections']> = []
  const seen = new Set<string>()
  if (!Array.isArray(value.servers) || value.servers.length > 1000) issues.push('servers')
  else value.servers.forEach((entry, i) => {
    const url = record(entry) ? backendUrl(entry.url) : null
    if (!record(entry) || !ownKeys(entry, ['url', 'name', 'secret']) || !url || seen.has(url)
      || (entry.secret !== undefined && !text(entry.secret, 65536)) || (entry.name !== undefined && !text(entry.name, 256))) issues.push(`servers[${i}]`)
    else { seen.add(url); servers.push({ url, ...(entry.name !== undefined ? { name: (entry.name as string).trim() } : {}), ...(entry.secret !== undefined ? { secret: entry.secret as string } : {}) }) }
  })
  seen.clear()
  if (!Array.isArray(value.deviceAliases) || value.deviceAliases.length > 1000) issues.push('deviceAliases')
  else value.deviceAliases.forEach((entry, i) => {
    const url = record(entry) ? backendUrl(entry.backendUrl) : null
    if (!record(entry) || !ownKeys(entry, ['backendUrl', 'names']) || !url || seen.has(url) || !validNames(entry.names)) issues.push(`deviceAliases[${i}]`)
    else { seen.add(url); deviceAliases.push({ backendUrl: url, names: Object.fromEntries(Object.entries(entry.names).map(([ip, name]) => [ip, name.trim()])) }) }
  })
  seen.clear()
  if (!Array.isArray(value.proxySort) || value.proxySort.length > 10000) issues.push('proxySort')
  else value.proxySort.forEach((entry, i) => {
    const url = record(entry) ? backendUrl(entry.backendUrl) : null
    const group = record(entry) ? entry.group : null
    const key = JSON.stringify([url, group])
    if (!record(entry) || !ownKeys(entry, ['backendUrl', 'group', 'key', 'direction']) || !url || !text(group, 1024) || seen.has(key) || !validSort(entry)) issues.push(`proxySort[${i}]`)
    else { seen.add(key); proxySort.push({ backendUrl: url, group, key: entry.key, direction: entry.direction }) }
  })
  const p = value.preferences
  seen.clear()
  if (value.proxyTestSelections !== undefined) {
    if (!Array.isArray(value.proxyTestSelections) || value.proxyTestSelections.length > 1000) issues.push('proxyTestSelections')
    else value.proxyTestSelections.forEach((entry, i) => {
      const url = record(entry) ? backendUrl(entry.backendUrl) : null
      const selection = record(entry) ? { mode: entry.mode, groups: entry.groups } : null
      if (!record(entry) || !ownKeys(entry, ['backendUrl', 'mode', 'groups']) || !url || seen.has(url) || !validProxyTestSelection(selection)) issues.push(`proxyTestSelections[${i}]`)
      else { seen.add(url); proxyTestSelections.push({ backendUrl: url, mode: selection.mode, groups: [...selection.groups] }) }
    })
  }
  if (!record(p) || !ownKeys(p, ['theme', 'locale', 'latency', 'groups', 'proxyCardSize', 'proxyGroupHeight', 'liveUpdateMode'])) issues.push('preferences')
  else {
    if (p.theme !== undefined) { if (p.theme === 'system' || p.theme === 'light' || p.theme === 'dark') preferences.theme = p.theme; else issues.push('preferences.theme') }
    if (p.locale !== undefined) { if (p.locale === 'en' || p.locale === 'ru') preferences.locale = p.locale; else issues.push('preferences.locale') }
    if (p.latency !== undefined) { if (record(p.latency) && ownKeys(p.latency, Object.keys(DEFAULT_DELAY_SETTINGS)) && validDelaySettings(p.latency)) preferences.latency = { ...p.latency }; else issues.push('preferences.latency') }
    if (p.groups !== undefined) { if (validGroups(p.groups)) preferences.groups = { ...p.groups }; else issues.push('preferences.groups') }
    if (p.proxyCardSize !== undefined) { if (validProxyCardSize(p.proxyCardSize)) preferences.proxyCardSize = p.proxyCardSize; else issues.push('preferences.proxyCardSize') }
    if (p.proxyGroupHeight !== undefined) { if (validProxyGroupHeight(p.proxyGroupHeight)) preferences.proxyGroupHeight = p.proxyGroupHeight; else issues.push('preferences.proxyGroupHeight') }
    if (p.liveUpdateMode !== undefined) { if (validLiveUpdateMode(p.liveUpdateMode)) preferences.liveUpdateMode = p.liveUpdateMode; else issues.push('preferences.liveUpdateMode') }
  }
  return { document: issues.length ? null : { format: 'miboard-settings', version: 1, servers, deviceAliases, proxySort, preferences, ...(value.proxyTestSelections !== undefined ? { proxyTestSelections } : {}) }, issues }
}
function preview(document: SettingsDocument | null, issues: string[]): SettingsImportPreview {
  const counts = { servers: 0, aliases: 0, sorts: 0, preferences: 0, secrets: 0 }
  if (!document) return { document, counts, conflicts: 0, existingServers: 0, invalid: issues.length, issues }
  const current = readLocal()
  let conflicts = 0
  let existingServers = 0
  for (const server of document.servers) {
    const existing = current.servers.find((item) => item.url === server.url)
    if (existing) {
      existingServers++
      if ((server.name !== undefined && server.name !== (existing.name ?? '')) || (server.secret !== undefined && server.secret !== '' && server.secret !== existing.secret)) conflicts++
    }
  }
  for (const aliases of document.deviceAliases) {
    const existing = current.deviceAliases.find((item) => item.backendUrl === aliases.backendUrl)?.names ?? {}
    conflicts += Object.entries(aliases.names).filter(([ip, name]) => Object.hasOwn(existing, ip) && existing[ip] !== name).length
  }
  for (const sort of document.proxySort) {
    const existing = current.proxySort.find((item) => sortKey(item) === sortKey(sort))
    if (existing && (existing.key !== sort.key || existing.direction !== sort.direction)) conflicts++
  }
  for (const [key, value] of Object.entries(document.preferences)) {
    if (key === 'groups') {
      const groups = current.preferences.groups ?? {}
      conflicts += Object.entries(document.preferences.groups ?? {}).filter(([name, open]) => Object.hasOwn(groups, name) && groups[name] !== open).length
    } else if (JSON.stringify(current.preferences[key as keyof Preferences]) !== JSON.stringify(value)) conflicts++
  }
  for (const selection of document.proxyTestSelections ?? []) {
    const existing = current.proxyTestSelections?.find(item => item.backendUrl === selection.backendUrl)
    if (existing && JSON.stringify(existing) !== JSON.stringify(selection)) conflicts++
  }
  counts.servers = document.servers.length
  counts.aliases = document.deviceAliases.reduce((sum, item) => sum + Object.keys(item.names).length, 0)
  counts.sorts = document.proxySort.length
  counts.preferences = Object.keys(document.preferences).filter((key) => key !== 'groups').length + Object.keys(document.preferences.groups ?? {}).length + (document.proxyTestSelections?.length ?? 0)
  counts.secrets = document.servers.filter((server) => server.secret !== undefined).length
  return { document, counts, conflicts, existingServers, invalid: 0, issues: [] }
}

export function exportSettings({ includeSecrets = false }: { includeSecrets?: boolean } = {}): string {
  const document = readLocal()
  document.exportedAt = new Date().toISOString()
  document.servers = document.servers.map(({ url, name, secret }) => ({ url, ...(name !== undefined ? { name } : {}), ...(includeSecrets ? { secret } : {}) }))
  const output = JSON.stringify(document, null, 2)
  if (new TextEncoder().encode(output).length > MAX_SETTINGS_FILE_BYTES) throw new SettingsTransferError('size')
  if (!validate(document).document) throw new SettingsTransferError('invalid')
  return output
}
export function previewSettingsImport(input: string): SettingsImportPreview {
  if (new TextEncoder().encode(input).length > MAX_SETTINGS_FILE_BYTES) throw new SettingsTransferError('size')
  let value: unknown
  try { value = JSON.parse(input) } catch { throw new SettingsTransferError('invalid') }
  const checked = validate(value)
  return preview(checked.document, checked.issues)
}

/** One outer transaction also covers migration and the nested profile writers. No network or runtime stores. */
export function applySettingsImport(input: SettingsImportPreview): void {
  const checked = validate(input.document)
  if (!checked.document) throw new SettingsTransferError('invalid')
  const document = checked.document
  const keys = new Set(PROFILE_KEYS)
  document.deviceAliases.forEach((item) => keys.add(aliasKey(item.backendUrl)))
  document.proxySort.forEach((item) => keys.add(sortKey(item)))
  document.proxyTestSelections?.forEach((item) => keys.add(proxyTestSelectionKey(item.backendUrl)))
  const preferenceKeys: Record<string, string> = { latency: 'miboard.latency.v1', proxyCardSize: PROXY_CARD_SIZE_KEY, proxyGroupHeight: PROXY_GROUP_HEIGHT_KEY, liveUpdateMode: LIVE_UPDATE_MODE_KEY }
  Object.keys(document.preferences).forEach((key) => keys.add(preferenceKeys[key] ?? `miboard.${key}`))
  const original = new Map<string, string | null>()
  try { for (const key of keys) original.set(key, localStorage.getItem(key)) } catch { throw new SettingsTransferError('storage') }
  try {
    const current = readLocal()
    if (document.servers.length) {
      const profiles = savedBackends()
      for (const server of document.servers) {
        const existing = profiles.find((item) => item.url === server.url)
        // A secret omitted by the default export, or an empty placeholder, never erases credentials.
        const backend = { url: server.url, secret: server.secret || existing?.secret || '', ...(server.name !== undefined ? { name: server.name } : {}) }
        if (existing) updateSavedBackend(existing.id, backend)
        else createSavedBackend(backend)
      }
    }
    for (const item of document.deviceAliases) {
      const existing = current.deviceAliases.find((entry) => entry.backendUrl === item.backendUrl)?.names ?? {}
      localStorage.setItem(aliasKey(item.backendUrl), JSON.stringify({ ...existing, ...item.names }))
    }
    for (const item of document.proxySort) localStorage.setItem(sortKey(item), JSON.stringify({ key: item.key, direction: item.direction }))
    for (const item of document.proxyTestSelections ?? []) localStorage.setItem(proxyTestSelectionKey(item.backendUrl), JSON.stringify({ mode: item.mode, groups: item.groups }))
    const p = document.preferences
    if (p.groups !== undefined) localStorage.setItem('miboard.groups', JSON.stringify({ ...current.preferences.groups, ...p.groups }))
    if (p.latency !== undefined) localStorage.setItem('miboard.latency.v1', JSON.stringify(p.latency))
    if (p.proxyCardSize !== undefined) localStorage.setItem(PROXY_CARD_SIZE_KEY, p.proxyCardSize)
    if (p.proxyGroupHeight !== undefined) localStorage.setItem(PROXY_GROUP_HEIGHT_KEY, p.proxyGroupHeight)
    if (p.liveUpdateMode !== undefined) localStorage.setItem(LIVE_UPDATE_MODE_KEY, p.liveUpdateMode)
    if (p.locale !== undefined) localStorage.setItem('miboard.locale', p.locale)
    if (p.theme === 'system') localStorage.removeItem('miboard.theme')
    else if (p.theme !== undefined) localStorage.setItem('miboard.theme', p.theme)
  } catch {
    let restored = true
    for (const [key, value] of original) {
      if (value === null) { try { localStorage.removeItem(key) } catch { restored = false } }
    }
    for (const [key, value] of original) {
      if (value !== null) { try { localStorage.setItem(key, value) } catch { restored = false } }
    }
    throw new SettingsTransferError(restored ? 'storage' : 'rollback')
  }
}
