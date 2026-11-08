import type { Connection, DnsResponse } from './api'
import { publicIp } from './geo-db.ts'
import { destinationCountry } from './geography.ts'

export type ResolvedLocation = { country: string; source: 'ip' | 'dns'; ip: string }

type CacheEntry = { result: ResolvedLocation | null; expires: number; failed: boolean }
type Candidate = { ip: string | null; host: string | null }
const MAX_CONCURRENT = 4
const MAX_CACHE = 2048
const MIN_TTL = 30_000
const MAX_TTL = 300_000
const NEGATIVE_TTL = 60_000

function domain(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const input = value.trim().toLowerCase().replace(/\.+$/, '')
  if (!input || input.length > 253 || /[\s/\\:@\[\]?#%]/.test(input) || publicIp(input)) return null
  let normalized: string
  try {
    normalized = new URL(`http://${input}/`).hostname
  } catch {
    return null
  }
  if (/^\d+(?:\.\d+){3}$/.test(normalized)) return null
  const labels = normalized.split('.')
  if (labels.length < 2 || normalized.length > 253) return null
  if (labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
  if (/\.(?:local|lan|localhost|localdomain|internal|home|test|invalid|example|onion|arpa)$/.test(normalized)) return null
  return normalized
}

/** Real LAN targets must stay local; only missing, unspecified, or standard fake IPs use DNS. */
function needsDNS(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'string') return false
  const ip = value.trim()
  if (!ip || ip === '0.0.0.0') return true
  if (/^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    return ip.split('.').every((part) => Number(part) <= 255)
  }
  if (ip.includes(':')) {
    try {
      return new URL(`http://[${ip.replace(/^\[|\]$/g, '')}]/`).hostname === '[::]'
    } catch {
      return false
    }
  }
  return false
}

function candidate(connection: Connection): Candidate {
  const metadata = connection.metadata
  const ip = publicIp(metadata.destinationIP) || publicIp(metadata.host) || publicIp(metadata.sniffHost)
  if (ip) return { ip, host: null }
  if (!needsDNS(metadata.destinationIP)) return { ip: null, host: null }
  return { ip: null, host: domain(metadata.host) || domain(metadata.sniffHost) }
}

/** Resolve countries locally; only unresolved domain names go to the user's own controller. */
export class GeoResolver {
  #lookup: (ip: string) => string | null
  #query: (name: string, type: 'A' | 'AAAA') => Promise<DnsResponse>
  #onchange: () => void
  #cache = new Map<string, CacheEntry>()
  #wanted = new Set<string>()
  #queue = new Set<string>()
  #running = new Set<string>()
  #disposed = false

  constructor(
    lookup: (ip: string) => string | null,
    query: (name: string, type: 'A' | 'AAAA') => Promise<DnsResponse>,
    onchange: () => void,
  ) {
    this.#lookup = lookup
    this.#query = query
    this.#onchange = onchange
  }

  get pending(): number {
    return this.#disposed ? 0 : this.#queue.size + this.#running.size
  }

  get dnsFailures(): number {
    if (this.#disposed) return 0
    const now = Date.now()
    let failures = 0
    for (const host of this.#wanted) {
      const cached = this.#cache.get(host)
      if (cached?.failed && cached.expires > now) failures++
    }
    return failures
  }

  update(connections: readonly Connection[]): void {
    if (this.#disposed) return
    const now = Date.now()
    const wanted = new Set<string>()
    for (const connection of connections) {
      // Native GeoIP has priority; it needs neither another lookup nor a DNS query.
      if (destinationCountry(connection)) continue
      const { host } = candidate(connection)
      if (host) wanted.add(host)
      if (wanted.size >= MAX_CACHE) break
    }
    this.#wanted = wanted
    for (const host of this.#queue) if (!wanted.has(host)) this.#queue.delete(host)
    for (const [host, entry] of this.#cache) if (entry.expires <= now) this.#cache.delete(host)
    for (const host of wanted) {
      if (!this.#cache.has(host) && !this.#running.has(host)) this.#queue.add(host)
    }
    this.#pump()
  }

  locate(connection: Connection): ResolvedLocation | null {
    if (this.#disposed || destinationCountry(connection)) return null
    const { ip, host } = candidate(connection)
    if (ip) {
      const country = this.#lookup(ip)
      return country ? { country, source: 'ip', ip } : null
    }
    if (!host) return null
    const cached = this.#cache.get(host)
    return cached && cached.expires > Date.now() ? cached.result : null
  }

  dispose(): void {
    this.#disposed = true
    this.#wanted.clear()
    this.#queue.clear()
    this.#cache.clear()
    // In-flight injected queries cannot be aborted, but their results and callbacks are ignored.
  }

  #pump(): void {
    while (!this.#disposed && this.#running.size < MAX_CONCURRENT && this.#queue.size) {
      const host = this.#queue.values().next().value!
      this.#queue.delete(host)
      if (!this.#wanted.has(host)) continue
      this.#running.add(host)
      void this.#resolve(host)
    }
  }

  async #resolve(host: string): Promise<void> {
    let result: ResolvedLocation | null = null
    let failed = false
    let ttl = NEGATIVE_TTL
    try {
      for (const type of ['A', 'AAAA'] as const) {
        if (this.#disposed || !this.#wanted.has(host)) break
        let response: DnsResponse
        try {
          response = await this.#query(host, type)
        } catch {
          failed = true
          // An unavailable controller endpoint cannot be repaired by another record type.
          break
        }
        if (this.#disposed) return
        if (!response || response.Status !== 0) {
          failed = true
          // NXDOMAIN concerns the name, not its A/AAAA family.
          break
        }
        const answers = Array.isArray(response.Answer) ? response.Answer : []
        for (const answer of answers) {
          if (answer.type !== (type === 'A' ? 1 : 28)) continue
          const ip = publicIp(answer.data)
          if (!ip) continue
          const country = this.#lookup(ip)
          if (!country) continue
          result = { country, source: 'dns', ip }
          ttl = Math.min(MAX_TTL, Math.max(MIN_TTL,
            typeof answer.TTL === 'number' && Number.isFinite(answer.TTL) ? answer.TTL * 1000 : MIN_TTL,
          ))
          break
        }
        if (result) break
      }
      if (this.#disposed) return
      this.#cache.delete(host)
      while (this.#cache.size >= MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!)
      this.#cache.set(host, { result, expires: Date.now() + ttl, failed })
    } catch {
      // Invalid injected lookup data must not leave a permanently occupied queue slot.
      if (!this.#disposed) {
        while (this.#cache.size >= MAX_CACHE) this.#cache.delete(this.#cache.keys().next().value!)
        this.#cache.set(host, { result: null, expires: Date.now() + NEGATIVE_TTL, failed: true })
      }
    } finally {
      this.#running.delete(host)
      if (!this.#disposed) {
        this.#pump()
        this.#onchange()
      }
    }
  }
}
