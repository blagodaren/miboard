import type { Backend, Configs, Mode, SavedBackend } from './api'

export const RUNTIME_PORTS = ['port', 'socks-port', 'mixed-port', 'redir-port', 'tproxy-port'] as const
export const RUNTIME_FLAGS = ['ipv6', 'sniffing', 'tcp-concurrent'] as const
export const LOG_LEVELS = ['silent', 'error', 'warning', 'info', 'debug'] as const
export type RuntimePort = typeof RUNTIME_PORTS[number]
export type RuntimeFlag = typeof RUNTIME_FLAGS[number]
export type RuntimeField = RuntimePort | RuntimeFlag | 'log-level'
export type RuntimeDraft = Partial<Record<RuntimePort, string>> & Partial<Record<RuntimeFlag, boolean>> & { 'log-level'?: string }
export type RuntimeIssue = { field: RuntimeField; code: 'port' | 'duplicate' | 'logLevel' | 'unsupported' | 'boolean' }
export type CoreRequest = <T = unknown>(path: string, options: {
  method?: string; body?: unknown; query?: Record<string, string | number>; timeout?: number; signal?: AbortSignal
}, backend: Backend) => Promise<T>

export class CoreManagementError extends Error {
  code: 'invalid' | 'unsupported' | 'verify' | 'unreachable' | 'invalidResponse' | 'restricted'
  observed?: Configs
  constructor(code: CoreManagementError['code'], observed?: Configs) { super(code); this.name = 'CoreManagementError'; this.code = code; this.observed = observed }
}

export function unsupportedCoreAction(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && [404, 405, 501].includes(Number(error.status))
}

export function runtimeDraft(configs: Configs | null): RuntimeDraft {
  if (!configs) return {}
  const draft: RuntimeDraft = {}
  if (typeof configs['log-level'] === 'string') draft['log-level'] = configs['log-level']
  for (const key of RUNTIME_FLAGS) if (typeof configs[key] === 'boolean') draft[key] = configs[key]
  for (const key of RUNTIME_PORTS) if (typeof configs[key] === 'number') draft[key] = String(configs[key])
  return draft
}

/** Validate the complete proposed listener configuration, but send only changed supported fields. */
export function runtimePatch(configs: Configs, draft: RuntimeDraft): { patch: Record<string, unknown>; issues: RuntimeIssue[]; changesPorts: boolean } {
  const patch: Record<string, unknown> = {}
  const issues: RuntimeIssue[] = []
  if (draft['log-level'] !== undefined) {
    if (!(LOG_LEVELS as readonly string[]).includes(draft['log-level'])) issues.push({ field: 'log-level', code: 'logLevel' })
    else if (draft['log-level'] !== configs['log-level']) patch['log-level'] = draft['log-level']
  }
  for (const key of RUNTIME_FLAGS) {
    if (draft[key] === undefined) continue
    if (typeof configs[key] !== 'boolean') issues.push({ field: key, code: 'unsupported' })
    else if (typeof draft[key] !== 'boolean') issues.push({ field: key, code: 'boolean' })
    else if (draft[key] !== configs[key]) patch[key] = draft[key]
  }
  const ports = new Map<number, RuntimePort[]>()
  for (const key of RUNTIME_PORTS) {
    if (draft[key] !== undefined && typeof configs[key] !== 'number') { issues.push({ field: key, code: 'unsupported' }); continue }
    const input = draft[key] === undefined ? configs[key] : draft[key]
    if (input === undefined) continue
    const text = String(input).trim()
    const value = Number(text)
    if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 0 || value > 65535) { issues.push({ field: key, code: 'port' }); continue }
    if (draft[key] !== undefined && value !== configs[key]) patch[key] = value
    if (value > 0) ports.set(value, [...(ports.get(value) ?? []), key])
  }
  for (const keys of ports.values()) {
    // Existing core configurations may intentionally share listeners. Only block a new collision.
    if (keys.length > 1 && keys.some(key => Object.hasOwn(patch, key))) for (const key of keys) issues.push({ field: key, code: 'duplicate' })
  }
  return { patch, issues, changesPorts: RUNTIME_PORTS.some(key => Object.hasOwn(patch, key)) }
}

/** After a partial write, retain the user's intended edits without reverting unrelated external changes. */
export function rebaseRuntimeDraft(before: Configs, requested: RuntimeDraft, observed: Configs): RuntimeDraft {
  const intended = Object.keys(runtimePatch(before, requested).patch) as RuntimeField[]
  return { ...runtimeDraft(observed), ...Object.fromEntries(intended.map(key => [key, requested[key]])) }
}

function assertConfigs(value: unknown): asserts value is Configs {
  if (!value || typeof value !== 'object' || !('mode' in value) || typeof value.mode !== 'string') throw new CoreManagementError('invalidResponse')
}

export async function writeRuntimeSettings(send: CoreRequest, backend: Backend, configs: Configs, draft: RuntimeDraft, signal: AbortSignal): Promise<Configs> {
  const captured = { ...backend }
  const plan = runtimePatch(configs, { ...draft })
  if (plan.issues.length) throw new CoreManagementError('invalid')
  signal.throwIfAborted()
  if (!Object.keys(plan.patch).length) return configs
  try {
    await send('/configs', { method: 'PATCH', body: plan.patch, signal }, captured)
    signal.throwIfAborted()
    const observed = await send<Configs>('/configs', { signal }, captured)
    signal.throwIfAborted()
    assertConfigs(observed)
    if (Object.entries(plan.patch).some(([key, value]) => observed[key as keyof Configs] !== value)) throw new CoreManagementError('verify', observed)
    return observed
  } catch (error) {
    if (unsupportedCoreAction(error)) throw new CoreManagementError('unsupported')
    throw error
  }
}

export type CoreUpgrade = 'core' | 'ui' | 'geo'
export const CORE_UPGRADE_PATHS: Record<CoreUpgrade, string> = { core: '/upgrade', ui: '/upgrade/ui', geo: '/upgrade/geo' }
export type UpgradeResult = { previousVersion: string; version: string; outcome: 'accepted' | 'versionChanged' | 'unconfirmed' }

const pause = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const finish = () => { signal.removeEventListener('abort', cancel); resolve() }
  const timer = setTimeout(finish, milliseconds)
  const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
  signal.addEventListener('abort', cancel, { once: true })
})

function versionValue(value: unknown): string {
  if (!value || typeof value !== 'object' || !('version' in value) || typeof value.version !== 'string' || !value.version.trim()) throw new CoreManagementError('invalidResponse')
  return value.version
}

/** Send a mutation once. A dropped response is never retried or reported as a proven update. */
export async function upgradeCore(send: CoreRequest, backend: Backend, action: CoreUpgrade, signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = pause): Promise<UpgradeResult> {
  const captured = { ...backend }
  signal.throwIfAborted()
  const previousVersion = versionValue(await send('/version', { signal, timeout: 5000 }, captured))
  let accepted = false
  try {
    await send(CORE_UPGRADE_PATHS[action], { method: 'POST', signal, timeout: 120000 }, captured)
    accepted = true
  } catch (error) {
    signal.throwIfAborted()
    if (unsupportedCoreAction(error)) throw new CoreManagementError('unsupported')
    if (!error || typeof error !== 'object' || !('status' in error) || error.status !== 0) throw error
  }
  let lastVersion = ''
  for (let attempt = 0; attempt < 10; attempt++) {
    signal.throwIfAborted()
    if (action === 'core' || attempt > 0) await wait(1000, signal)
    try {
      lastVersion = versionValue(await send('/version', { signal, timeout: 3000 }, captured))
      signal.throwIfAborted()
      if (action === 'core' && lastVersion !== previousVersion) return { previousVersion, version: lastVersion, outcome: 'versionChanged' }
      if (accepted && (action !== 'core' || attempt >= 2)) return { previousVersion, version: lastVersion, outcome: 'accepted' }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof CoreManagementError && error.code === 'invalidResponse') throw error
      if (error && typeof error === 'object' && 'status' in error && [401, 403].includes(Number(error.status))) throw error
    }
  }
  if (!lastVersion) throw new CoreManagementError('unreachable')
  return { previousVersion, version: lastVersion, outcome: 'unconfirmed' }
}

export type CoreSnapshot = {
  checkedAt: number; version: string | null; mode: string | null; connections: number | null; download: number | null; upload: number | null
  errors: Array<{ source: 'version' | 'configs' | 'connections'; error: unknown }>
}
const counter = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export async function readCoreSnapshot(send: CoreRequest, backend: Backend, signal: AbortSignal): Promise<CoreSnapshot> {
  const captured = { ...backend }
  signal.throwIfAborted()
  const [version, configs, connections] = await Promise.allSettled([
    send('/version', { signal, timeout: 5000 }, captured).then(versionValue),
    send<Configs>('/configs', { signal, timeout: 5000 }, captured).then(value => { assertConfigs(value); return value }),
    send<{ connections: unknown[] | null; downloadTotal?: number; uploadTotal?: number }>('/connections', { signal, timeout: 5000 }, captured).then(value => {
      if (!value || (!Array.isArray(value.connections) && value.connections !== null)) throw new CoreManagementError('invalidResponse')
      return value
    }),
  ])
  signal.throwIfAborted()
  const snapshot: CoreSnapshot = { checkedAt: Date.now(), version: null, mode: null, connections: null, download: null, upload: null, errors: [] }
  if (version.status === 'fulfilled') snapshot.version = version.value
  else snapshot.errors.push({ source: 'version', error: version.reason })
  if (configs.status === 'fulfilled') snapshot.mode = configs.value.mode
  else snapshot.errors.push({ source: 'configs', error: configs.reason })
  if (connections.status === 'fulfilled') {
    snapshot.connections = connections.value.connections?.length ?? 0
    snapshot.download = counter(connections.value.downloadTotal)
    snapshot.upload = counter(connections.value.uploadTotal)
  } else snapshot.errors.push({ source: 'connections', error: connections.reason })
  return snapshot
}

export type FleetAction = { kind: 'mode'; mode: Mode } | { kind: 'close' } | { kind: 'reload' }
export async function applyFleetAction(send: CoreRequest, backend: Backend, action: FleetAction, signal: AbortSignal, options: { hideMode?: boolean } = {}): Promise<void> {
  const captured = { ...backend }
  const selected = { ...action }
  signal.throwIfAborted()
  if (selected.kind === 'mode') {
    if (options.hideMode) throw new CoreManagementError('restricted')
    if (!['rule', 'global', 'direct'].includes(selected.mode)) throw new CoreManagementError('invalid')
    await send('/configs', { method: 'PATCH', body: { mode: selected.mode }, signal }, captured)
    signal.throwIfAborted()
    const configs = await send<Configs>('/configs', { signal }, captured)
    if (configs?.mode !== selected.mode) throw new CoreManagementError('verify')
  } else if (selected.kind === 'close') await send('/connections', { method: 'DELETE', signal }, captured)
  else await send('/configs', { method: 'PUT', query: { force: 'true' }, body: { path: '', payload: '' }, signal, timeout: 30000 }, captured)
  signal.throwIfAborted()
}

export type FleetOutcome<T> = { profile: SavedBackend; status: 'success'; value: T } | { profile: SavedBackend; status: 'error'; error: unknown } | { profile: SavedBackend; status: 'cancelled' }

/** Pin URLs and credentials before workers start; failures never prevent remaining profiles from running. */
export async function runCoreFleet<T>(profiles: readonly SavedBackend[], run: (profile: SavedBackend, signal: AbortSignal) => Promise<T>, signal: AbortSignal,
  onResult: (outcome: FleetOutcome<T>) => void = () => {}, concurrency = 3): Promise<FleetOutcome<T>[]> {
  const queue = [...new Map(profiles.map(profile => [profile.id, { ...profile }])).values()]
  const results: FleetOutcome<T>[] = queue.map(profile => ({ profile, status: 'cancelled' }))
  let next = 0
  async function worker() {
    while (!signal.aborted && next < queue.length) {
      const index = next++, profile = queue[index]
      let result: FleetOutcome<T>
      try {
        const value = await run(profile, signal)
        result = signal.aborted ? { profile, status: 'cancelled' } : { profile, status: 'success', value }
      } catch (error) { result = signal.aborted ? { profile, status: 'cancelled' } : { profile, status: 'error', error } }
      results[index] = result
      onResult(result)
    }
  }
  const workers = Math.max(1, Math.min(4, Number.isFinite(concurrency) ? Math.floor(concurrency) : 3, queue.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
