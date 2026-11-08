import type { Connection } from './api'

export const UNKNOWN_DEVICE = 'unknown'

/** One active /connections snapshot; these counters are not session history. */
export type DeviceConnection = Connection & { dl?: number; ul?: number }

export type DeviceTraffic = {
  connections: number
  download: number
  upload: number
  total: number
  dl: number
  ul: number
  tcp: number
  udp: number
}

export type DeviceStat = DeviceTraffic & {
  id: string
  /** Empty when mihomo did not provide a usable source address. */
  sourceIP: string
  domains: string[]
  destinationIPs: string[]
  /** Actual outbound names from chains[0], never inferred from a rule. */
  proxies: string[]
  rules: string[]
  processes: string[]
  inbounds: string[]
  /** Earliest valid start timestamp among this device's current connections, in milliseconds. */
  firstSeen: number | null
}

export type DeviceTotals = DeviceTraffic & { devices: number }
export type DevicesSnapshot = { devices: DeviceStat[]; totals: DeviceTotals }

type DeviceBucket = DeviceTraffic & {
  id: string
  sourceIP: string
  domains: Set<string>
  destinationIPs: Set<string>
  proxies: Set<string>
  rules: Set<string>
  processes: Set<string>
  inbounds: Set<string>
  firstSeen: number | null
}

const text = (value: unknown): string => typeof value === 'string' && value.length <= 2048 ? value.trim() : ''
const counter = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
const emptyTraffic = (): DeviceTraffic => ({ connections: 0, download: 0, upload: 0, total: 0, dl: 0, ul: 0, tcp: 0, udp: 0 })
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const sorted = (values: Set<string>): string[] => [...values].sort(compare)

/** Canonical address only. Names, ports, malformed and unspecified addresses do not identify a device. */
export function normalizeDeviceIP(value: unknown): string {
  let candidate = text(value)
  if (!candidate || candidate.length > 256) return ''
  if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const parts = candidate.split('.').map(Number)
    if (parts.some((part) => part < 0 || part > 255)) return ''
    const address = parts.join('.')
    return address === '0.0.0.0' ? '' : address
  }
  if (!candidate.includes(':')) return ''
  const [address, zone, ...extra] = candidate.split('%')
  if (extra.length || (zone !== undefined && !/^[A-Za-z0-9_.~-]+$/.test(zone))) return ''
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    if (normalized === '::') return ''
    return normalized + (zone ? `%${zone}` : '')
  } catch {
    return ''
  }
}

function domain(value: unknown): string {
  const candidate = text(value).toLowerCase().replace(/\.+$/, '')
  if (!candidate || candidate.length > 253 || normalizeDeviceIP(candidate) || /[\s/\\:@\[\]?#%]/.test(candidate)) return ''
  // Also exclude malformed/unspecified IP literals from the domains list.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) return ''
  try {
    const normalized = new URL(`http://${candidate}/`).hostname
    return normalized.length <= 253 && !normalizeDeviceIP(normalized) ? normalized : ''
  } catch {
    return ''
  }
}

function add(target: DeviceTraffic, values: DeviceTraffic): void {
  target.connections += values.connections
  target.download += values.download
  target.upload += values.upload
  target.total += values.total
  target.dl += values.dl
  target.ul += values.ul
  target.tcp += values.tcp
  target.udp += values.udp
}

function addText(target: Set<string>, value: string): void { if (value) target.add(value) }

/**
 * Group current connections by the address reported by mihomo. Repeating a frame
 * does not accumulate traffic, and a duplicate ID inside one frame counts once.
 * A source address is not proof of a physical device or its operating system.
 */
export function summarizeDevices(connections: readonly DeviceConnection[]): DevicesSnapshot {
  const buckets = new Map<string, DeviceBucket>()
  const totals: DeviceTotals = { ...emptyTraffic(), devices: 0 }
  const seen = new Set<string>()

  for (const connection of connections) {
    if (typeof connection.id !== 'string' || !connection.id.trim() || seen.has(connection.id)) continue
    seen.add(connection.id)
    const metadata = connection.metadata
    const sourceIP = normalizeDeviceIP(metadata?.sourceIP)
    const id = sourceIP || UNKNOWN_DEVICE
    let device = buckets.get(id)
    if (!device) {
      device = {
        ...emptyTraffic(), id, sourceIP, domains: new Set(), destinationIPs: new Set(),
        proxies: new Set(), rules: new Set(), processes: new Set(), inbounds: new Set(), firstSeen: null,
      }
      buckets.set(id, device)
    }
    const download = counter(connection.download)
    const upload = counter(connection.upload)
    const network = text(metadata?.network).toLowerCase()
    const values: DeviceTraffic = {
      connections: 1, download, upload, total: download + upload,
      dl: counter(connection.dl), ul: counter(connection.ul),
      tcp: Number(network === 'tcp'), udp: Number(network === 'udp'),
    }
    add(device, values)
    add(totals, values)
    addText(device.domains, domain(metadata?.host) || domain(metadata?.sniffHost))
    addText(device.destinationIPs, normalizeDeviceIP(metadata?.destinationIP))
    addText(device.proxies, Array.isArray(connection.chains) ? text(connection.chains[0]) : '')
    const rule = text(connection.rule)
    const payload = text(connection.rulePayload)
    addText(device.rules, rule ? payload ? `${rule}: ${payload}` : rule : payload)
    addText(device.processes, text(metadata?.process) || text(metadata?.processPath))
    addText(device.inbounds, text(metadata?.inboundName) || text(metadata?.type))
    const start = typeof connection.start === 'string' && connection.start.trim() ? Date.parse(connection.start) : Number.NaN
    if (Number.isFinite(start)) device.firstSeen = device.firstSeen === null ? start : Math.min(device.firstSeen, start)
  }

  const devices = [...buckets.values()].map((device): DeviceStat => ({
    ...device,
    domains: sorted(device.domains), destinationIPs: sorted(device.destinationIPs),
    proxies: sorted(device.proxies), rules: sorted(device.rules), processes: sorted(device.processes), inbounds: sorted(device.inbounds),
  })).sort((a, b) => b.total - a.total || b.connections - a.connections || compare(a.id, b.id))
  totals.devices = devices.length
  return { devices, totals }
}
