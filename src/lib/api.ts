// Клиент mihomo external-controller: REST + WebSocket.
// REST авторизуется заголовком Bearer, WS — параметром ?token=
import { t, type MessageKey } from './i18n.svelte'

export type Backend = { url: string; secret: string; name?: string }
export type SavedBackend = Backend & { id: string }

const KEY_BACKEND = 'miboard.backend'
const KEY_SECRETS = 'miboard.secrets'
const KEY_BACKENDS = 'miboard.backends'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* приватный режим — живём без памяти */
  }
}
function remove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* приватный режим — живём без памяти */
  }
}

export function normalizeUrl(input: string): string {
  let u = input.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  return u.replace(/\/+$/, '')
}

/** Дополняем только короткий ввод формы; полные URL и сохранённые профили не меняем. */
export function completeBackendUrl(input: string): string {
  const value = input.trim()
  if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value
  const withProtocol = 'http://' + value
  try {
    const parsed = new URL(withProtocol)
    const authority = value.split(/[/?#]/, 1)[0]
    // URL.port скрывает стандартные :80/:443 — проверяем явно заданный порт в исходной строке.
    if (/:\d+$/.test(authority)) return withProtocol
    parsed.port = '9090'
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname) + parsed.search + parsed.hash
  } catch {
    // Незаконченный/некорректный адрес остаётся для обычной валидации формы.
    return value
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Данные localStorage не считаем доверенными, даже если их сохранила старая версия. */
function storedBackend(value: unknown): Backend | null {
  if (!record(value) || typeof value.url !== 'string' || typeof value.secret !== 'string') return null
  const input = value.url.trim()
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) return null
  let url = normalizeUrl(value.url)
  try {
    const parsed = new URL(url)
    if (
      !/^https?:$/.test(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash
    ) return null
    url = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  return { url, secret: value.secret, ...(name ? { name } : {}) }
}

function storedSecrets(): Record<string, string> {
  const value = read<unknown>(KEY_SECRETS, null)
  if (!record(value)) return {}
  const entries: [string, string][] = []
  for (const [url, secret] of Object.entries(value)) {
    const b = storedBackend({ url, secret })
    if (b) entries.push([b.url, b.secret])
  }
  return Object.fromEntries(entries)
}

/** Base64url от UTF-8 URL: стабильный ID без случайных коллизий и DOM API. */
function backendId(url: string): string {
  const bytes = Array.from(new TextEncoder().encode(url), (byte) => String.fromCharCode(byte)).join('')
  return 'backend-' + btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function storedProfiles(stored: unknown): SavedBackend[] {
  // После миграции список авторитетный: старые keys не возвращают удалённые профили.
  const candidates = Array.isArray(stored)
    ? stored
    : [read<unknown>(KEY_BACKEND, null), ...Object.entries(storedSecrets()).map(([url, secret]) => ({ url, secret }))]
  const unique = new Map<string, SavedBackend>()
  for (const candidate of candidates) {
    const b = storedBackend(candidate)
    if (b && !unique.has(b.url)) unique.set(b.url, { ...b, id: backendId(b.url) })
  }
  return [...unique.values()]
}

export function savedBackends(): SavedBackend[] {
  const stored = read<unknown>(KEY_BACKENDS, null)
  const profiles = storedProfiles(stored)
  if (JSON.stringify(stored) !== JSON.stringify(profiles)) write(KEY_BACKENDS, profiles)
  return profiles
}

/** Параметры из ?query и из #/route?query — совместимо с форматом zashboard */
function urlParams(): URLSearchParams {
  const p = new URLSearchParams(location.search)
  const h = location.hash.split('?')[1]
  if (h) new URLSearchParams(h).forEach((v, k) => p.set(k, v))
  return p
}

function stripSecretFromUrl() {
  const clean = (q: string) => {
    const p = new URLSearchParams(q)
    ;['secret', 'hostname', 'port', 'protocol', 'http', 'https', 'secondaryPath'].forEach((k) => p.delete(k))
    const s = p.toString()
    return s ? '?' + s : ''
  }
  const [route] = location.hash.split('?')
  const hashQ = location.hash.split('?')[1] ?? ''
  history.replaceState(null, '', location.pathname + clean(location.search) + (route || '') + clean(hashQ))
}

/** Если страницу отдаёт сам mihomo (/ui/...), API живёт на том же origin */
export function servedByCore(): boolean {
  return /\/ui(\/|$)/.test(location.pathname)
}

export function initialBackend(): Backend | null {
  const p = urlParams()
  const profiles = savedBackends()
  const secrets = storedSecrets()
  const saved = storedBackend(read<unknown>(KEY_BACKEND, null))
  const forUrl = (url: string, secret: string | null): Backend => {
    url = storedBackend({ url, secret: '' })?.url ?? url
    const profile = profiles.find((b) => b.url === url)
    return { url, secret: secret ?? profile?.secret ?? secrets[url] ?? '', ...(profile?.name ? { name: profile.name } : {}) }
  }

  if (p.has('hostname')) {
    const proto = p.get('protocol') ?? (p.has('https') ? 'https' : p.has('http') ? 'http' : location.protocol.replace(':', ''))
    const port = p.get('port') ? ':' + p.get('port') : ''
    const path = p.get('secondaryPath') ?? ''
    const url = normalizeUrl(`${proto}://${p.get('hostname')}${port}${path}`)
    const b = forUrl(url, p.get('secret'))
    stripSecretFromUrl()
    return b
  }

  // Secret-only ссылка из /ui относится к origin, даже если последним был удалённый сервер.
  if (servedByCore() && p.has('secret')) {
    const b = forUrl(location.origin, p.get('secret'))
    stripSecretFromUrl()
    return b
  }

  if (saved) {
    if (p.has('secret')) {
      saved.secret = p.get('secret')!
      stripSecretFromUrl()
    }
    return saved
  }

  if (servedByCore()) return forUrl(location.origin, null)
  if (p.has('secret')) stripSecretFromUrl()
  return null
}

export function saveBackend(b: Backend) {
  const clean = storedBackend(b)
  if (!clean) return
  const profiles = savedBackends()
  const previous = profiles.find((profile) => profile.url === clean.url)
  if (b.name === undefined && previous?.name) clean.name = previous.name
  const saved: SavedBackend = { ...clean, id: backendId(clean.url) }
  write(KEY_BACKENDS, [saved, ...profiles.filter((profile) => profile.url !== clean.url)])
  write(KEY_BACKEND, clean)
  const secrets = storedSecrets()
  secrets[clean.url] = clean.secret
  write(KEY_SECRETS, secrets)
}

export class BackendProfileError extends Error {
  constructor(public code: 'duplicate' | 'missing' | 'invalid' | 'storage') {
    super(code)
    this.name = 'BackendProfileError'
  }
}

function profileStorageSnapshot(): Map<string, string | null> {
  const originals = new Map<string, string | null>()
  try {
    for (const key of [KEY_BACKENDS, KEY_SECRETS, KEY_BACKEND]) originals.set(key, localStorage.getItem(key))
  } catch {
    throw new BackendProfileError('storage')
  }
  return originals
}

function writeProfileStorage(changes: [string, unknown][], originals: Map<string, string | null>) {
  const written: string[] = []
  try {
    for (const [key, value] of changes) {
      localStorage.setItem(key, JSON.stringify(value))
      written.push(key)
    }
  } catch {
    for (const key of written.reverse()) {
      try {
        const value = originals.get(key) ?? null
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      } catch {
        /* При полном отказе хранилища восстановление тоже может быть недоступно. */
      }
    }
    throw new BackendProfileError('storage')
  }
}

/** Новый профиль сохраняется без проверки сети и назначения последним подключённым. */
export function createSavedBackend(b: Backend): SavedBackend {
  const clean = storedBackend(b)
  if (!clean || (b.name !== undefined && typeof b.name !== 'string')) throw new BackendProfileError('invalid')
  const originals = profileStorageSnapshot()
  const profiles = storedProfiles(read<unknown>(KEY_BACKENDS, null))
  if (profiles.some((profile) => profile.url === clean.url)) throw new BackendProfileError('duplicate')
  const created: SavedBackend = { ...clean, id: backendId(clean.url) }
  const secrets = storedSecrets()
  secrets[clean.url] = clean.secret
  writeProfileStorage([[KEY_BACKENDS, [created, ...profiles]], [KEY_SECRETS, secrets]], originals)
  return created
}

/** Редактирование профиля не переключает подключение и не меняет порядок серверов. */
export function updateSavedBackend(id: string, b: Backend): SavedBackend {
  const clean = storedBackend(b)
  if (!clean || (b.name !== undefined && typeof b.name !== 'string')) throw new BackendProfileError('invalid')
  const originals = profileStorageSnapshot()

  // Валидация идёт без savedBackends(): отклонённая правка не запускает запись миграции.
  const profiles = storedProfiles(read<unknown>(KEY_BACKENDS, null))
  const index = profiles.findIndex((profile) => profile.id === id)
  if (index === -1) throw new BackendProfileError('missing')
  const previous = profiles[index]
  if (profiles.some((profile, i) => i !== index && profile.url === clean.url)) throw new BackendProfileError('duplicate')
  if (b.name === undefined && previous.name) clean.name = previous.name
  const updated: SavedBackend = { ...clean, id: backendId(clean.url) }
  profiles[index] = updated
  const secrets = storedSecrets()
  delete secrets[previous.url]
  secrets[clean.url] = clean.secret
  const last = storedBackend(read<unknown>(KEY_BACKEND, null))
  const changes: [string, unknown][] = [[KEY_BACKENDS, profiles], [KEY_SECRETS, secrets]]
  if (last?.url === previous.url) changes.push([KEY_BACKEND, clean])
  writeProfileStorage(changes, originals)
  return updated
}

export function removeSavedBackend(id: string) {
  const profiles = savedBackends()
  const target = profiles.find((profile) => profile.id === id)
  if (!target) return
  write(KEY_BACKENDS, profiles.filter((profile) => profile.id !== id))
  const secrets = storedSecrets()
  delete secrets[target.url]
  write(KEY_SECRETS, secrets)
  const last = storedBackend(read<unknown>(KEY_BACKEND, null))
  if (last?.url === target.url) remove(KEY_BACKEND)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public translationKey?: MessageKey,
  ) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.translationKey) return t(error.translationKey)
  return error instanceof Error ? error.message : String(error)
}

let current: Backend = { url: '', secret: '' }
export function useBackend(b: Backend) {
  current = { url: normalizeUrl(b.url), secret: b.secret, ...(b.name ? { name: b.name } : {}) }
}
export function backend(): Backend {
  return current
}

export async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number>; timeout?: number; signal?: AbortSignal } = {},
  b: Backend = current,
): Promise<T> {
  const url = new URL(b.url + path)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v))
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  if (init.signal?.aborted) ctrl.abort()
  else init.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), init.timeout ?? 10000)
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(b.secret ? { Authorization: `Bearer ${b.secret}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    })
  } catch (e) {
    const key = ctrl.signal.aborted ? 'error.timeout' : 'error.offline'
    throw new ApiError(0, t(key), key)
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      msg = (typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : '') || msg
    } catch {
      /* тело не JSON */
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** WebSocket с переподключением. Возвращает функцию закрытия */
export function stream<T>(
  path: string,
  onData: (data: T) => void,
  opts: { query?: Record<string, string | number>; onState?: (open: boolean) => void } = {},
): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let delay = 1000
  let timer: ReturnType<typeof setTimeout>

  const open = () => {
    const url = new URL(current.url.replace(/^http/, 'ws') + path)
    if (current.secret) url.searchParams.set('token', current.secret)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v))
    let isOpen = false
    ws = new WebSocket(url)
    ws.onopen = () => {
      if (closed || isOpen) return
      isOpen = true
      delay = 1000
      opts.onState?.(true)
    }
    ws.onmessage = (e) => {
      try {
        onData(JSON.parse(e.data))
      } catch {
        /* битый кадр — пропускаем */
      }
    }
    ws.onclose = () => {
      if (closed) return
      if (isOpen) {
        isOpen = false
        opts.onState?.(false)
      }
      timer = setTimeout(open, delay)
      delay = Math.min(delay * 2, 15000)
    }
  }
  open()
  return () => {
    closed = true
    clearTimeout(timer)
    ws?.close()
  }
}

// ——— типы ответа mihomo ———

export type Version = { version: string; meta?: boolean }

export type Delay = { time: string; delay: number }
export type Proxy = {
  name: string
  type: string
  now?: string
  all?: string[]
  history: Delay[]
  extra?: Record<string, { alive: boolean; history: Delay[] }>
  udp?: boolean
  alive?: boolean
  hidden?: boolean
  icon?: string
  testUrl?: string
  'provider-name'?: string
  fixed?: string
  useLightGBM?: boolean
  collectData?: boolean
  sampleRate?: number
  preferASN?: boolean
  tolerance?: number
  'policy-priority'?: string
}

/** Prizrak serializes these Go fields without JSON tags (PascalCase). */
export type SmartWeight = { Name: string; Rank: string; Weight: number }
export type SmartWeights = {
  weights: Record<string, SmartWeight[] | null>
  errors?: Record<string, string>
  message?: string
}

export type ProxyProvider = {
  name?: string
  type?: string
  vehicleType?: string
  proxies?: Proxy[]
  updatedAt?: string
  subscriptionInfo?: { Upload?: number; Download?: number; Total?: number; Expire?: number }
}

export type ConnMeta = {
  network: string
  type: string
  sourceIP: string
  sourcePort: string
  destinationIP: string
  destinationPort: string
  /** null/undefined: mihomo ещё не проверяло адрес; []: GeoIP не дал результата. */
  destinationGeoIP?: string[] | null
  destinationIPASN?: string
  host: string
  sniffHost?: string
  process?: string
  processPath?: string
  remoteDestination?: string
  inboundName?: string
}
export type Connection = {
  id: string
  metadata: ConnMeta
  upload: number
  download: number
  start: string
  chains: string[]
  rule: string
  rulePayload: string
}
export type ConnSnapshot = {
  downloadTotal: number
  uploadTotal: number
  connections: Connection[] | null
  memory?: number
}

export type Rule = { type: string; payload: string; proxy: string; size?: number }
export type RuleProvider = {
  name: string
  behavior: string
  format?: string
  ruleCount: number
  type: string
  vehicleType: string
  updatedAt?: string
  payload?: string[]
}

export type Mode = 'rule' | 'global' | 'direct'
export type Configs = {
  mode: Mode
  'log-level': string
  'mixed-port'?: number
  port?: number
  'socks-port'?: number
  'allow-lan'?: boolean
  'unified-delay'?: boolean
  tun?: { enable: boolean }
  'lgbm-auto-update'?: boolean
  'lgbm-update-interval'?: number
  'lgbm-url'?: string
  'smart-collector-size'?: number
}

export type LogLine = { type: string; payload: string }

export type DnsResponse = {
  Status: number
  Answer?: { name: string; type: number; TTL: number; data: string }[]
}

// ——— эндпоинты ———

export const api = {
  version: (b?: Backend) => request<Version>('/version', { timeout: 5000 }, b),
  dnsQuery: (name: string, type: 'A' | 'AAAA', b?: Backend, signal?: AbortSignal) =>
    request<DnsResponse>('/dns/query', { query: { name, type }, timeout: 5000, signal }, b),
  configs: () => request<Configs>('/configs'),
  patchConfigs: (body: Partial<Configs> | Record<string, unknown>) => request('/configs', { method: 'PATCH', body }),
  proxies: (b?: Backend) => request<{ proxies: Record<string, Proxy> }>('/proxies', {}, b),
  proxyProviders: (b?: Backend) => request<{ providers: Record<string, ProxyProvider> }>('/providers/proxies', {}, b),
  smartWeights: (b?: Backend) => request<SmartWeights>('/group/weights', { timeout: 5000 }, b),
  smartGroupWeights: (group: string, b?: Backend, signal?: AbortSignal) =>
    request<{ weights: SmartWeight[] | null }>(`/group/${encodeURIComponent(group)}/weights`, { signal }, b),
  select: (group: string, name: string, b?: Backend, signal?: AbortSignal) =>
    request(`/proxies/${encodeURIComponent(group)}`, { method: 'PUT', body: { name }, signal }, b),
  clearFixedProxy: (group: string, b?: Backend, signal?: AbortSignal) =>
    request(`/proxies/${encodeURIComponent(group)}`, { method: 'DELETE', signal }, b),
  groupDelay: (group: string, url: string, timeout = 5000, b?: Backend, signal?: AbortSignal) =>
    request<Record<string, number>>(`/group/${encodeURIComponent(group)}/delay`, {
      query: { url, timeout },
      timeout: timeout + 5000,
      signal,
    }, b),
  proxyDelay: (name: string, url: string, timeout = 5000, b?: Backend, signal?: AbortSignal) =>
    request<{ delay: number }>(`/proxies/${encodeURIComponent(name)}/delay`, {
      query: { url, timeout },
      timeout: timeout + 2000,
      signal,
    }, b),
  providerProxyDelay: (provider: string, name: string, url: string, timeout = 5000, b?: Backend, signal?: AbortSignal) =>
    request<{ delay: number }>(`/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(name)}/healthcheck`, {
      query: { url, timeout },
      timeout: timeout + 2000,
      signal,
    }, b),
  rules: () => request<{ rules: Rule[] }>('/rules'),
  ruleProviders: () => request<{ providers: Record<string, RuleProvider> }>('/providers/rules'),
  closeConnection: (id: string) => request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  closeSmartConnection: (id: string, b?: Backend) =>
    request(`/connections/smart/${encodeURIComponent(id)}`, { method: 'DELETE' }, b),
  closeAll: () => request('/connections', { method: 'DELETE' }),
  flushFakeIp: () => request('/cache/fakeip/flush', { method: 'POST' }),
  flushDns: () => request('/cache/dns/flush', { method: 'POST' }),
  flushSmart: (config?: string, b?: Backend) =>
    request(`/cache/smart/flush${config ? '/' + encodeURIComponent(config) : ''}`, { method: 'POST' }, b),
  upgradeLightGBM: (b?: Backend) => request('/upgrade/lgbm', { method: 'POST', timeout: 120000 }, b),
  restart: () => request('/restart', { method: 'POST', body: { path: '', payload: '' } }),
  reloadConfig: () => request('/configs', { method: 'PUT', query: { force: 'true' }, body: { path: '', payload: '' } }),
}
