import type { RuleProvider } from './api'

const vehicleType = (provider?: RuleProvider) => typeof provider?.vehicleType === 'string' ? provider.vehicleType.toLowerCase() : ''

/** Keep API order within each section, with configuration-owned Inline sets last. */
export function orderedRuleProviders(providers: Record<string, RuleProvider> | null): Array<[string, RuleProvider]> {
  const external: Array<[string, RuleProvider]> = []
  const inline: Array<[string, RuleProvider]> = []
  for (const entry of Object.entries(providers ?? {})) {
    (vehicleType(entry[1]) === 'inline' ? inline : external).push(entry)
  }
  return [...external, ...inline]
}

export function canUpdateRuleProvider(provider?: RuleProvider): boolean {
  return ['http', 'file'].includes(vehicleType(provider))
}

/** Record keys are API identities; the view's search never limits a bulk update. */
export function ruleProviderUpdateTargets(providers: Record<string, RuleProvider> | null): string[] {
  return orderedRuleProviders(providers)
    .filter(([, provider]) => canUpdateRuleProvider(provider))
    .map(([name]) => name)
}
