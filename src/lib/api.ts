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

function mayBeMixedContent(url: URL): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || url.protocol !== 'http:') return false
  const host = url.hostname.replace(/\.$/, '')
  // Loopback origins are potentially trustworthy. Do not mislabel their CORS/network failures.
  return host !== 'localhost' && !host.endsWith('.localhost') && host !== '[::1]' && !/^127\./.test(host)
}

export async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number>; timeout?: number; signal?: AbortSignal } = {},
  b: Backend = current,
): Promise<T> {
  const url = new URL(b.url + path)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v))
  const ctrl = new AbortController()
  let timedOut = false
  let responseReceived = false
  const abort = () => { if (!ctrl.signal.aborted) ctrl.abort() }
  if (init.signal?.aborted) abort()
  else init.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    if (!ctrl.signal.aborted) { timedOut = true; ctrl.abort() }
  }, init.timeout ?? 10000)
  try {
    ctrl.signal.throwIfAborted()
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(b.secret ? { Authorization: `Bearer ${b.secret}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    })
    responseReceived = true
    ctrl.signal.throwIfAborted()
    if (!res.ok) {
      let msg = res.statusText
      try {
        const j: unknown = await res.json()
        if (record(j)) msg = (typeof j.message === 'string' ? j.message : typeof j.error === 'string' ? j.error : '') || msg
      } catch {
        // HTTP errors may have no JSON body; cancellation still takes precedence.
        ctrl.signal.throwIfAborted()
      }
      throw new ApiError(res.status, msg || `HTTP ${res.status}`)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    ctrl.signal.throwIfAborted()
    try {
      return (text ? JSON.parse(text) : undefined) as T
    } catch {
      throw new ApiError(res.status, t('error.invalidJson'), 'error.invalidJson')
    }
  } catch (error) {
    if (ctrl.signal.aborted && !timedOut) throw ctrl.signal.reason
    if (error instanceof ApiError) throw error
    const key = timedOut ? 'error.timeout'
      : !responseReceived && mayBeMixedContent(url) ? 'error.mixedContent' : 'error.offline'
    throw new ApiError(0, t(key), key)
  } finally {
    // The deadline and caller cancellation also cover a slow response body.
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
}

/** WebSocket с переподключением. Возвращает функцию закрытия */
export function stream<T>(
  path: string,
  onData: (data: T) => void,
  opts: {
    query?: Record<string, string | number>
    onState?: (open: boolean) => void
    onStale?: () => void
    /** Includes failures before opening, for optional protocol negotiation. */
    onFailure?: () => void
    idleTimeoutMs?: number
    connectTimeoutMs?: number
  } = {},
): () => void {
  // Each stream belongs to the controller that created it, including every retry.
  const backend = { ...current }
  const idleTimeout = opts.idleTimeoutMs ?? (['/traffic', '/connections', '/memory'].includes(path) ? 15000 : 0)
  const connectTimeout = opts.connectTimeoutMs ?? 10000
  let ws: WebSocket | null = null
  let closed = false
  let delay = 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let opened = false
  let deadline = 0

  const clearWatchdog = () => { clearTimeout(watchdog); watchdog = undefined; deadline = 0 }
  const retry = () => {
    if (closed || timer !== undefined) return
    const wait = Math.min(15000, Math.round(delay * (0.8 + Math.random() * 0.4)))
    delay = Math.min(delay * 2, 15000)
    timer = setTimeout(() => { timer = undefined; open() }, wait)
  }
  const fail = (socket: WebSocket, stale = false) => {
    if (closed || ws !== socket) return
    ws = null
    clearWatchdog()
    if (opened) { opened = false; opts.onState?.(false) }
    if (stale) opts.onStale?.()
    // Invalidate before close: native close/error events can arrive later.
    try { socket.close() } catch { /* The failed socket is already abandoned. */ }
    opts.onFailure?.()
    retry()
  }
  const arm = (socket: WebSocket, timeout: number) => {
    clearWatchdog()
    if (closed || ws !== socket || !(timeout > 0)) return
    deadline = Date.now() + timeout
    watchdog = setTimeout(() => fail(socket, true), timeout)
  }

  const open = () => {
    if (closed) return
    const url = new URL(backend.url.replace(/^http/, 'ws') + path)
    if (backend.secret) url.searchParams.set('token', backend.secret)
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v))
    let socket: WebSocket
    try { socket = new WebSocket(url) } catch { opts.onStale?.(); opts.onFailure?.(); retry(); return }
    ws = socket
    opened = false
    arm(socket, connectTimeout)
    socket.onopen = () => {
      if (closed || ws !== socket || opened) return
      if (deadline && Date.now() >= deadline) { fail(socket, true); return }
      opened = true
      opts.onState?.(true)
      arm(socket, idleTimeout)
    }
    socket.onmessage = (e) => {
      if (closed || ws !== socket || !opened) return
      // A queued frame after sleep must not erase an unobserved interval before wake runs.
      if (deadline && Date.now() >= deadline) { fail(socket, true); return }
      try {
        onData(JSON.parse(e.data))
        // A TCP handshake alone does not prove that telemetry is flowing.
        delay = 1000
        arm(socket, idleTimeout)
      } catch {
        /* Invalid frames do not keep a stalled stream alive. */
      }
    }
    socket.onclose = () => fail(socket)
    socket.onerror = () => fail(socket)
  }
  // Timers may be throttled while a tab or device sleeps. Check wall time on return.
  const wake = () => {
    if (closed || document.hidden) return
    if (ws && deadline && Date.now() >= deadline) fail(ws, true)
  }
  document.addEventListener?.('visibilitychange', wake)
  globalThis.addEventListener?.('online', wake)
  open()
  return () => {
    closed = true
    clearTimeout(timer)
    clearWatchdog()
    document.removeEventListener?.('visibilitychange', wake)
    globalThis.removeEventListener?.('online', wake)
    ws?.close()
    ws = null
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
  uot?: boolean
  xudp?: boolean
  tfo?: boolean
  mptcp?: boolean
  smux?: boolean
  interface?: string
  'routing-mark'?: number
  'dialer-proxy'?: string
  expectedStatus?: string
  emptyFallback?: string
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
  /** mihomo serializes the provider's configured HealthCheckURL as testUrl. */
  testUrl?: string
  expectedStatus?: string
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
  sourceGeoIP?: string[] | null
  destinationGeoIP?: string[] | null
  sourceIPASN?: string
  destinationIPASN?: string
  host: string
  sniffHost?: string
  process?: string
  processPath?: string
  remoteDestination?: string
  inboundIP?: string
  inboundPort?: string
  inboundName?: string
  inboundUser?: string
  rematchName?: string
  dnsMode?: string
  uid?: number
  specialProxy?: string
  specialRules?: string
  dscp?: number
  id?: string
  smartBlock?: string
  smartTarget?: string
  wildcardTarget?: string
  exitGeoIP?: string
  exitIPASN?: string
}
export type Connection = {
  id: string
  metadata: ConnMeta
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains?: string[] | null
  rule: string
  rulePayload: string
  maxUploadRate?: number
  maxDownloadRate?: number
  downloadSpeed?: number
  uploadSpeed?: number
}
export type ConnSnapshot = {
  downloadTotal: number
  uploadTotal: number
  connections: Connection[] | null
  memory?: number
}

export type Rule = {
  type: string; payload: string; proxy: string; size?: number
  index?: number
  extra?: { disabled: boolean; hitCount: number; hitAt: string; missCount: number; missAt: string }
}
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
export type TunConfigs = {
  'enable': boolean
  'device'?: string
  'stack'?: string
  'dns-mode'?: string
  'dns-hijack'?: string[]
  'auto-route'?: boolean
  'auto-detect-interface'?: boolean
  'mtu'?: number
  'gso'?: boolean
  'gso-max-size'?: number
  'inet4-address'?: string[]
  'inet6-address'?: string[]
  'iproute2-table-index'?: number
  'iproute2-rule-index'?: number
  'auto-redirect'?: boolean
  'auto-redirect-input-mark'?: number
  'auto-redirect-output-mark'?: number
  'auto-redirect-iproute2-fallback-rule-index'?: number
  'loopback-address'?: string[]
  'strict-route'?: boolean
  'route-address'?: string[]
  'route-address-set'?: string[]
  'route-exclude-address'?: string[]
  'route-exclude-address-set'?: string[]
  'include-interface'?: string[]
  'exclude-interface'?: string[]
  'include-uid'?: number[]
  'include-uid-range'?: string[]
  'exclude-uid'?: number[]
  'exclude-uid-range'?: string[]
  'exclude-src-port'?: number[]
  'exclude-src-port-range'?: string[]
  'exclude-dst-port'?: number[]
  'exclude-dst-port-range'?: string[]
  'include-android-user'?: number[]
  'include-package'?: string[]
  'exclude-package'?: string[]
  'include-mac-address'?: string[]
  'exclude-mac-address'?: string[]
  'endpoint-independent-nat'?: boolean
  'udp-timeout'?: number
  'icmp-timeout'?: number
  'disable-icmp-forwarding'?: boolean
  'congestion-controller'?: string
  'file-descriptor'?: number
  'inet4-route-address'?: string[]
  'inet6-route-address'?: string[]
  'inet4-route-exclude-address'?: string[]
  'inet6-route-exclude-address'?: string[]
  'recvmsgx'?: boolean
  'sendmsgx'?: boolean
  [key: string]: unknown
}

export type Configs = {
  mode: Mode
  'log-level': string
  'mixed-port'?: number
  port?: number
  'socks-port'?: number
  'allow-lan'?: boolean
  'unified-delay'?: boolean
  tun?: TunConfigs
  'lan-allowed-ips'?: string[]
  'lan-disallowed-ips'?: string[]
  'skip-auth-prefixes'?: string[]
  /** Runtime /configs contains usernames, not the YAML username:password entries. */
  authentication?: string[]
  'inbound-tfo'?: boolean
  'inbound-mptcp'?: boolean
  'global-ua'?: string
  'etag-support'?: boolean
  ipv6?: boolean
  sniffing?: boolean
  'find-process-mode'?: string
  'tcp-concurrent'?: boolean
  'interface-name'?: string
  'routing-mark'?: number
  'bind-address'?: string
  'redir-port'?: number
  'tproxy-port'?: number
  'geox-url'?: { 'geo-ip'?: string; mmdb?: string; asn?: string; 'geo-site'?: string }
  'geo-auto-update'?: boolean
  'geo-update-interval'?: number
  'geodata-mode'?: boolean
  'geodata-loader'?: string
  'geosite-matcher'?: string
  'keep-alive-idle'?: number
  'keep-alive-interval'?: number
  'disable-keep-alive'?: boolean
  'lgbm-auto-update'?: boolean
  'lgbm-update-interval'?: number
  'lgbm-url'?: string
  'smart-collector-size'?: number
}

export type LogLine = { type: string; payload: string }

export type DnsRecord = { name: string; type: number; TTL: number; data: string }
export type DnsResponse = {
  Status: number
  Answer?: DnsRecord[]
  Authority?: DnsRecord[]
  Additional?: DnsRecord[]
  Question?: { Name: string; Qtype: number; Qclass: number }[]
  TC?: boolean; RD?: boolean; RA?: boolean; AD?: boolean; CD?: boolean
}

// ——— эндпоинты ———

export const api = {
  version: (b?: Backend) => request<Version>('/version', { timeout: 5000 }, b),
  dnsQuery: (name: string, type: string, b?: Backend, signal?: AbortSignal) =>
    request<DnsResponse>('/dns/query', { query: { name, type }, timeout: 5000, signal }, b),
  configs: (b?: Backend, signal?: AbortSignal) => request<Configs>('/configs', { signal }, b),
  patchConfigs: (body: Partial<Configs> | Record<string, unknown>, b?: Backend) => request('/configs', { method: 'PATCH', body }, b),
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
  rules: (b?: Backend, signal?: AbortSignal) => request<{ rules: Rule[] }>('/rules', { signal }, b),
  disableRules: (disabled: Record<string, boolean>, b?: Backend, signal?: AbortSignal) =>
    request<void>('/rules/disable', { method: 'PATCH', body: disabled, signal }, b),
  getStorage: <T = unknown>(key: string, b?: Backend, signal?: AbortSignal) =>
    request<T | null>(`/storage/${encodeURIComponent(key)}`, { signal }, b),
  putStorage: (key: string, value: unknown, b?: Backend, signal?: AbortSignal) =>
    request<void>(`/storage/${encodeURIComponent(key)}`, { method: 'PUT', body: value, signal }, b),
  deleteStorage: (key: string, b?: Backend, signal?: AbortSignal) =>
    request<void>(`/storage/${encodeURIComponent(key)}`, { method: 'DELETE', signal }, b),
  ruleProviders: (b?: Backend, signal?: AbortSignal) =>
    request<{ providers: Record<string, RuleProvider> }>('/providers/rules', { signal }, b),
  updateRuleProvider: (name: string, b?: Backend, signal?: AbortSignal) =>
    request<void>(`/providers/rules/${encodeURIComponent(name)}`, { method: 'PUT', timeout: 30000, signal }, b),
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
