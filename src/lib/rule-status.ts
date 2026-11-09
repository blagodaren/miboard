import type { Rule } from './api'

export type RuleSort = 'config' | 'hits' | 'misses'

export function ruleIndex(rule: Rule): number | null {
  return typeof rule.index === 'number' && Number.isSafeInteger(rule.index) && rule.index >= 0 ? rule.index : null
}

const counter = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** Go zero time and Unix epoch placeholders are unset, not rule evaluations. */
export function ruleTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || value.startsWith('0001-')) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
}

export function ruleStats(rule: Rule) {
  const extra = rule.extra
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null
  const hits = counter(extra.hitCount), misses = counter(extra.missCount)
  const stats = {
    disabled: typeof extra.disabled === 'boolean' ? extra.disabled : null,
    hits, misses,
    // A reported zero count is explicit evidence that this event has not occurred.
    // Missing counters remain unknown and do not discard a valid independent timestamp.
    hitAt: hits === 0 ? null : ruleTimestamp(extra.hitAt),
    missAt: misses === 0 ? null : ruleTimestamp(extra.missAt),
  }
  return Object.values(stats).some(value => value !== null) ? stats : null
}

export function orderedRules(rules: readonly Rule[], sort: RuleSort, query = '') {
  const needle = query.trim().toLowerCase()
  const rows = rules.map((rule, position) => ({ ...rule, position, i: position + 1 }))
    .filter(rule => !needle || `${rule.type} ${rule.payload} ${rule.proxy}`.toLowerCase().includes(needle))
  if (sort !== 'config') rows.sort((a, b) =>
    (ruleStats(b)?.[sort] ?? -1) - (ruleStats(a)?.[sort] ?? -1) || a.position - b.position)
  return rows
}

/** An index from an old config must never disable a different rule after a reload. */
export function currentRuleForToggle(previous: Rule, rules: readonly Rule[]): Rule | null {
  const index = ruleIndex(previous)
  if (index === null) return null
  const matches = rules.filter(rule => ruleIndex(rule) === index)
  if (matches.length !== 1) return null
  const next = matches[0]
  return next.type === previous.type && next.payload === previous.payload && next.proxy === previous.proxy &&
    ruleStats(next)?.disabled !== null && ruleStats(next)?.disabled !== undefined ? next : null
}
