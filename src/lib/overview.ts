import type { AnalysisSnapshot, IPStat } from './analysis'
import { countryCode } from './geography.ts'

export type OverviewRegion = {
  name: string
  download: number
  upload: number
  connections: number
}

function nonnegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function region(row: IPStat, lookup?: (ip: string) => string | null): string | null {
  const countries = new Set(row.countries.map(countryCode).filter((code): code is string => code !== null))
  // Merged IP metadata can contain conflicting destinations. Do not guess which one is correct.
  if (countries.size > 1) return null
  if (countries.size === 1) return countries.values().next().value ?? null
  return lookup ? countryCode(lookup(row.name)) : null
}

/** Session regions, including closed connections and the unlocated/no-IP remainder. No DNS. */
export function overviewRegions(
  snapshot: Pick<AnalysisSnapshot, 'ips' | 'totals'>,
  lookup?: (ip: string) => string | null,
): OverviewRegion[] {
  const countries = new Map<string, OverviewRegion>()
  const remaining = {
    download: nonnegative(snapshot.totals.download),
    upload: nonnegative(snapshot.totals.upload),
    connections: nonnegative(snapshot.totals.connections),
  }

  for (const ip of snapshot.ips) {
    const name = region(ip, lookup)
    if (!name) continue
    // Session totals stay authoritative even if a malformed snapshot overstates an IP bucket.
    const download = Math.min(remaining.download, nonnegative(ip.download))
    const upload = Math.min(remaining.upload, nonnegative(ip.upload))
    const connections = Math.min(remaining.connections, nonnegative(ip.connections))
    if (!download && !upload && !connections) continue
    const row = countries.get(name) ?? { name, download: 0, upload: 0, connections: 0 }
    row.download += download
    row.upload += upload
    row.connections += connections
    countries.set(name, row)
    remaining.download -= download
    remaining.upload -= upload
    remaining.connections -= connections
  }

  if (remaining.download || remaining.upload || remaining.connections) {
    countries.set('unknown', { name: 'unknown', ...remaining })
  }

  return [...countries.values()].sort((a, b) =>
    b.download + b.upload - a.download - a.upload || a.name.localeCompare(b.name),
  )
}
