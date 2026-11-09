import { applySettingsImport, exportSettings, previewSettingsImport, type SettingsDocument, type SettingsImportPreview } from './settings-transfer'
import { validProxyTestSelection, type ProxyTestSelection } from './proxy-test-selection'

export const SETTINGS_SYNC_KEY = 'miboard.settings.v1'
export const MAX_SYNC_BYTES = 1024 * 1024
export type SyncData = {
  deviceNames: Record<string, string>
  proxySort: Array<Omit<SettingsDocument['proxySort'][number], 'backendUrl'>>
  preferences: SettingsDocument['preferences']
  proxyTestSelection?: ProxyTestSelection
}
export type SyncDocument = { format: 'miboard-sync'; version: 1; revision: string; updatedAt: string; data: SyncData }
export type SyncChange = { section: 'devices' | 'sorts' | 'preferences'; key: string; before: unknown; after: unknown; kind: 'add' | 'change' | 'remove' }
export type SyncPreview = {
  direction: 'push' | 'pull'
  remote: SyncDocument | null
  local: SyncData
  changes: SyncChange[]
  importPreview: SettingsImportPreview | null
}
export class SettingsSyncError extends Error {
  constructor(public code: 'invalid' | 'size' | 'missing' | 'changed' | 'verify') {
    super(code)
    this.name = 'SettingsSyncError'
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
const emptyData = (): SyncData => ({ deviceNames: {}, proxySort: [], preferences: {} })

/** Stable equality includes content, not just the caller-supplied revision. */
export function syncFingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(syncFingerprint).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + syncFingerprint(value[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'undefined'
}

function importDocument(data: SyncData, backendUrl: string): SettingsDocument {
  return {
    format: 'miboard-settings', version: 1, servers: [],
    deviceAliases: [{ backendUrl, names: data.deviceNames }],
    proxySort: data.proxySort.map(sort => ({ ...sort, backendUrl })),
    preferences: data.preferences,
    ...(data.proxyTestSelection !== undefined ? { proxyTestSelections: [{ ...data.proxyTestSelection, backendUrl }] } : {}),
  }
}

/** The existing transfer validator remains the single allowlist for names, sorts and preferences. */
function checkedData(value: unknown, backendUrl: string): { data: SyncData; preview: SettingsImportPreview } {
  if (!record(value) || !keys(value, ['deviceNames', 'proxySort', 'preferences', 'proxyTestSelection']) || !record(value.deviceNames)
    || !Array.isArray(value.proxySort) || !record(value.preferences)
    || value.proxySort.some(sort => !record(sort) || !keys(sort, ['group', 'key', 'direction']))
    || (value.proxyTestSelection !== undefined && (!record(value.proxyTestSelection) || !keys(value.proxyTestSelection, ['mode', 'groups']) || !validProxyTestSelection(value.proxyTestSelection)))) throw new SettingsSyncError('invalid')
  const preview = previewSettingsImport(JSON.stringify(importDocument(value as SyncData, backendUrl)))
  if (preview.invalid || !preview.document) throw new SettingsSyncError('invalid')
  const document = preview.document
  return {
    data: {
      deviceNames: document.deviceAliases[0].names,
      proxySort: document.proxySort.map(({ group, key, direction }) => ({ group, key, direction })),
      preferences: document.preferences,
      ...(document.proxyTestSelections?.[0] ? { proxyTestSelection: { mode: document.proxyTestSelections[0].mode, groups: document.proxyTestSelections[0].groups } } : {}),
    },
    preview,
  }
}

/** Only preferences belonging to this core are portable; profiles, controller URLs and credentials never enter the wire schema. */
export function localSyncData(backendUrl: string): SyncData {
  const local: SettingsDocument = JSON.parse(exportSettings())
  const testSelection = local.proxyTestSelections?.find(item => item.backendUrl === backendUrl)
  return checkedData({
    deviceNames: local.deviceAliases.find(item => item.backendUrl === backendUrl)?.names ?? {},
    proxySort: local.proxySort.filter(item => item.backendUrl === backendUrl).map(({ group, key, direction }) => ({ group, key, direction })),
    preferences: local.preferences,
    ...(testSelection ? { proxyTestSelection: { mode: testSelection.mode, groups: testSelection.groups } } : {}),
  }, backendUrl).data
}

export function parseSyncDocument(value: unknown, backendUrl: string): SyncDocument | null {
  if (value === null) return null
  const serialized = JSON.stringify(value)
  if (!serialized || new TextEncoder().encode(serialized).length > MAX_SYNC_BYTES) throw new SettingsSyncError('size')
  if (!record(value) || !keys(value, ['format', 'version', 'revision', 'updatedAt', 'data']) || value.format !== 'miboard-sync' || value.version !== 1
    || typeof value.revision !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value.revision)
    || typeof value.updatedAt !== 'string' || value.updatedAt.length > 64 || !Number.isFinite(Date.parse(value.updatedAt))) throw new SettingsSyncError('invalid')
  return { format: 'miboard-sync', version: 1, revision: value.revision, updatedAt: value.updatedAt, data: checkedData(value.data, backendUrl).data }
}

function syncRevision(): string {
  // randomUUID requires a secure context; a local controller can legitimately serve over HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createSyncDocument(data: SyncData, backendUrl: string, revision = syncRevision(), now = new Date()): SyncDocument {
  return parseSyncDocument({ format: 'miboard-sync', version: 1, revision, updatedAt: now.toISOString(), data }, backendUrl)!
}

function flatten(data: SyncData): Map<string, { section: SyncChange['section']; key: string; value: unknown }> {
  const values = new Map<string, { section: SyncChange['section']; key: string; value: unknown }>()
  for (const [key, value] of Object.entries(data.deviceNames)) values.set('devices:' + key, { section: 'devices', key, value })
  for (const sort of data.proxySort) values.set('sorts:' + sort.group, { section: 'sorts', key: sort.group, value: { key: sort.key, direction: sort.direction } })
  for (const [name, value] of Object.entries(data.preferences)) {
    if ((name === 'latency' || name === 'groups') && record(value)) {
      for (const [key, item] of Object.entries(value)) values.set('preferences:' + name + '.' + key, { section: 'preferences', key: name + '.' + key, value: item })
    } else values.set('preferences:' + name, { section: 'preferences', key: name, value })
  }
  if (data.proxyTestSelection !== undefined) values.set('preferences:proxyTestSelection', { section: 'preferences', key: 'proxyTestSelection', value: data.proxyTestSelection })
  return values
}

function mergedData(local: SyncData, remote: SyncData): SyncData {
  const sorts = new Map(local.proxySort.map(sort => [sort.group, sort]))
  remote.proxySort.forEach(sort => sorts.set(sort.group, sort))
  return {
    deviceNames: { ...local.deviceNames, ...remote.deviceNames }, proxySort: [...sorts.values()],
    preferences: { ...local.preferences, ...remote.preferences,
      ...(remote.preferences.groups !== undefined ? { groups: { ...local.preferences.groups, ...remote.preferences.groups } } : {}),
    },
    ...(remote.proxyTestSelection ?? local.proxyTestSelection ? { proxyTestSelection: remote.proxyTestSelection ?? local.proxyTestSelection } : {}),
  }
}

export function previewSync(direction: 'push' | 'pull', remote: SyncDocument | null, backendUrl: string): SyncPreview {
  if (direction === 'pull' && !remote) throw new SettingsSyncError('missing')
  const local = localSyncData(backendUrl)
  const before = flatten(direction === 'push' ? remote?.data ?? emptyData() : local)
  const after = flatten(direction === 'push' ? local : mergedData(local, remote!.data))
  const changes: SyncChange[] = []
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id)
    if (syncFingerprint(a?.value) !== syncFingerprint(b?.value)) changes.push({ section: (b ?? a)!.section, key: (b ?? a)!.key, before: a?.value, after: b?.value, kind: !b ? 'remove' : !a ? 'add' : 'change' })
  }
  return { direction, remote, local, changes, importPreview: direction === 'pull' ? checkedData(remote!.data, backendUrl).preview : null }
}

export function syncPreviewChanged(preview: SyncPreview, remote: SyncDocument | null, backendUrl: string): boolean {
  return syncFingerprint(preview.remote) !== syncFingerprint(remote) || syncFingerprint(preview.local) !== syncFingerprint(localSyncData(backendUrl))
}

/** Remote profiles cannot be applied: the wire schema has no server or backend fields. */
export function applySyncPull(preview: SyncPreview, backendUrl: string): void {
  if (preview.direction !== 'pull' || !preview.remote) throw new SettingsSyncError('missing')
  if (syncFingerprint(preview.local) !== syncFingerprint(localSyncData(backendUrl))) throw new SettingsSyncError('changed')
  applySettingsImport(checkedData(preview.remote.data, backendUrl).preview)
}
