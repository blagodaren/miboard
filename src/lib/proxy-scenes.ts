import type { Proxy } from './api'

export const SCENES_STORAGE_KEY = 'miboard.scenes.v1'
export const SCENES_MAX_BYTES = 128 * 1024
export const SCENES_LIMIT = 20
export type SceneEntry = { group: string; mode: 'select' | 'auto'; node?: string }
export type ProxyScene = { id: string; name: string; createdAt: string; entries: SceneEntry[] }
export type SceneDocument = { format: 'miboard-scenes'; version: 1; scenes: ProxyScene[] }
export type SceneStatus = 'ready' | 'unchanged' | 'missing' | 'unsupported' | 'unsafe'
export type ScenePlanRow = SceneEntry & { status: SceneStatus; current: string }
export class SceneError extends Error {
  code: 'invalid' | 'size' | 'limit' | 'storage' | 'conflict' | 'verify' | 'missing'
  constructor(code: SceneError['code']) { super(code); this.name = 'SceneError'; this.code = code }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const name = (value: unknown, limit = 1024): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value)
const automatic = (proxy: Proxy) => proxy.type === 'Fallback' || proxy.type === 'URLTest'
export const sceneLocalKey = (backend: string) => SCENES_STORAGE_KEY + ':' + encodeURIComponent(backend)
export const sceneDocument = (scenes: ProxyScene[]): SceneDocument => ({ format: 'miboard-scenes', version: 1, scenes })
export function parseScenes(value: unknown): SceneDocument {
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').length > SCENES_MAX_BYTES) throw new SceneError('size')
  if (!record(value) || value.format !== 'miboard-scenes' || value.version !== 1 || !Array.isArray(value.scenes) || value.scenes.length > SCENES_LIMIT) throw new SceneError('invalid')
  const ids = new Set<string>()
  const scenes = value.scenes.map((item): ProxyScene => {
    if (!record(item) || !name(item.id, 100) || ids.has(item.id) || !name(item.name, 80) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || !Array.isArray(item.entries) || !item.entries.length || item.entries.length > 500) throw new SceneError('invalid')
    ids.add(item.id)
    const groups = new Set<string>()
    const entries = item.entries.map((entry): SceneEntry => {
      if (!record(entry) || !name(entry.group) || groups.has(entry.group) || !['select', 'auto'].includes(String(entry.mode)) || (entry.mode === 'select' && !name(entry.node)) || (entry.mode === 'auto' && entry.node !== undefined)) throw new SceneError('invalid')
      groups.add(entry.group)
      return { group: entry.group, mode: entry.mode as SceneEntry['mode'], ...(entry.mode === 'select' ? { node: entry.node as string } : {}) }
    })
    return { id: item.id, name: item.name.trim(), createdAt: item.createdAt, entries }
  })
  return sceneDocument(scenes)
}
export function captureScene(label: string, proxies: Record<string, Proxy>, id: string, now = new Date()): ProxyScene {
  const entries: SceneEntry[] = Object.entries(proxies).filter(([, proxy]) => Array.isArray(proxy.all) && proxy.all.length > 0).flatMap<SceneEntry>(([group, proxy]) => {
    if (automatic(proxy) && proxy.fixed === '') return [{ group, mode: 'auto' as const }]
    const node = automatic(proxy) && proxy.fixed ? proxy.fixed : proxy.now
    return node ? [{ group, mode: 'select' as const, node }] : []
  })
  return parseScenes(sceneDocument([{ id, name: label.trim(), createdAt: now.toISOString(), entries }])).scenes[0]
}
export function readScenes(backend: string, storage: Pick<Storage, 'getItem'> = localStorage): SceneDocument {
  const raw = storage.getItem(sceneLocalKey(backend))
  if (raw !== null && (raw.length > SCENES_MAX_BYTES || new TextEncoder().encode(raw).length > SCENES_MAX_BYTES)) throw new SceneError('size')
  return raw === null ? sceneDocument([]) : parseScenes(JSON.parse(raw))
}
export function saveScenes(backend: string, document: SceneDocument, storage: Pick<Storage, 'setItem'> = localStorage): void {
  const value = JSON.stringify(parseScenes(document))
  try { storage.setItem(sceneLocalKey(backend), value) } catch { throw new SceneError('storage') }
}
/** Canonical structural comparison is used for local/remote conflict checks. */
export function sceneFingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(sceneFingerprint).join(',') + ']'
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + sceneFingerprint(value[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'undefined'
}
type SelectionGraph = Map<string, readonly string[]>
function cyclic(start: string, edges: SelectionGraph): boolean {
  const path = new Set<string>(), visited = new Set<string>()
  const stack = [{ node: start, index: 0 }]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    path.add(frame.node)
    const children = edges.get(frame.node) ?? []
    if (frame.index >= children.length) { path.delete(frame.node); visited.add(frame.node); stack.pop(); continue }
    const child = children[frame.index++]
    if (path.has(child)) return true
    if (!visited.has(child)) stack.push({ node: child, index: 0 })
  }
  return false
}
// Automatic groups may fail over even while pinned. Every possible member must
// remain safe, including the member chosen after restoring automatic selection.
const selectedEdges = (proxy: Proxy, selected = proxy.now): readonly string[] => proxy.type === 'Selector' ? selected ? [selected] : [] : proxy.all ?? []
/** Plans a safe order as well as the final graph: changing B before A can create a temporary loop. */
export function planScene(scene: ProxyScene, proxies: Record<string, Proxy>): ScenePlanRow[] {
  const edges: SelectionGraph = new Map(Object.entries(proxies).filter(([, proxy]) => Array.isArray(proxy.all)).map(([key, proxy]) => [key, selectedEdges(proxy)]))
  const rows: ScenePlanRow[] = scene.entries.map(entry => {
    const proxy = Object.hasOwn(proxies, entry.group) ? proxies[entry.group] : undefined
    let status: SceneStatus = 'ready'
    if (!proxy?.all || (entry.mode === 'select' && !proxy.all.includes(entry.node!))) status = 'missing'
    else if (!['Selector', 'Fallback', 'URLTest'].includes(proxy.type) || (entry.mode === 'auto' && (!automatic(proxy) || proxy.fixed === undefined))) status = 'unsupported'
    else if (entry.mode === 'auto' ? proxy.fixed === '' : automatic(proxy) ? proxy.fixed === entry.node : proxy.now === entry.node) status = 'unchanged'
    return { ...entry, status, current: proxy && automatic(proxy) && proxy.fixed === '' ? 'auto' : proxy?.now ?? '' }
  })
  const final = new Map(edges)
  for (const row of rows) if (row.status === 'ready' && row.mode === 'select') final.set(row.group, selectedEdges(proxies[row.group], row.node))
  for (const row of rows) if (row.status === 'ready' && cyclic(row.group, final)) row.status = 'unsafe'
  const pending = rows.filter(row => row.status === 'ready')
  const ordered: ScenePlanRow[] = []
  while (pending.length) {
    const index = pending.findIndex(row => { const next = new Map(edges); if (row.mode === 'select') next.set(row.group, selectedEdges(proxies[row.group], row.node)); return !cyclic(row.group, next) })
    if (index < 0) { for (const row of pending) row.status = 'unsafe'; break }
    const [row] = pending.splice(index, 1)
    if (row.mode === 'select') edges.set(row.group, selectedEdges(proxies[row.group], row.node))
    ordered.push(row)
  }
  return [...ordered, ...rows.filter(row => row.status !== 'ready')]
}
export type SceneApplyResult = ScenePlanRow & { result: 'applied' | 'failed' | 'skipped' | 'cancelled'; error?: unknown }
export async function applyScene(scene: ProxyScene, proxies: Record<string, Proxy>, send: (entry: SceneEntry, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, progress: (rows: SceneApplyResult[]) => void = () => {}): Promise<SceneApplyResult[]> {
  const current = Object.fromEntries(Object.entries(proxies).map(([key, proxy]) => [key, { ...proxy }]))
  const results: SceneApplyResult[] = []
  for (const row of planScene(scene, current)) {
    if (signal.aborted) results.push({ ...row, result: 'cancelled' })
    else if (row.status !== 'ready') results.push({ ...row, result: 'skipped' })
    else {
      // Recheck each edge after a failed preceding command; earlier successes are not rolled back.
      const checked = planScene({ ...scene, entries: [row] }, current)[0]
      if (checked.status !== 'ready') results.push({ ...checked, result: 'skipped' })
      else try {
        await send(row, signal)
        if (row.mode === 'select') current[row.group] = { ...current[row.group], now: row.node, ...(automatic(current[row.group]) ? { fixed: row.node } : {}) }
        else current[row.group] = { ...current[row.group], fixed: '' }
        results.push({ ...row, result: 'applied' })
      } catch (error) { results.push({ ...row, result: signal.aborted ? 'cancelled' : 'failed', error }) }
    }
    progress([...results])
  }
  return results
}
/** Storage has no compare-and-swap. Precheck + readback detect conflicts but cannot make writes atomic. */
export async function pushScenes(local: SceneDocument, expected: SceneDocument | null, read: () => Promise<unknown>, write: (document: SceneDocument) => Promise<unknown>): Promise<void> {
  const clean = parseScenes(local)
  const latestValue = await read()
  const latest = latestValue === null ? null : parseScenes(latestValue)
  if (sceneFingerprint(latest) !== sceneFingerprint(expected)) throw new SceneError('conflict')
  await write(clean)
  const verified = await read()
  if (sceneFingerprint(verified === null ? null : parseScenes(verified)) !== sceneFingerprint(clean)) throw new SceneError('verify')
}
