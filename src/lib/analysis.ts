import type { Connection } from './api'

/** Never evict IDs: an evicted connection could reappear and be counted twice. */
export const ANALYSIS_CONNECTION_LIMIT = 20_000
export const UNKNOWN_PROXY = '\u0000unknown-proxy'
const METADATA_VALUE_LIMIT = 64
const METADATA_TEXT_LIMIT = 512

export type AnalysisStat = {
  name: string
  download: number
  upload: number
  connections: number
  active: number
  lastSeen: number
}

export type DomainStat = AnalysisStat & { ips: string[]; proxies: string[] }
export type IPStat = AnalysisStat & { domains: string[]; proxies: string[]; countries: string[]; asn: string[] }
export type ProxyStat = AnalysisStat & { domains: string[]; ips: string[] }

export type AnalysisSnapshot = {
  startedAt: number
  updatedAt: number
  domains: DomainStat[]
  ips: IPStat[]
  proxies: ProxyStat[]
  totals: { download: number; upload: number; connections: number; active: number }
  truncated: boolean
}

type TrackedConnection = {
  domain: string
  sniffedDomain: boolean
  ip: string
  ipPriority: number
  proxy: string
  baseline: boolean
  countries: Set<string>
  asn: Set<string>
  download: number
  upload: number
  previousDownload?: number
  previousUpload?: number
  active: boolean
  lastSeen: number
}

type Bucket = AnalysisStat & {
  domains: Set<string>
  ips: Set<string>
  proxies: Set<string>
  countries: Set<string>
  asn: Set<string>
}

function ipAddress(value: unknown): string {
  if (typeof value !== 'string') return ''
  let candidate = value.trim().replace(/\.$/, '')
  if (candidate.length > 256) return ''
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const parts = candidate.split('.').map(Number)
    return parts.every((part) => part >= 0 && part <= 255) ? parts.join('.') : ''
  }
  if (candidate.includes(':')) {
    try {
      const [address, zone, ...extra] = candidate.split('%')
      if (extra.length || (zone !== undefined && !/^[A-Za-z0-9_.~-]+$/.test(zone))) return ''
      const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
      return normalized + (zone ? `%${zone}` : '')
    } catch {
      return ''
    }
  }
  return ''
}

function domainName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim().toLowerCase().replace(/\.+$/, '')
  if (!candidate || candidate.length > 253 || ipAddress(candidate) || /[\s/\\:@\[\]?#%]/.test(candidate)) return ''
  try {
    // URL handles international domain names consistently with browser DNS.
    const normalized = new URL(`http://${candidate}/`).hostname
    return normalized.length > 253 || ipAddress(normalized) ? '' : normalized
  } catch {
    return ''
  }
}

function textValues(value: unknown): { values: Set<string>; truncated: boolean } {
  const values = Array.isArray(value) ? value : [value]
  const result = new Set<string>()
  let truncated = false
  for (const item of values) {
    if (typeof item !== 'string') continue
    if (item.length > METADATA_TEXT_LIMIT) {
      truncated = true
      continue
    }
    const text = item.trim()
    if (!text || result.has(text)) continue
    if (result.size >= METADATA_VALUE_LIMIT) {
      truncated = true
      break
    }
    result.add(text)
  }
  return { values: result, truncated }
}

function counter(value: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function increment(value: number | undefined, previous: number | undefined): number {
  if (value === undefined) return 0
  if (previous === undefined || value < previous) return value
  return value - previous
}

function addValues(target: Set<string>, values: Iterable<string>) {
  for (const value of values) if (value) target.add(value)
}

function bucket(map: Map<string, Bucket>, name: string): Bucket {
  let row = map.get(name)
  if (!row) {
    row = {
      name, download: 0, upload: 0, connections: 0, active: 0, lastSeen: 0,
      domains: new Set(), ips: new Set(), proxies: new Set(), countries: new Set(), asn: new Set(),
    }
    map.set(name, row)
  }
  return row
}

function accumulate(row: Bucket, connection: TrackedConnection) {
  row.download += connection.download
  row.upload += connection.upload
  row.connections++
  row.active += Number(connection.active)
  row.lastSeen = Math.max(row.lastSeen, connection.lastSeen)
  if (connection.domain) row.domains.add(connection.domain)
  if (connection.ip) row.ips.add(connection.ip)
  row.proxies.add(connection.proxy)
  addValues(row.countries, connection.countries)
  addValues(row.asn, connection.asn)
}

function common(row: Bucket): AnalysisStat {
  return {
    name: row.name, download: row.download, upload: row.upload,
    connections: row.connections, active: row.active, lastSeen: row.lastSeen,
  }
}

const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b))
const byTraffic = (a: AnalysisStat, b: AnalysisStat) =>
  b.download + b.upload - a.download - a.upload || a.name.localeCompare(b.name)

/** In-memory session statistics, fed by the existing /connections stream. */
export class AnalysisTracker {
  #connections = new Map<string, TrackedConnection>()
  #startedAt = Date.now()
  #updatedAt = this.#startedAt
  #firstFrame = true
  #truncated = false
  #cached: AnalysisSnapshot | null = null

  reset(now = Date.now()): void {
    this.#connections.clear()
    this.#startedAt = now
    this.#updatedAt = now
    this.#firstFrame = true
    this.#truncated = false
    this.#cached = null
  }

  ingest(connections: readonly Connection[], now = Date.now()): void {
    const baseline = this.#firstFrame
    this.#firstFrame = false
    this.#updatedAt = now
    this.#cached = null
    for (const tracked of this.#connections.values()) tracked.active = false
    const seen = new Set<string>()

    for (const connection of connections) {
      if (typeof connection.id !== 'string' || !connection.id || seen.has(connection.id)) continue
      if (connection.id.length > METADATA_TEXT_LIMIT) {
        this.#truncated = true
        continue
      }
      let tracked = this.#connections.get(connection.id)
      if (!tracked) {
        if (this.#connections.size >= ANALYSIS_CONNECTION_LIMIT) {
          this.#truncated = true
          continue
        }
        tracked = {
          domain: '', sniffedDomain: false, ip: '', ipPriority: 0, proxy: UNKNOWN_PROXY, baseline,
          countries: new Set(), asn: new Set(),
          download: 0, upload: 0, active: true, lastSeen: now,
        }
        this.#connections.set(connection.id, tracked)
      }
      // Keep temporary deduplication bounded too, even for an oversized frame.
      seen.add(connection.id)

      const download = counter(connection.download)
      const upload = counter(connection.upload)
      // The first frame is a baseline: bytes predating this session are excluded.
      if (!baseline) {
        if (!tracked.baseline || tracked.previousDownload !== undefined)
          tracked.download += increment(download, tracked.previousDownload)
        if (!tracked.baseline || tracked.previousUpload !== undefined)
          tracked.upload += increment(upload, tracked.previousUpload)
      }
      if (download !== undefined) tracked.previousDownload = download
      if (upload !== undefined) tracked.previousUpload = upload
      tracked.active = true
      tracked.lastSeen = now

      const metadata = connection.metadata && typeof connection.metadata === 'object'
        ? connection.metadata as unknown as Record<string, unknown> : {}
      // mihomo's RuleHost prefers the sniffed name over the original host.
      const sniffedDomain = domainName(metadata.sniffHost)
      const hostDomain = domainName(metadata.host)
      if (sniffedDomain) {
        tracked.domain = sniffedDomain
        tracked.sniffedDomain = true
      } else if (hostDomain && !tracked.sniffedDomain) {
        tracked.domain = hostDomain
      }
      const candidates = [
        ipAddress(metadata.destinationIP), ipAddress(metadata.remoteDestination),
        ipAddress(metadata.host) || ipAddress(metadata.sniffHost),
      ]
      const index = candidates.findIndex(Boolean)
      const ip = candidates[index]
      const ipPriority = candidates.length - index
      if (ip && ipPriority >= tracked.ipPriority) {
        if (ip !== tracked.ip) {
          // Lookup results describe an address, so they cannot follow a changed IP.
          tracked.countries.clear()
          tracked.asn.clear()
        }
        tracked.ip = ip
        tracked.ipPriority = ipPriority
      }
      const rawProxy = Array.isArray(connection.chains) ? connection.chains[0] : undefined
      if (typeof rawProxy === 'string') {
        if (rawProxy.length > METADATA_TEXT_LIMIT) this.#truncated = true
        else if (rawProxy.trim()) tracked.proxy = rawProxy.trim()
      }
      // null/undefined means not looked up; an explicit [] clears an earlier result.
      if (metadata.destinationGeoIP !== undefined && metadata.destinationGeoIP !== null) {
        const result = textValues(metadata.destinationGeoIP)
        tracked.countries = result.values
        this.#truncated ||= result.truncated
      }
      if (metadata.destinationIPASN !== undefined && metadata.destinationIPASN !== null) {
        const result = textValues(metadata.destinationIPASN)
        tracked.asn = result.values
        this.#truncated ||= result.truncated
      }
    }
  }

  snapshot(): AnalysisSnapshot {
    if (this.#cached) return this.#cached
    const domains = new Map<string, Bucket>()
    const ips = new Map<string, Bucket>()
    const proxies = new Map<string, Bucket>()
    const totals = { download: 0, upload: 0, connections: this.#connections.size, active: 0 }

    for (const tracked of this.#connections.values()) {
      totals.download += tracked.download
      totals.upload += tracked.upload
      totals.active += Number(tracked.active)
      if (tracked.domain) accumulate(bucket(domains, tracked.domain), tracked)
      if (tracked.ip) accumulate(bucket(ips, tracked.ip), tracked)
      accumulate(bucket(proxies, tracked.proxy), tracked)
    }

    this.#cached = {
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      totals,
      truncated: this.#truncated,
      domains: [...domains.values()].map((row) => ({
        ...common(row), ips: sorted(row.ips), proxies: sorted(row.proxies),
      })).sort(byTraffic),
      ips: [...ips.values()].map((row) => ({
        ...common(row), domains: sorted(row.domains), proxies: sorted(row.proxies),
        countries: sorted(row.countries), asn: sorted(row.asn),
      })).sort(byTraffic),
      proxies: [...proxies.values()].map((row) => ({
        ...common(row), domains: sorted(row.domains), ips: sorted(row.ips),
      })).sort(byTraffic),
    }
    return this.#cached
  }
}
