export type NotificationText = string | (() => string)
export type NotificationTone = 'success' | 'error' | 'warning' | 'info'
export type NotificationSection = {
  id?: string
  title: NotificationText
  tone?: 'warning' | 'error' | 'neutral'
  items: { label: NotificationText; description?: NotificationText }[]
}
export type NotificationInput = {
  id?: string
  tone?: NotificationTone
  title?: NotificationText
  message?: NotificationText
  sections?: NotificationSection[]
  scope?: string
  testId?: string
  closeLabel?: NotificationText
  action?: { label: NotificationText; href: string }
}
export type Notification = Omit<NotificationInput, 'id' | 'tone'> & { id: string; tone: NotificationTone; revision: number }
export const NOTIFICATION_LIFETIME = 8000
export const NOTIFICATION_VISIBLE_LIMIT = 3
export const NOTIFICATION_QUEUE_LIMIT = 20
type Clock = { now: () => number; set: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void }
type Lifetime = { remaining: number; started?: number; timer?: unknown; pauses: Set<string> }

/** Queued notices receive their full lifetime only when they become visible. */
export class NotificationCenter {
  #items: Notification[] = []
  #lifetimes = new Map<string, Lifetime>()
  #listeners = new Set<() => void>()
  #paused = new Set<string>()
  #sequence = 0
  #visibleLimit = NOTIFICATION_VISIBLE_LIMIT
  #clock: Clock

  constructor(clock: Clock = {
    now: () => Date.now(), set: (callback, delay) => setTimeout(callback, delay),
    clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }) { this.#clock = clock }

  get entries(): readonly Notification[] { return this.#items }
  get visible(): readonly Notification[] { return this.#items.slice(0, this.#visibleLimit) }
  setVisibleLimit(limit: number) {
    const next = Math.max(1, Math.min(NOTIFICATION_VISIBLE_LIMIT, Number.isFinite(limit) ? Math.floor(limit) : NOTIFICATION_VISIBLE_LIMIT))
    if (next === this.#visibleLimit) return
    this.#visibleLimit = next
    this.#reconcile()
    this.#changed()
  }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  show(input: NotificationInput): string {
    const revision = ++this.#sequence
    const id = input.id ?? `notification-${revision}`
    const index = this.#items.findIndex(item => item.id === id)
    const previous = this.#lifetimes.get(id)
    if (previous) this.#stop(previous)
    this.#lifetimes.set(id, { remaining: NOTIFICATION_LIFETIME, pauses: previous?.pauses ?? new Set() })
    const notice: Notification = { ...input, id, tone: input.tone ?? 'info', revision }
    if (index >= 0) this.#items = this.#items.map((item, i) => i === index ? notice : item)
    else {
      // A burst must never evict an on-screen notice that the user is reading.
      if (this.#items.length >= NOTIFICATION_QUEUE_LIMIT) this.#remove(this.#items[NOTIFICATION_VISIBLE_LIMIT].id)
      this.#items = [...this.#items, notice]
    }
    this.#reconcile()
    this.#changed()
    return id
  }

  dismiss(id: string) {
    if (!this.#lifetimes.has(id)) return
    this.#remove(id)
    this.#reconcile()
    this.#changed()
  }
  clear() {
    for (const lifetime of this.#lifetimes.values()) this.#stop(lifetime)
    this.#lifetimes.clear()
    this.#items = []
    this.#changed()
  }
  dismissOtherScopes(scope: string) {
    const stale = this.#items.filter(item => item.scope !== undefined && item.scope !== scope)
    if (!stale.length) return
    for (const item of stale) this.#remove(item.id)
    this.#reconcile()
    this.#changed()
  }
  pause(id: string, reason: string) {
    const lifetime = this.#lifetimes.get(id)
    if (!lifetime) return
    lifetime.pauses.add(reason)
    this.#stop(lifetime)
  }
  resume(id: string, reason: string) {
    this.#lifetimes.get(id)?.pauses.delete(reason)
    this.#reconcile()
  }
  pauseAll(reason: string) {
    this.#paused.add(reason)
    for (const lifetime of this.#lifetimes.values()) this.#stop(lifetime)
  }
  resumeAll(reason: string) { this.#paused.delete(reason); this.#reconcile() }

  #changed() { for (const listener of this.#listeners) listener() }
  #remove(id: string) {
    const lifetime = this.#lifetimes.get(id)
    if (lifetime) this.#stop(lifetime)
    this.#lifetimes.delete(id)
    this.#items = this.#items.filter(item => item.id !== id)
  }
  #stop(lifetime: Lifetime) {
    if (lifetime.started === undefined) return
    this.#clock.clear(lifetime.timer)
    lifetime.remaining = Math.max(0, lifetime.remaining - Math.max(0, this.#clock.now() - lifetime.started))
    lifetime.timer = undefined
    lifetime.started = undefined
  }
  #reconcile() {
    const visible = new Set(this.visible.map(item => item.id))
    for (const [id, lifetime] of this.#lifetimes) {
      if (!visible.has(id) || this.#paused.size || lifetime.pauses.size) { this.#stop(lifetime); continue }
      if (lifetime.started !== undefined) continue
      lifetime.started = this.#clock.now()
      lifetime.timer = this.#clock.set(() => {
        if (this.#lifetimes.get(id) === lifetime) this.dismiss(id)
      }, lifetime.remaining)
    }
  }
}

export const notificationText = (text?: NotificationText) => typeof text === 'function' ? text() : text ?? ''
