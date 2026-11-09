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
  mode: 'panel',
  url: 'https://www.gstatic.com/generate_204',
  timeout: 5000,
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

/** Dashboard orchestration applies only to groups that can choose individual members. */
export function delayGroupSettings(group: Proxy, settings: DelaySettings): DelaySettings {
  const panel = settings.mode === 'panel' && ['selector', 'loadbalance', 'smart'].includes(group.type.toLowerCase())
  return {
    ...settings,
    mode: panel ? 'panel' : 'core',
    url: delayTestUrl(group, settings),
    timeout: panel ? Math.min(2000, settings.timeout) : Math.max(5000, settings.timeout),
  }
}

const UNTESTABLE_TYPES = new Set(['reject', 'rejectdrop', 'block'])
const BULK_EXCLUDED_TYPES = new Set([
  ...UNTESTABLE_TYPES, 'direct', 'compatible', 'pass', 'passrule', 'rematch',
  'dns', 'relay', 'selector', 'fallback', 'urltest', 'smart', 'loadbalance',
])

export function isLatencyTestable(proxy?: Proxy): boolean {
  return !UNTESTABLE_TYPES.has(proxy?.type.toLowerCase() ?? '')
}

/** Shared Test all measures endpoint nodes, including hidden and unreferenced endpoints. */
export function isBulkLatencyNode(proxy: Proxy): boolean {
  return !proxy.all?.length && !BULK_EXCLUDED_TYPES.has(proxy.type.toLowerCase())
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

export type DelayTarget = { name: string; provider?: string; ipv6Target?: DelayTarget }
export type DelayClient = {
  groupDelay: (group: string, url: string, timeout: number, signal?: AbortSignal) => Promise<Record<string, number>>
  proxyDelay: (target: DelayTarget, url: string, timeout: number, signal?: AbortSignal) => Promise<{ delay: number }>
}

/** One scheduler per connected page: overlapping groups share in-flight node tests. */
export function createDelayTester(client: DelayClient, concurrency = 5) {
  const limit = Math.max(1, Math.floor(concurrency) || 5)
  let active = 0
  const queue: Array<() => void> = []
  type ProbeResult = { name: string; supported: boolean; target: DelayTarget }
  type NodeTest = { promise: Promise<{ delay: number }>; probe: Promise<ProbeResult | undefined> }
  const pending = new Map<string, NodeTest>()
  let batchCache: Map<string, NodeTest> | null = null
  const controller = new AbortController()
  let disposed = false

  const endpoint = (target: DelayTarget): DelayTarget => ({ name: target.name, ...(target.provider ? { provider: target.provider } : {}) })
  const normalizedDelay = (delay: number) => Number.isFinite(delay) && delay > 0 ? delay : 0
  const assertActive = () => { if (disposed) throw new Error('Latency test cancelled') }
  const nodeKey = (target: DelayTarget, settings: DelaySettings, ipv6Target = target.ipv6Target ?? target) => JSON.stringify([
    target.provider ?? null, target.name, settings.url, settings.timeout,
    settings.ipv6 ? [ipv6Target.provider ?? null, ipv6Target.name] : null,
  ])

  function nodeTest(target: DelayTarget, settings: DelaySettings, ipv6Target = target.ipv6Target ?? target): NodeTest {
    const key = nodeKey(target, settings, ipv6Target)
    const existing = batchCache?.get(key) ?? pending.get(key)
    if (existing) {
      // A request started before the campaign may still serve its first group.
      batchCache?.set(key, existing)
      return existing
    }
    let publishProbe!: (result: ProbeResult | undefined) => void
    const probe = new Promise<ProbeResult | undefined>((resolve) => { publishProbe = resolve })
    const promise = new Promise<{ delay: number }>((resolve, reject) => {
      const start = () => {
        if (disposed) {
          pending.delete(key)
          publishProbe(undefined)
          reject(new Error('Latency test cancelled'))
          return
        }
        active++
        Promise.resolve().then(async () => {
          assertActive()
          // A slot covers the complete IPv6 → main sequence, never two global phases.
          if (settings.ipv6) {
            let supported = false
            try {
              const result = await client.proxyDelay(endpoint(ipv6Target), IPV6_TEST_URL, 2000, controller.signal)
              supported = normalizedDelay(result.delay) > 0
            } catch {
              // An optional probe cannot prevent the normal latency measurement.
            }
            assertActive()
            publishProbe({ name: ipv6Target.name, supported, target: endpoint(ipv6Target) })
            // Deliver the probe to subscribers before starting the main request.
            await probe
          } else {
            publishProbe(undefined)
          }
          assertActive()
          return client.proxyDelay(endpoint(target), settings.url, settings.timeout, controller.signal)
        })
          .then(resolve, reject)
          .finally(() => {
            publishProbe(undefined)
            active--
            pending.delete(key)
            queue.shift()?.()
          })
      }
      if (active < limit) start()
      else queue.push(start)
    })
    const operation = { promise, probe }
    pending.set(key, operation)
    batchCache?.set(key, operation)
    return operation
  }

  async function testNode(
    target: DelayTarget,
    settings: DelaySettings,
    onIPv6?: (name: string, supported: boolean, target: DelayTarget) => void,
    ipv6Target?: DelayTarget,
  ): Promise<{ delay: number }> {
    assertActive()
    const operation = nodeTest(target, settings, ipv6Target)
    const [result] = await Promise.all([
      operation.promise,
      operation.probe.then((probe) => {
        if (!disposed && probe) onIPv6?.(probe.name, probe.supported, probe.target)
      }),
    ])
    assertActive()
    return { delay: normalizedDelay(result.delay) }
  }

  async function testGroup(
    group: string,
    targets: DelayTarget[],
    settings: DelaySettings,
    onResult: (name: string, delay: number, target: DelayTarget) => void,
    onIPv6?: (name: string, supported: boolean, target: DelayTarget) => void,
  ): Promise<void> {
    assertActive()
    const unique = [...new Map(targets.map((target) => [settings.mode === 'core' ? target.name : nodeKey(target, settings), target])).values()]
    if (!unique.length) return
    if (settings.mode === 'core') {
      if (settings.ipv6) {
        let results: Record<string, number> = {}
        try {
          results = await client.groupDelay(group, IPV6_TEST_URL, settings.timeout, controller.signal)
        } catch {
          // Group IPv6 failure remains separate from the main group test.
        }
        if (disposed) return
        for (const target of unique) onIPv6?.(target.name, normalizedDelay(results[target.name]) > 0, target)
      }
      if (disposed) return
      const results = await client.groupDelay(group, settings.url, settings.timeout, controller.signal)
      if (disposed) return
      for (const target of unique) onResult(target.name, normalizedDelay(results[target.name]), target)
      return
    }

    let failed = 0
    let lastError: unknown
    await Promise.all(unique.map(async (target) => {
      let delay = 0
      try {
        const result = await testNode(target, settings, onIPv6)
        delay = result.delay
      } catch (error) {
        failed++
        lastError = error
      }
      if (!disposed) onResult(target.name, delay, target)
    }))
    if (failed === unique.length) throw lastError
  }

  return {
    beginBatch(): () => void {
      if (disposed) return () => {}
      const cache = new Map<string, NodeTest>()
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
    testNode,
    testGroup,
    testNodes(targets: DelayTarget[], settings: DelaySettings, onResult: (name: string, delay: number, target: DelayTarget) => void, onIPv6?: (name: string, supported: boolean, target: DelayTarget) => void): Promise<void> {
      return testGroup('', targets, { ...settings, mode: 'panel', timeout: Math.min(2000, settings.timeout) }, onResult, onIPv6)
    },
    /** Compatibility for standalone probes; application tests use the complete node pipeline. */
    async testIPv6(targets: DelayTarget[], _timeout: number, onResult: (name: string, supported: boolean) => void): Promise<void> {
      if (disposed) return
      const settings = { ...DEFAULT_DELAY_SETTINGS, mode: 'panel' as const, url: IPV6_TEST_URL, timeout: 2000, ipv6: false }
      const unique = [...new Map(targets.map((target) => [JSON.stringify([target.provider ?? null, target.name]), target])).values()]
      await Promise.all(unique.map(async (target) => {
        let supported = false
        try {
          const result = await testNode(target, settings)
          supported = Number.isFinite(result.delay) && result.delay > 0
        } catch {
          // Failure of the optional IPv6 probe must not prevent the normal test.
        }
        if (!disposed) onResult(target.name, supported)
      }))
    },
  }
}
