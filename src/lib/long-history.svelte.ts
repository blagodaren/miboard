import type { Connection } from './api'
import { HistoryAccumulator, HISTORY_RETENTION, mergeHistoryBucket, validHistoryCollector, type HistoryBucket } from './long-history'
import { HistoryDatabase, historyRandomId } from './long-history-store'

class LongHistory {
  backendUrl = $state('')
  buckets = $state.raw<HistoryBucket[]>([])
  loading = $state(false)
  clearing = $state(false)
  storageState = $state<'persistent' | 'memory'>('persistent')
  recording = $state<'paused' | 'recording' | 'otherTab'>('paused')
  collector = ''
  #owner = historyRandomId()
  #db = new HistoryDatabase()
  #accumulator = new HistoryAccumulator()
  #generation = 0
  #activation = 0
  #busy = false
  #lastRead = 0
  #channel: BroadcastChannel | null = null
  constructor() {
    try {
      const key = 'miboard.history.collector'
      const saved = localStorage.getItem(key)
      this.collector = validHistoryCollector(saved) ? saved : historyRandomId()
      localStorage.setItem(key, this.collector)
    } catch { this.collector = historyRandomId() }
    const refreshCleared = (value: unknown) => {
      if (value && typeof value === 'object' && 'backend' in value
        && value.backend === this.backendUrl && this.backendUrl) void this.activateBackend(this.backendUrl)
    }
    try {
      this.#channel = new BroadcastChannel('miboard-long-history-cleared')
      this.#channel.onmessage = event => refreshCleared(event.data)
    } catch { /* Storage events cover browsers without BroadcastChannel. */ }
    window.addEventListener('storage', event => {
      if (event.key !== 'miboard.history.cleared' || !event.newValue) return
      try { refreshCleared(JSON.parse(event.newValue)) } catch { /* Ignore unrelated values. */ }
    })
    setInterval(() => {
      const now = Date.now()
      this.buckets = this.buckets.filter(row => row.hour >= now - HISTORY_RETENTION)
      if (this.storageState === 'persistent') void this.#db.prune(now).catch(() => {})
    }, 60_000)
    window.addEventListener('pagehide', () => this.pause())
  }
  async activateBackend(url: string) {
    this.pause()
    const generation = ++this.#activation
    this.backendUrl = url; this.buckets = []; this.loading = !!url
    if (!url) return
    try {
      const buckets = await this.#db.read(url)
      if (generation !== this.#activation) return
      this.buckets = buckets; this.storageState = 'persistent'
      void this.#db.prune().catch(() => {})
    } catch { if (generation === this.#activation) this.storageState = 'memory' }
    finally { if (generation === this.#activation) this.loading = false }
  }
  pause() {
    ++this.#generation
    this.#accumulator.reset(); this.recording = 'paused'
    void this.#db.release(this.backendUrl, this.#owner).catch(() => {})
  }
  async clear(backend = this.backendUrl): Promise<boolean> {
    if (!backend || backend !== this.backendUrl || this.loading || this.clearing) return false
    this.clearing = true
    this.pause()
    const persistent = this.storageState === 'persistent'
    try {
      if (persistent) await this.#db.clear(backend)
      if (backend === this.backendUrl) {
        this.buckets = []
        this.#accumulator.reset()
        this.#lastRead = 0
      }
      if (persistent) {
        const notification = { backend, revision: historyRandomId() }
        try {
          if (this.#channel) this.#channel.postMessage(notification)
          else localStorage.setItem('miboard.history.cleared', JSON.stringify(notification))
        } catch { /* Other tabs still reset their baseline through the cleared lease. */ }
      }
      return true
    } finally { this.clearing = false }
  }
  observe(connections: readonly Connection[], now = Date.now()) {
    if (!this.backendUrl || this.loading || this.clearing || this.#busy) return
    const generation = this.#generation, url = this.backendUrl
    const current = () => generation === this.#generation && url === this.backendUrl
    const merge = (changed: HistoryBucket[]) => {
      const map = new Map(this.buckets.filter(row => row.hour >= now - HISTORY_RETENTION).map(row => [row.hour, row]))
      changed.forEach(row => map.set(row.hour, row))
      this.buckets = [...map.values()].sort((a, b) => a.hour - b.hour)
    }
    if (this.storageState === 'memory') {
      const old = new Map(this.buckets.map(row => [row.hour, row]))
      merge(this.#accumulator.observe(connections, now).map(delta => mergeHistoryBucket(old.get(delta.hour), delta)))
      this.recording = 'recording'; return
    }
    this.#busy = true
    void this.#db.observe(url, this.#owner, this.#accumulator, connections, now, current).then(async result => {
      if (!current()) return
      this.recording = result.leader ? 'recording' : 'otherTab'
      if (result.leader) merge(result.buckets)
      else if (now - this.#lastRead >= 5000) {
        this.#lastRead = now
        const buckets = await this.#db.read(url, now)
        if (current()) this.buckets = buckets
      }
    }).catch(() => { if (current()) { this.storageState = 'memory'; this.#accumulator.reset() } })
      .finally(() => { this.#busy = false })
  }
}
export const longHistory = new LongHistory()
