import {
  api,
  ApiError,
  errorMessage,
  initialBackend,
  saveBackend,
  stream,
  useBackend,
  type Backend,
  type Configs,
  type ConnSnapshot,
  type Connection,
  type Mode,
} from './api'
import { t } from './i18n.svelte'
import { AnalysisTracker } from './analysis'
import { TrafficHistory } from './traffic-history'
import { connectionJournal } from './connection-journal.svelte'
import { notifications } from './notifications.svelte'
import { ConnectionRates, readLiveUpdateMode, saveLiveUpdateMode, validLiveUpdateMode, type LiveUpdateMode } from './live-updates'

export type ConnRow = Connection & { dl: number; ul: number }

const WINDOW = 90 // секунд истории трафика

class Core {
  status = $state<'boot' | 'setup' | 'connecting' | 'ok' | 'lost'>('boot')
  #connectionError = $state.raw<unknown>(null)
  get error(): string {
    const error = this.#connectionError
    if (!error) return ''
    if (error instanceof ApiError && error.status === 401) return t('error.invalidSecret')
    if (error instanceof ApiError && error.status === 0) return t('error.connection', { url: this.backend.url })
    return errorMessage(error)
  }
  version = $state('')
  prizrak = $state(false)
  backend = $state<Backend>({ url: '', secret: '' })

  up = $state(0)
  down = $state(0)
  trafficReady = $state(false)
  trafficOnline = $state(false)
  upTotal = $state(0)
  downTotal = $state(0)
  memory = $state(0)
  memoryReady = $state(false)
  memoryOnline = $state(false)
  /** счётчик кадров — график перерисовывается по нему, массивы не реактивны */
  tick = $state(0)
  readonly series: { t: number[]; up: number[]; down: number[] } = { t: [], up: [], down: [] }
  readonly trafficHistory = new TrafficHistory()

  conns = $state.raw<ConnRow[]>([])
  connectionsReady = $state(false)
  connectionsFresh = $state(false)
  connectionsOnline = $state(false)
  #analysisTracker = new AnalysisTracker()
  analysis = $state.raw(this.#analysisTracker.snapshot())
  configs = $state<Configs | null>(null)
  streamsOpen = $state(0)
  liveUpdateMode = $state<LiveUpdateMode>(readLiveUpdateMode())
  liveUpdateSaved = $state(true)
  updatesPaused = $state(false)
  updatesResuming = $state(false)
  staleStreams = $state<string[]>([])
  observationGapVersion = $state(0)

  #stops: Array<() => void> = []
  #rates = new ConnectionRates()
  #generation = 0

  constructor() {
    const now = Math.floor(Date.now() / 1000)
    for (let i = WINDOW; i > 0; i--) {
      this.series.t.push(now - i)
      this.series.up.push(0)
      this.series.down.push(0)
    }
    document.addEventListener?.('visibilitychange', () => this.#syncVisibility())
  }

  async boot() {
    const query = new URLSearchParams(location.search)
    const hashQuery = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const fromLink = ['hostname', 'secret'].some((key) => query.has(key) || hashQuery.has(key))
    const b = initialBackend()
    if (b) this.backend = b
    if (!b || (router.route === 'setup' && !fromLink)) {
      this.status = 'setup'
      return
    }
    if (await this.connect(b)) {
      if (router.route === 'setup') router.go('overview')
    }
  }

  async connect(b: Backend): Promise<boolean> {
    const generation = ++this.#generation
    this.#stop()
    this.#reset()
    this.status = 'connecting'
    this.#connectionError = null
    try {
      const v = await api.version(b)
      if (generation !== this.#generation) return false
      useBackend(b)
      saveBackend(b)
      this.backend = b
      void connectionJournal.activateBackend(b.url)
      this.version = v.version
      // REST доступен, но связь считается живой только после открытия WebSocket.
      this.status = 'lost'
      this.#start(generation)
      void this.refreshConfigs()
      void this.#detectPrizrak(generation, b)
      return true
    } catch (e) {
      if (generation !== this.#generation) return false
      this.status = 'setup'
      this.backend = b
      this.#connectionError = e
      return false
    }
  }

  disconnect() {
    ++this.#generation
    this.#stop()
    this.#reset()
    void connectionJournal.activateBackend('')
    this.clearError()
    this.status = 'setup'
    if (location.hash !== '#/setup') location.hash = '/setup'
  }

  clearError() {
    this.#connectionError = null
  }

  async refreshConfigs() {
    const generation = this.#generation
    try {
      const configs = await api.configs()
      if (generation === this.#generation) {
        this.configs = configs
        // Version strings may be identical to mihomo; use the advertised API fields.
        if (typeof configs['lgbm-auto-update'] === 'boolean' ||
          typeof configs['lgbm-update-interval'] === 'number' || typeof configs['lgbm-url'] === 'string' ||
          typeof configs['smart-collector-size'] === 'number') {
          this.prizrak = true
        }
      }
    } catch {
      /* не критично */
    }
  }

  async #detectPrizrak(generation: number, b: Backend) {
    try {
      const data = await api.proxies(b)
      if (generation === this.#generation && data?.proxies && typeof data.proxies === 'object' &&
        !Array.isArray(data.proxies) && Object.values(data.proxies).some((proxy) => proxy?.type === 'Smart')) this.prizrak = true
    } catch {
      // Optional metadata must not affect connection status. Avoid unsupported-endpoint probes on mihomo.
    }
  }

  async setMode(mode: Mode) {
    if (!this.configs) return
    const generation = this.#generation
    const backend = { ...this.backend }
    const prev = this.configs.mode
    this.configs.mode = mode
    try {
      await api.patchConfigs({ mode }, backend)
      if (generation === this.#generation) notifications.dismiss('routing-mode')
    } catch (error) {
      if (generation === this.#generation && this.configs) {
        this.configs.mode = prev
        notifications.show({ id: 'routing-mode', tone: 'error', scope: backend.url,
          message: () => t('notifications.modeError', { message: errorMessage(error) }) })
      }
    }
  }

  resetAnalysis() {
    this.#analysisTracker.reset()
    if (this.connectionsReady && this.connectionsOnline) this.#analysisTracker.ingest(this.conns)
    this.analysis = this.#analysisTracker.snapshot()
  }

  setLiveUpdateMode(value: LiveUpdateMode): boolean {
    if (!validLiveUpdateMode(value)) return false
    this.liveUpdateMode = value
    this.liveUpdateSaved = saveLiveUpdateMode(value)
    this.#syncVisibility()
    return this.liveUpdateSaved
  }

  #syncVisibility() {
    if (this.status !== 'ok' && this.status !== 'lost') return
    const pause = this.liveUpdateMode === 'eco' && document.hidden
    if (pause && !this.updatesPaused) {
      this.updatesPaused = true
      this.updatesResuming = false
      this.observationGapVersion++
      this.#stop(false)
    } else if (!pause && this.updatesPaused) {
      this.updatesPaused = false
      this.updatesResuming = true
      this.#start(this.#generation)
    }
  }

  #stale(path: string) {
    if (!this.staleStreams.length) this.observationGapVersion++
    if (!this.staleStreams.includes(path)) this.staleStreams = [...this.staleStreams, path]
  }

  #received(path: string) {
    if (this.staleStreams.includes(path)) this.staleStreams = this.staleStreams.filter(value => value !== path)
    if (this.trafficReady && this.memoryReady && this.connectionsFresh) this.updatesResuming = false
  }

  #start(generation: number) {
    if (this.liveUpdateMode === 'eco' && document.hidden) { this.#syncVisibility(); return }
    this.#rates.reset()
    const onState = (open: boolean) => {
      if (generation !== this.#generation) return
      this.streamsOpen += open ? 1 : -1
      if (this.status === 'ok' || this.status === 'lost') this.status = this.streamsOpen > 0 ? 'ok' : 'lost'
    }

    this.#stops.push(
      stream<{ up: number; down: number; upTotal?: number; downTotal?: number }>(
        '/traffic',
        (d) => {
          if (generation !== this.#generation) return
          this.up = d.up
          this.down = d.down
          if (d.upTotal !== undefined) this.upTotal = d.upTotal
          if (d.downTotal !== undefined) this.downTotal = d.downTotal
          const s = this.series
          s.t.push(Math.floor(Date.now() / 1000))
          s.up.push(d.up)
          s.down.push(d.down)
          if (s.t.length > WINDOW) {
            s.t.shift()
            s.up.shift()
            s.down.shift()
          }
          this.trafficHistory.append(Date.now() / 1000, d.down, d.up)
          this.trafficReady = true
          this.#received('/traffic')
          this.tick++
        },
        { onStale: () => { if (generation === this.#generation) this.#stale('/traffic') }, onState: (open) => {
          if (generation !== this.#generation) return
          this.trafficOnline = open
          if (!open) {
            this.trafficReady = false
            this.trafficHistory.pause()
          }
          onState(open)
        } },
      ),
      stream<{ inuse: number }>('/memory', (d) => {
        if (generation !== this.#generation) return
        this.memory = d.inuse
        this.memoryReady = true
        this.#received('/memory')
      }, { onStale: () => { if (generation === this.#generation) this.#stale('/memory') }, onState: (open) => {
        if (generation !== this.#generation) return
        this.memoryOnline = open
        if (!open) this.memoryReady = false
        onState(open)
      } }),
      stream<ConnSnapshot>(
        '/connections',
        (d) => {
          if (generation !== this.#generation) return
          this.upTotal = d.uploadTotal
          this.downTotal = d.downloadTotal
          this.conns = this.#rates.sample(d.connections ?? [])
          connectionJournal.observe(d.connections ?? [])
          this.#analysisTracker.ingest(d.connections ?? [])
          this.analysis = this.#analysisTracker.snapshot()
          this.connectionsReady = true
          this.connectionsFresh = true
          this.#received('/connections')
        },
        { query: { interval: 1000 }, onStale: () => { if (generation === this.#generation) this.#stale('/connections') }, onState: (open) => {
          if (generation !== this.#generation) return
          this.connectionsOnline = open
          if (!open) {
            this.connectionsFresh = false
            this.#rates.reset()
            connectionJournal.pause()
          }
          onState(open)
        } },
      ),
    )
  }

  #stop(resetJournal = true) {
    connectionJournal.pause(resetJournal)
    this.#stops.forEach((s) => s())
    this.#stops = []
    this.streamsOpen = 0
    this.trafficReady = false
    this.trafficOnline = false
    this.memoryReady = false
    this.memoryOnline = false
    this.connectionsFresh = false
    this.connectionsOnline = false
    this.#rates.reset()
    this.trafficHistory.pause()
  }

  #reset() {
    this.#rates.reset()
    this.updatesPaused = false
    this.updatesResuming = false
    this.staleStreams = []
    this.observationGapVersion = 0
    this.up = 0
    this.down = 0
    this.trafficReady = false
    this.trafficOnline = false
    this.upTotal = 0
    this.downTotal = 0
    this.memory = 0
    this.memoryReady = false
    this.memoryOnline = false
    this.version = ''
    this.prizrak = false
    this.conns = []
    this.connectionsReady = false
    this.connectionsFresh = false
    this.configs = null
    this.resetAnalysis()
    this.trafficHistory.reset()
    const now = Math.floor(Date.now() / 1000)
    this.series.t.length = 0
    this.series.up.length = 0
    this.series.down.length = 0
    for (let i = WINDOW; i > 0; i--) {
      this.series.t.push(now - i)
      this.series.up.push(0)
      this.series.down.push(0)
    }
    this.tick++
  }
}

export const core = new Core()

// ——— маршрутизация по hash ———

export const ROUTES = ['overview', 'proxies', 'devices', 'connections', 'analysis', 'geography', 'rules', 'logs', 'settings', 'setup'] as const
export type Route = (typeof ROUTES)[number]

function parseRoute(): Route {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0] as Route
  return ROUTES.includes(r) ? r : 'overview'
}

class Router {
  route = $state<Route>(parseRoute())
  constructor() {
    addEventListener('hashchange', () => {
      const next = parseRoute()
      this.route = next
    })
  }
  go(route: Route) {
    this.route = route
    location.hash = '/' + route
  }
}
export const router = new Router()

// ——— тема ———

export type Theme = 'system' | 'dark' | 'light'
class ThemeState {
  value = $state<Theme>('system')
  constructor() {
    try {
      const t = localStorage.getItem('miboard.theme')
      if (t === 'dark' || t === 'light') this.value = t
    } catch {
      /* ок */
    }
  }
  set(t: Theme) {
    this.value = t
    if (t === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
    try {
      if (t === 'system') localStorage.removeItem('miboard.theme')
      else localStorage.setItem('miboard.theme', t)
    } catch {
      /* ок */
    }
  }
}
export const theme = new ThemeState()
