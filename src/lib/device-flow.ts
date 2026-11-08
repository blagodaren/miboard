import { normalizeDeviceIP, UNKNOWN_DEVICE, type DeviceConnection } from './devices.ts'

export type DeviceFlowMetric = 'traffic' | 'connections'
export type DeviceFlowKind = 'device' | 'proxy' | 'domain'
export type DeviceFlowTotals = { download: number; upload: number; total: number; connections: number }
export type DeviceFlowNode = DeviceFlowTotals & {
  id: string
  kind: DeviceFlowKind
  name: string
  deviceId?: string
  other: boolean
  unknown: boolean
  x: number
  y: number
  width: number
  height: number
}
export type DeviceFlowLink = DeviceFlowTotals & {
  id: string
  source: string
  target: string
  path: string
  strokeWidth: number
}
export type DeviceFlowGraph = {
  nodes: DeviceFlowNode[]
  links: DeviceFlowLink[]
  width: number
  height: number
  totals: DeviceFlowTotals
}

type Route = { device: string; proxy: string; domain: string; totals: DeviceFlowTotals }
const KINDS: DeviceFlowKind[] = ['device', 'proxy', 'domain']
const LIMITS = { device: 8, proxy: 8, domain: 10 }
export const DEVICE_FLOW_COLUMN_WIDTH = 360
export const DEVICE_FLOW_NODE_WIDTH = 240
const NODE_HEIGHT = 70
const ROW_GAP = 12
const HEADER_HEIGHT = 34
const emptyTotals = (): DeviceFlowTotals => ({ download: 0, upload: 0, total: 0, connections: 0 })
const positive = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(value, Number.MAX_SAFE_INTEGER)) : 0
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 512) : ''
const nodeId = (kind: DeviceFlowKind, name: string, other = false) => JSON.stringify([kind, other ? 'other' : name ? 'value' : 'unknown', ...(name && !other ? [name] : [])])

function add(target: DeviceFlowTotals, source: DeviceFlowTotals) {
  target.download += source.download
  target.upload += source.upload
  target.total += source.total
  target.connections += source.connections
}

/** Build a bounded, shared three-column graph from one active connection snapshot. */
export function buildDeviceFlow(
  connections: readonly DeviceConnection[],
  metric: DeviceFlowMetric = 'traffic',
  selectedDevice: string | null = null,
): DeviceFlowGraph {
  const routes: Route[] = []
  const seen = new Set<string>()
  const totals = emptyTotals()
  const rows: Record<DeviceFlowKind, Map<string, DeviceFlowTotals>> = { device: new Map(), proxy: new Map(), domain: new Map() }
  const weight = (row: DeviceFlowTotals) => metric === 'traffic' ? row.total : row.connections

  for (const connection of connections) {
    if (!connection || !connection.metadata || typeof connection.id !== 'string' || !connection.id || seen.has(connection.id)) continue
    seen.add(connection.id)
    const device = normalizeDeviceIP(connection.metadata.sourceIP) || UNKNOWN_DEVICE
    if (selectedDevice !== null && device !== selectedDevice) continue
    const proxy = text(connection.chains?.[0])
    const host = text(connection.metadata.host) || text(connection.metadata.sniffHost) || text(connection.metadata.destinationIP)
    const domain = normalizeDeviceIP(host) || host.toLowerCase().replace(/\.+$/, '')
    const download = positive(connection.download)
    const upload = positive(connection.upload)
    const current = { download, upload, total: download + upload, connections: 1 }
    const route = { device, proxy, domain, totals: current }
    routes.push(route)
    add(totals, current)
    for (const kind of KINDS) {
      const name = route[kind]
      const row = rows[kind].get(name) ?? emptyTotals()
      add(row, current)
      rows[kind].set(name, row)
    }
  }

  if (!routes.length) return { nodes: [], links: [], width: 0, height: 0, totals }

  const retained = Object.fromEntries(KINDS.map((kind) => [kind, new Set([...rows[kind]].sort((a, b) =>
    weight(b[1]) - weight(a[1]) || b[1].connections - a[1].connections || compareText(a[0], b[0]),
  ).slice(0, LIMITS[kind]).map(([name]) => name))])) as Record<DeviceFlowKind, Set<string>>
  const nodes = new Map<string, DeviceFlowNode>()
  const links = new Map<string, DeviceFlowLink>()

  function getNode(kind: DeviceFlowKind, rawName: string) {
    const other = !retained[kind].has(rawName)
    const unknown = !other && (kind === 'device' ? rawName === UNKNOWN_DEVICE : !rawName)
    const name = other || unknown ? '' : rawName
    const id = nodeId(kind, name, other)
    let node = nodes.get(id)
    if (!node) {
      node = { id, kind, name, other, unknown, ...emptyTotals(), x: 0, y: 0, width: DEVICE_FLOW_NODE_WIDTH, height: NODE_HEIGHT }
      if (kind === 'device' && !other) node.deviceId = rawName
      nodes.set(id, node)
    }
    return node
  }

  for (const route of routes) {
    const path = KINDS.map((kind) => getNode(kind, route[kind]))
    for (const node of path) add(node, route.totals)
    for (let index = 1; index < path.length; index++) {
      const source = path[index - 1].id
      const target = path[index].id
      const id = JSON.stringify([source, target])
      let link = links.get(id)
      if (!link) {
        link = { id, source, target, path: '', strokeWidth: 1, ...emptyTotals() }
        links.set(id, link)
      }
      add(link, route.totals)
    }
  }

  const columns = KINDS.map((kind) => [...nodes.values()].filter((node) => node.kind === kind).sort((a, b) =>
    Number(a.other) - Number(b.other) || weight(b) - weight(a) || b.connections - a.connections || compareText(a.id, b.id),
  ))
  const maxRows = Math.max(...columns.map((column) => column.length))
  const contentHeight = maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP
  const height = HEADER_HEIGHT + contentHeight
  const width = DEVICE_FLOW_COLUMN_WIDTH * 2 + DEVICE_FLOW_NODE_WIDTH

  columns.forEach((column, index) => {
    const columnHeight = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP
    column.forEach((node, row) => {
      node.x = index * DEVICE_FLOW_COLUMN_WIDTH
      node.y = HEADER_HEIGHT + (contentHeight - columnHeight) / 2 + row * (NODE_HEIGHT + ROW_GAP)
    })
  })

  const resultLinks = [...links.values()].sort((a, b) => compareText(a.id, b.id))
  const maximum = Math.max(1, ...resultLinks.map(weight))
  const ports = new Map<string, number>()
  for (const node of nodes.values()) {
    for (const side of ['out', 'in'] as const) {
      const touching = resultLinks.filter((link) => (side === 'out' ? link.source : link.target) === node.id).sort((a, b) => {
        const otherA = nodes.get(side === 'out' ? a.target : a.source)!
        const otherB = nodes.get(side === 'out' ? b.target : b.source)!
        return otherA.y - otherB.y || compareText(a.id, b.id)
      })
      touching.forEach((link, index) => ports.set(`${side}:${link.id}`, node.y + 12 + (NODE_HEIGHT - 24) * (index + 1) / (touching.length + 1)))
    }
  }
  for (const link of resultLinks) {
    const source = nodes.get(link.source)!
    const target = nodes.get(link.target)!
    const startX = source.x + source.width
    const endX = target.x
    const startY = ports.get(`out:${link.id}`)!
    const endY = ports.get(`in:${link.id}`)!
    const middle = (startX + endX) / 2
    link.path = `M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`
    link.strokeWidth = 1.5 + Math.sqrt(weight(link) / maximum) * 10.5
  }

  return { nodes: columns.flat(), links: resultLinks, width, height, totals }
}
