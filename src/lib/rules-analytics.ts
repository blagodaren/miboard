import type { Connection, Rule } from './api'

/** Lifetime counters of the currently open connections, not session totals. */
export type RuleTrafficTotals = {
  download: number
  upload: number
  total: number
  connections: number
}

export type DomainTrafficStat = RuleTrafficTotals & { name: string }

export type RuleChainStat = RuleTrafficTotals & {
  id: string
  ruleId: string
  policy: string
  outbound: string
  /** Intermediate selectors in routing order (policy → outbound). */
  via: string[]
  /** Observed chain in routing order. Empty means the API supplied no chain. */
  path: string[]
}

export type RuleTrafficStat = RuleTrafficTotals & {
  id: string
  type: string
  payload: string
  name: string
  /** Empty when the API did not identify a policy. */
  policy: string
  /** One-based configured-rule position, only when the match is unambiguous. */
  ruleIndex: number | null
  /** Fraction of all observed traffic, from 0 to 1. */
  share: number
  domains: DomainTrafficStat[]
  chains: RuleChainStat[]
}

export type RulesAnalyticsSnapshot = {
  totals: RuleTrafficTotals
  rules: RuleTrafficStat[]
  chains: RuleChainStat[]
}

type RuleBucket = Omit<RuleTrafficStat, 'domains' | 'chains'> & {
  domains: Map<string, DomainTrafficStat>
  chains: Map<string, RuleChainStat>
}

const emptyTotals = (): RuleTrafficTotals => ({ download: 0, upload: 0, total: 0, connections: 0 })
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const ruleType = (value: string): string => value.replace(/[-_]/g, '').toLowerCase()
const validCounter = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const keyForRule = (type: string, payload: string): string => JSON.stringify([ruleType(type), payload])

function addTraffic(target: RuleTrafficTotals, download: number, upload: number): void {
  target.download += download
  target.upload += upload
  target.total += download + upload
  target.connections++
}

const byTraffic = <T extends RuleTrafficTotals & { name?: string; id?: string }>(a: T, b: T): number =>
  b.total - a.total || b.connections - a.connections || (a.name ?? a.id ?? '').localeCompare(b.name ?? b.id ?? '')

/** Reject IP literals (including mapped/scoped IPv6) from the domain chart. */
function isAddress(candidate: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) return true
  if (candidate.includes(':')) return true
  try {
    return /^\d+\.\d+\.\d+\.\d+$/.test(new URL(`http://${candidate}/`).hostname)
  } catch {
    return false
  }
}

function domainName(value: unknown): string {
  const candidate = text(value).toLowerCase().replace(/\.+$/, '')
  if (!candidate || candidate.length > 253 || isAddress(candidate) || /[\s/\\:@\[\]?#%]/.test(candidate)) return ''
  try {
    const normalized = new URL(`http://${candidate}/`).hostname
    return normalized.length <= 253 && !isAddress(normalized) ? normalized : ''
  } catch {
    return ''
  }
}

/**
 * Aggregate one /connections frame. Repeated frames are never accumulated here:
 * counters already contain the lifetime traffic of each currently open ID.
 * mihomo stores chains as outbound → selectors → policy; UI paths reverse it.
 */
export function buildRulesAnalytics(
  connections: readonly Connection[],
  configuredRules: readonly Rule[] = [],
): RulesAnalyticsSnapshot {
  const configured = new Map<string, { rule: Rule; index: number }[]>()
  configuredRules.forEach((rule, index) => {
    const key = keyForRule(text(rule.type), text(rule.payload))
    const matches = configured.get(key) ?? []
    matches.push({ rule, index: index + 1 })
    configured.set(key, matches)
  })

  const totals = emptyTotals()
  const rules = new Map<string, RuleBucket>()
  const chains = new Map<string, RuleChainStat>()
  const seen = new Set<string>()

  for (const connection of connections) {
    if (typeof connection.id !== 'string' || !connection.id || seen.has(connection.id)) continue
    seen.add(connection.id)

    const type = text(connection.rule)
    const payload = text(connection.rulePayload)
    const rawChain = Array.isArray(connection.chains) ? connection.chains : []
    // Never infer an outbound (or DIRECT) from a missing chain.
    const outbound = text(rawChain[0])
    const policy = text(rawChain.at(-1))
    const path = rawChain.map(text).filter(Boolean).reverse()
    const ruleId = JSON.stringify([ruleType(type), payload, policy])
    let rule = rules.get(ruleId)
    if (!rule) {
      const candidates = configured.get(keyForRule(type, payload)) ?? []
      const policyMatches = candidates.filter(({ rule }) => text(rule.proxy) === policy)
      const matches = policy ? policyMatches : candidates
      const match = matches.length === 1 ? matches[0] : undefined
      rule = {
        ...emptyTotals(), id: ruleId, type: match?.rule.type ?? type, payload,
        name: payload || match?.rule.type || type, policy, ruleIndex: match?.index ?? null, share: 0,
        domains: new Map(), chains: new Map(),
      }
      rules.set(ruleId, rule)
    }

    const download = validCounter(connection.download)
    const upload = validCounter(connection.upload)
    addTraffic(totals, download, upload)
    addTraffic(rule, download, upload)

    const metadata = connection.metadata && typeof connection.metadata === 'object' ? connection.metadata : undefined
    const domain = domainName(metadata?.sniffHost) || domainName(metadata?.host)
    if (domain) {
      let row = rule.domains.get(domain)
      if (!row) {
        row = { ...emptyTotals(), name: domain }
        rule.domains.set(domain, row)
      }
      addTraffic(row, download, upload)
    }

    const chainId = JSON.stringify([ruleId, rawChain.map(text)])
    let chain = chains.get(chainId)
    if (!chain) {
      chain = { ...emptyTotals(), id: chainId, ruleId, policy, outbound, path, via: path.slice(1, -1) }
      chains.set(chainId, chain)
      rule.chains.set(chainId, chain)
    }
    addTraffic(chain, download, upload)
  }

  return {
    totals,
    rules: [...rules.values()].map((rule) => ({
      ...rule,
      share: totals.total > 0 ? rule.total / totals.total : 0,
      domains: [...rule.domains.values()].sort(byTraffic),
      chains: [...rule.chains.values()].sort(byTraffic),
    })).sort(byTraffic),
    chains: [...chains.values()].sort(byTraffic),
  }
}
