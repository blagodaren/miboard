import type { RuleChainStat, RuleTrafficTotals } from './rules-analytics'

export type RuleChainGraphNode = RuleTrafficTotals & {
  id: string
  kind: 'rule' | 'group' | 'outbound'
  ruleId?: string
  name: string
  chainIds: string[]
  x: number
  y: number
  width: number
  height: number
}

export type RuleChainGraphEdge = RuleTrafficTotals & {
  id: string
  source: string
  target: string
  chainIds: string[]
}

export type RuleChainGraph = {
  nodes: RuleChainGraphNode[]
  edges: RuleChainGraphEdge[]
  width: number
  height: number
}

export type RuleChainHighlight = {
  nodeIds: Set<string>
  edgeIds: Set<string>
}

/** Highlight only complete observed routes that actually pass through this node. */
export function getRuleChainHighlight(graph: RuleChainGraph, nodeId: string | null): RuleChainHighlight | null {
  if (nodeId === null) return null
  const anchor = graph.nodes.find((node) => node.id === nodeId)
  if (!anchor) return null
  const chainIds = new Set(anchor.chainIds)
  return {
    nodeIds: new Set(graph.nodes.filter((node) => node.chainIds.some((id) => chainIds.has(id))).map((node) => node.id)),
    edgeIds: new Set(graph.edges.filter((edge) => edge.chainIds.some((id) => chainIds.has(id))).map((edge) => edge.id)),
  }
}

const NODE_WIDTH = 224
const NODE_HEIGHT = 108
const COLUMN_GAP = 80
const ROW_GAP = 28
const emptyTotals = (): RuleTrafficTotals => ({ download: 0, upload: 0, total: 0, connections: 0 })
const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

function addTotals(target: RuleTrafficTotals, source: RuleTrafficTotals) {
  target.download += source.download
  target.upload += source.upload
  target.total += source.total
  target.connections += source.connections
}

/**
 * Build one shared routing graph for an active-connection snapshot. Node identities
 * describe their role and exact name, so a group used by many rules appears once.
 */
export function buildRuleChainGraph(chains: readonly RuleChainStat[]): RuleChainGraph {
  const nodes = new Map<string, RuleChainGraphNode>()
  const edges = new Map<string, RuleChainGraphEdge>()

  function node(kind: RuleChainGraphNode['kind'], name: string, ruleId?: string) {
    const id = JSON.stringify([kind, kind === 'rule' ? ruleId : name])
    let result = nodes.get(id)
    if (!result) {
      result = { id, kind, name, chainIds: [], ...emptyTotals(), x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT }
      if (kind === 'rule') result.ruleId = ruleId
      nodes.set(id, result)
    }
    return result
  }

  for (const chain of [...chains].sort((a, b) => compareIds(a.id, b.id))) {
    const route = [node('rule', '', chain.ruleId)]
    if (chain.path.length) {
      chain.path.forEach((name, index) => {
        route.push(node(index === chain.path.length - 1 ? 'outbound' : 'group', name))
      })
    } else {
      // Missing API metadata stays unknown; configured rules cannot identify it.
      route.push(node('group', ''), node('outbound', ''))
    }

    const countedNodes = new Set<string>()
    const countedEdges = new Set<string>()
    for (let index = 0; index < route.length; index++) {
      const current = route[index]
      if (!countedNodes.has(current.id)) {
        addTotals(current, chain)
        current.chainIds.push(chain.id)
        countedNodes.add(current.id)
      }
      if (index === 0) continue
      const source = route[index - 1].id
      const target = current.id
      const id = JSON.stringify([source, target])
      if (countedEdges.has(id)) continue
      let edge = edges.get(id)
      if (!edge) {
        edge = { id, source, target, chainIds: [], ...emptyTotals() }
        edges.set(id, edge)
      }
      addTotals(edge, chain)
      edge.chainIds.push(chain.id)
      countedEdges.add(id)
    }
  }

  if (nodes.size === 0) return { nodes: [], edges: [], width: 0, height: 0 }
  const ids = [...nodes.keys()].sort(compareIds)
  const outgoing = new Map(ids.map((id) => [id, [] as string[]]))
  const incoming = new Map(ids.map((id) => [id, [] as string[]]))
  for (const edge of edges.values()) {
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }
  for (const neighbors of [...outgoing.values(), ...incoming.values()]) neighbors.sort(compareIds)

  // Iterative Kosaraju avoids recursive stack limits. A malformed cyclic route
  // remains a real cycle instead of creating duplicate groups or infinite layers.
  const visited = new Set<string>()
  const finished: string[] = []
  for (const id of ids) {
    if (visited.has(id)) continue
    const stack: [string, boolean][] = [[id, false]]
    while (stack.length) {
      const [current, expanded] = stack.pop()!
      if (expanded) {
        finished.push(current)
        continue
      }
      if (visited.has(current)) continue
      visited.add(current)
      stack.push([current, true])
      const neighbors = outgoing.get(current)!
      for (let index = neighbors.length - 1; index >= 0; index--) {
        if (!visited.has(neighbors[index])) stack.push([neighbors[index], false])
      }
    }
  }

  const componentFor = new Map<string, number>()
  const components: string[][] = []
  for (let index = finished.length - 1; index >= 0; index--) {
    const id = finished[index]
    if (componentFor.has(id)) continue
    const component = components.length
    const members: string[] = []
    const stack = [id]
    componentFor.set(id, component)
    while (stack.length) {
      const current = stack.pop()!
      members.push(current)
      for (const previous of incoming.get(current)!) {
        if (componentFor.has(previous)) continue
        componentFor.set(previous, component)
        stack.push(previous)
      }
    }
    components.push(members)
  }

  const nextComponents = components.map(() => new Set<number>())
  const indegrees = components.map(() => 0)
  const componentLayers = components.map(() => 0)
  for (const edge of edges.values()) {
    const source = componentFor.get(edge.source)!
    const target = componentFor.get(edge.target)!
    if (source === target || nextComponents[source].has(target)) continue
    nextComponents[source].add(target)
    indegrees[target]++
  }
  const queue = components.map((_, index) => index).filter((index) => indegrees[index] === 0)
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index]
    for (const target of nextComponents[source]) {
      componentLayers[target] = Math.max(componentLayers[target], componentLayers[source] + 1)
      if (--indegrees[target] === 0) queue.push(target)
    }
  }

  const lastLayer = componentLayers.reduce((maximum, layer) => Math.max(maximum, layer), 0)
  const layers: RuleChainGraphNode[][] = Array.from({ length: lastLayer + 1 }, () => [])
  for (const item of nodes.values()) {
    // Keep direct and proxied exits in the same final column for easy comparison.
    const layer = item.kind === 'outbound' ? lastLayer : componentLayers[componentFor.get(item.id)!]
    layers[layer].push(item)
  }
  for (const layer of layers) layer.sort((a, b) => compareIds(a.id, b.id))

  // Repeated forward/backward barycentric sweeps reduce crossings without adding
  // a browser-only graph dependency. The ID tie-breaker makes each snapshot stable.
  const positions = new Map<string, number>()
  const updatePositions = () => layers.forEach((layer) => layer.forEach((item, index) => positions.set(item.id, index)))
  updatePositions()
  function reorder(layer: RuleChainGraphNode[], neighbors: Map<string, string[]>) {
    const center = (item: RuleChainGraphNode) => {
      const adjacent = neighbors.get(item.id)!
      return adjacent.length
        ? adjacent.reduce((sum, id) => sum + positions.get(id)!, 0) / adjacent.length
        : positions.get(item.id)!
    }
    layer.sort((a, b) => center(a) - center(b) || compareIds(a.id, b.id))
    layer.forEach((item, index) => positions.set(item.id, index))
  }
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let index = 1; index < layers.length; index++) reorder(layers[index], incoming)
    for (let index = layers.length - 2; index >= 0; index--) reorder(layers[index], outgoing)
  }

  const height = layers.reduce((maximum, layer) => Math.max(maximum, layer.length), 0) * (NODE_HEIGHT + ROW_GAP) - ROW_GAP
  layers.forEach((layer, column) => {
    const layerHeight = layer.length * (NODE_HEIGHT + ROW_GAP) - ROW_GAP
    layer.forEach((item, row) => {
      item.x = column * (NODE_WIDTH + COLUMN_GAP)
      item.y = (height - layerHeight) / 2 + row * (NODE_HEIGHT + ROW_GAP)
    })
  })

  let width = layers.length * (NODE_WIDTH + COLUMN_GAP) - COLUMN_GAP
  for (const edge of edges.values()) {
    const source = nodes.get(edge.source)!
    const target = nodes.get(edge.target)!
    if (target.x <= source.x) width = Math.max(width, source.x + source.width + 40, target.x + target.width + 40)
  }

  return {
    nodes: layers.flat(),
    edges: [...edges.values()].sort((a, b) => compareIds(a.id, b.id)),
    width,
    height,
  }
}
