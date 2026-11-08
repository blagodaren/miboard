import type { Delay, Proxy } from './api'

export type DelaySettings = {
  mode: 'core' | 'panel'
  url: string
  timeout: number
  yellow: number
  red: number
  ipv6: boolean
  independent: boolean
}

export const DELAY_STORAGE_KEY = 'miboard.latency.v1'
export const IPV6_TEST_URL = 'https://ipv6.google.com/generate_204'
export const DEFAULT_DELAY_SETTINGS: Readonly<DelaySettings> = Object.freeze({
  mode: 'core',
  url: 'https://cp.cloudflare.com/generate_204',
  timeout: 15000,
  yellow: 400,
  red: 800,
  ipv6: false,
  independent: false,
})

export function validDelaySettings(value: unknown): value is DelaySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const settings = value as DelaySettings
  if (typeof settings.ipv6 !== 'boolean' || typeof settings.independent !== 'boolean') return false
  if (settings.mode !== 'core' && settings.mode !== 'panel') return false
  if (typeof settings.url !== 'string' || !/^https?:\/\//i.test(settings.url) || /[\u0000-\u0020\u007f]/.test(settings.url)) return false
  try {
    const url = new URL(settings.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  } catch {
    return false
  }
  // mihomo's per-node endpoint parses timeout as a signed 16-bit integer.
  return Number.isInteger(settings.timeout) && settings.timeout >= 1 && settings.timeout <= 32767
    && Number.isInteger(settings.yellow) && settings.yellow >= 1 && settings.yellow <= 60000
    && Number.isInteger(settings.red) && settings.red > settings.yellow && settings.red <= 60000
}

export function readDelaySettings(): DelaySettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DELAY_STORAGE_KEY) ?? 'null')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Existing installations retain their URL, timeout and thresholds.
      const migrated = { ipv6: false, independent: false, ...value }
      if (validDelaySettings(migrated)) return migrated
    }
  } catch {
    // Corrupt preferences and unavailable storage use the same safe defaults.
  }
  return { ...DEFAULT_DELAY_SETTINGS }
}

export function saveDelaySettings(settings: DelaySettings): boolean {
  if (!validDelaySettings(settings)) return false
  try {
    localStorage.setItem(DELAY_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // Valid preferences still apply for this browser session.
  }
  return true
}

export function delayTestUrl(group: Proxy, settings: DelaySettings): string {
  return settings.independent ? group.testUrl || settings.url : settings.url
}

/** A group without a selected leaf cannot prove IPv6 connectivity via its own URLTest. */
export function resolveProxyLeaf(name: string, metadata: (name: string) => Proxy | undefined): string | undefined {
  const seen = new Set<string>()
  let current = name
  while (!seen.has(current)) {
    seen.add(current)
    const proxy = metadata(current)
    if (!proxy) return undefined
    if (!proxy.all) return current
    if (!proxy.now) return undefined
    current = proxy.now
  }
  return undefined
}

export function delayMeasurementName(name: string, independent: boolean, metadata: (name: string) => Proxy | undefined): string {
  return independent ? name : resolveProxyLeaf(name, metadata) ?? name
}

export function delayHistorySample(name: string, url: string, independent: boolean, metadata: (name: string) => Proxy | undefined): Delay | undefined {
  const proxy = metadata(name)
  if (independent && proxy?.extra) return proxyDelaySample(proxy, url)
  const leaf = resolveProxyLeaf(name, metadata)
  const leafProxy = leaf ? metadata(leaf) : undefined
  // A shared result still belongs to the requested URL. Background checks for
  // another URL can replace generic history after a manual request completes.
  if (!independent && leafProxy?.extra && Object.hasOwn(leafProxy.extra, url)) {
    return proxyDelaySample(leafProxy, url)
  }
  const history = leafProxy?.history
  // The optional IPv6 probe also updates mihomo's generic history. It is never
  // a substitute for the normal delay, including after a failed main request.
  const ipv6History = url !== IPV6_TEST_URL ? leafProxy?.extra?.[IPV6_TEST_URL]?.history : undefined
  for (let index = (history?.length ?? 0) - 1; index >= 0; index--) {
    const sample = history![index]
    if (!ipv6History?.some((ipv6) => ipv6.time === sample.time && ipv6.delay === sample.delay)) return sample
  }
  return undefined
}

export function proxyDelaySample(proxy: Proxy | undefined, url: string): Delay | undefined {
  // With URL-specific histories, the generic history may belong to a different test.
  const history = proxy?.extra ? proxy.extra[url]?.history : proxy?.history
  return history?.[history.length - 1]
}

export function proxyDelayValue(proxy: Proxy | undefined, url: string): number | undefined {
  const delay = proxyDelaySample(proxy, url)?.delay
  return typeof delay === 'number' && Number.isFinite(delay) ? delay : undefined
}

export type DelayTarget = { name: string; provider?: string }
export type DelayClient = {
  groupDelay: (group: string, url: string, timeout: number, signal?: AbortSignal) => Promise<Record<string, number>>
  proxyDelay: (target: DelayTarget, url: string, timeout: number, signal?: AbortSignal) => Promise<{ delay: number }>
}

/** One scheduler per connected page: overlapping groups share in-flight node tests. */
export function createDelayTester(client: DelayClient, concurrency = 5) {
  const limit = Math.max(1, Math.floor(concurrency) || 5)
  let active = 0
  const queue: Array<() => void> = []
  const pending = new Map<string, Promise<{ delay: number }>>()
  let batchCache: Map<string, Promise<{ delay: number }>> | null = null
  const controller = new AbortController()
  let disposed = false

  function nodeTest(target: DelayTarget, settings: DelaySettings): Promise<{ delay: number }> {
    const key = JSON.stringify([target.provider ?? null, target.name, settings.url, settings.timeout])
    const existing = batchCache?.get(key) ?? pending.get(key)
    if (existing) {
      // A request started before the campaign may still serve its first group.
      batchCache?.set(key, existing)
      return existing
    }
    const promise = new Promise<{ delay: number }>((resolve, reject) => {
      const start = () => {
        if (disposed) {
          pending.delete(key)
          reject(new Error('Latency test cancelled'))
          return
        }
        active++
        Promise.resolve().then(() => {
          if (disposed) throw new Error('Latency test cancelled')
          return client.proxyDelay(target, settings.url, settings.timeout, controller.signal)
        })
          .then(resolve, reject)
          .finally(() => {
            active--
            pending.delete(key)
            queue.shift()?.()
          })
      }
      if (active < limit) start()
      else queue.push(start)
    })
    pending.set(key, promise)
    batchCache?.set(key, promise)
    return promise
  }

  return {
    beginBatch(): () => void {
      if (disposed) return () => {}
      const cache = new Map<string, Promise<{ delay: number }>>()
      batchCache = cache
      return () => {
        // A late cleanup from an older campaign must not clear the current one.
        if (batchCache !== cache) return
        cache.clear()
        batchCache = null
      }
    },
    dispose(): void {
      disposed = true
      batchCache?.clear()
      batchCache = null
      controller.abort()
      while (queue.length) queue.shift()?.()
    },
    async testNode(target: DelayTarget, settings: DelaySettings): Promise<{ delay: number }> {
      if (disposed) throw new Error('Latency test cancelled')
      // A ping click always checks one endpoint, even when group tests use core mode.
      const result = await nodeTest(target, settings)
      if (disposed) throw new Error('Latency test cancelled')
      return { delay: Number.isFinite(result.delay) && result.delay > 0 ? result.delay : 0 }
    },
    async testIPv6(targets: DelayTarget[], timeout: number, onResult: (name: string, supported: boolean) => void): Promise<void> {
      if (disposed) return
      const settings = { ...DEFAULT_DELAY_SETTINGS, mode: 'panel' as const, url: IPV6_TEST_URL, timeout: Math.min(2000, timeout) }
      const unique = [...new Map(targets.map((target) => [JSON.stringify([target.provider ?? null, target.name]), target])).values()]
      await Promise.all(unique.map(async (target) => {
        let supported = false
        try {
          const result = await nodeTest(target, settings)
          supported = Number.isFinite(result.delay) && result.delay > 0
        } catch {
          // Failure of the optional IPv6 probe must not prevent the normal test.
        }
        if (!disposed) onResult(target.name, supported)
      }))
    },
    async testGroup(group: string, targets: DelayTarget[], settings: DelaySettings, onResult: (name: string, delay: number) => void): Promise<void> {
      if (disposed) throw new Error('Latency test cancelled')
      const unique = [...new Map(targets.map((target) => [target.name, target])).values()]
      if (!unique.length) return
      if (settings.mode === 'core') {
        const results = await client.groupDelay(group, settings.url, settings.timeout, controller.signal)
        if (disposed) return
        for (const target of unique) {
          const delay = results[target.name]
          onResult(target.name, typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 0)
        }
        return
      }

      let failed = 0
      let lastError: unknown
      await Promise.all(unique.map(async (target) => {
        let delay = 0
        try {
          const result = await nodeTest(target, settings)
          if (Number.isFinite(result.delay) && result.delay > 0) delay = result.delay
        } catch (error) {
          failed++
          lastError = error
        }
        if (!disposed) onResult(target.name, delay)
      }))
      if (failed === unique.length) throw lastError
    },
  }
}
