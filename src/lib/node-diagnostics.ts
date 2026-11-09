import type { Proxy } from './api'

export const NODE_HISTORY_LIMIT = 200
export type NodeHistorySample = { time: number; delay: number; failed: boolean }
export type NodeHistory = { id: string; url: string | null; samples: NodeHistorySample[]; truncated: boolean }
export type NodeCapability = { key: string; value: string | number | boolean }

/** Separate sources are intentional: generic history has no reliable URL identity. */
export function nodeHistories(node: Proxy | null | undefined): NodeHistory[] {
  if (!node) return []
  const make = (id: string, url: string | null, value: unknown): NodeHistory => {
    const samples: NodeHistorySample[] = []
    if (Array.isArray(value)) {
      for (const row of value.slice(-5000)) {
        if (!row || typeof row !== 'object' || typeof row.time !== 'string' || typeof row.delay !== 'number') continue
        const time = Date.parse(row.time)
        if (!Number.isFinite(time) || !Number.isFinite(row.delay) || row.delay < 0) continue
        samples.push({ time, delay: row.delay, failed: row.delay === 0 })
      }
    }
    samples.sort((a, b) => a.time - b.time)
    return { id, url, samples: samples.slice(-NODE_HISTORY_LIMIT), truncated: samples.length > NODE_HISTORY_LIMIT || (Array.isArray(value) && value.length > 5000) }
  }
  const result = [make('generic', null, node.history)]
  if (node.extra && typeof node.extra === 'object' && !Array.isArray(node.extra)) {
    for (const [url, source] of Object.entries(node.extra).slice(0, 100)) {
      if (url && source && typeof source === 'object') result.push(make(`url:${url}`, url, source.history))
    }
  }
  return result
}

export function nodeCapabilities(node: Proxy | null | undefined): NodeCapability[] {
  if (!node) return []
  const values = node as Proxy & Record<string, unknown>
  const result: NodeCapability[] = []
  for (const key of ['udp', 'uot', 'xudp', 'tfo', 'mptcp', 'smux']) {
    if (typeof values[key] === 'boolean') result.push({ key, value: values[key] as boolean })
  }
  for (const key of ['interface', 'dialer-proxy']) {
    if (typeof values[key] === 'string' && (values[key] as string).trim()) result.push({ key, value: values[key] as string })
  }
  if (typeof values['routing-mark'] === 'number' && Number.isSafeInteger(values['routing-mark'])) result.push({ key: 'routing-mark', value: values['routing-mark'] })
  return result
}

export function historySummary(samples: readonly NodeHistorySample[]) {
  const successful = samples.filter(sample => !sample.failed).map(sample => sample.delay).sort((a, b) => a - b)
  const middle = Math.floor(successful.length / 2)
  return {
    total: samples.length, failed: samples.length - successful.length,
    median: successful.length ? (successful.length % 2 ? successful[middle] : (successful[middle - 1] + successful[middle]) / 2) : null,
    min: successful[0] ?? null, max: successful.at(-1) ?? null,
  }
}

/** Failures split the line, so a missing response never becomes a zero-latency success. */
export function historyPlot(samples: readonly NodeHistorySample[]) {
  const width = 640, height = 150, inset = 12
  const maximum = Math.max(1, ...samples.map(sample => sample.delay))
  const first = samples[0]?.time ?? 0, span = (samples.at(-1)?.time ?? first) - first
  const points = samples.map((sample, index) => ({
    ...sample,
    x: inset + (width - inset * 2) * (span > 0 ? (sample.time - first) / span : samples.length > 1 ? index / (samples.length - 1) : .5),
    y: height - inset - (height - inset * 2) * sample.delay / maximum,
  }))
  const paths: string[] = []
  let segment: string[] = []
  for (const point of points) {
    if (point.failed) { if (segment.length) paths.push(segment.join(' ')); segment = []; continue }
    segment.push(`${segment.length ? 'L' : 'M'}${point.x},${point.y}`)
  }
  if (segment.length) paths.push(segment.join(' '))
  return { width, height, points, paths }
}
