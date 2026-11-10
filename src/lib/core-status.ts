export type MemorySample = { time: number; value: number | null }
export const MEMORY_WINDOW_MS = 5 * 60 * 1000

/** Missing/offline samples are gaps, never interpolated as zero memory. */
export function appendMemorySample(samples: MemorySample[], time: number, value: number | null): MemorySample[] {
  if (!Number.isFinite(time)) return samples
  const next = Number.isFinite(value) && value !== null && value >= 0 ? value : null
  return [...samples.filter(sample => sample.time > time - MEMORY_WINDOW_MS && sample.time < time), { time, value: next }].slice(-301)
}

export function memoryChart(samples: MemorySample[], width = 600, height = 120) {
  const values = samples.filter((sample): sample is MemorySample & { value: number } => sample.value !== null)
  const peak = Math.max(0, ...values.map(sample => sample.value))
  const maximum = peak > 0 ? peak * 1.15 : 1
  const end = samples.at(-1)?.time ?? 0
  const start = Math.min(samples[0]?.time ?? end, end - 1000)
  const paths: string[] = []
  let path = ''
  for (const sample of samples) {
    if (sample.value === null) { if (path) paths.push(path); path = ''; continue }
    const x = (sample.time - start) / (end - start) * width
    const y = height - sample.value / maximum * height
    path += `${path ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  }
  if (path) paths.push(path)
  return { paths, peak, maximum, count: values.length, spanSeconds: Math.max(0, Math.round((end - (samples[0]?.time ?? end)) / 1000)) }
}

/** Config text can include user-controlled URLs; reveal neither embedded credentials nor query strings. */
export function visibleConfigUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) return ''
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol)) return '—'
    return url.origin + url.pathname
  } catch { return '—' }
}

type DetailKey = keyof typeof import('./locales/core-details').en
export type CoreDetailValue = string | number | boolean | (string | number)[]
export type CoreDetailField = { key: string; label: DetailKey; value: CoreDetailValue }
export type CoreDetailSection = { id: string; title: DetailKey; hint: DetailKey; fields: CoreDetailField[] }
type FieldKind = 'text' | 'number' | 'boolean' | 'strings' | 'numbers' | 'users'
type FieldSpec = readonly [key: string, label: DetailKey, kind: FieldKind]

function configRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Only explicitly selected public fields are rendered; raw inbound configs can contain credentials. */
function detailValue(value: unknown, kind: FieldKind): CoreDetailValue | undefined {
  if (kind === 'boolean') return typeof value === 'boolean' ? value : undefined
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (kind === 'text') return typeof value === 'string' ? value : undefined
  if (!Array.isArray(value)) return undefined
  if (kind === 'numbers') {
    const numbers = value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
    return value.length && !numbers.length ? undefined : numbers
  }
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  if (value.length && !strings.length) return undefined
  // mihomo reports usernames. Some forks may return user:password entries instead.
  return kind === 'users' ? [...new Set(strings.map(entry => entry.split(':', 1)[0].trim()).filter(Boolean))] : strings
}

function detailFields(config: Record<string, unknown>, specs: readonly FieldSpec[]): CoreDetailField[] {
  return specs.flatMap(([key, label, kind]) => {
    if (!Object.hasOwn(config, key)) return []
    const value = detailValue(config[key], kind)
    return value === undefined ? [] : [{ key, label, value }]
  })
}

/** Missing/null fields remain absent, while reported false, zero and empty lists retain their meaning. */
export function coreDetailSections(input: unknown): CoreDetailSection[] {
  const config = configRecord(input)
  const tun = configRecord(config.tun)
  const sections: CoreDetailSection[] = [
    { id: 'runtime', title: 'coreDetails.runtime', hint: 'coreDetails.reported', fields: detailFields(config, [
      ['log-level', 'coreDetails.logLevel', 'text'],
      ['disable-keep-alive', 'coreDetails.keepAliveDisabled', 'boolean'],
      ['keep-alive-idle', 'coreDetails.keepAliveIdle', 'number'],
      ['keep-alive-interval', 'coreDetails.keepAliveInterval', 'number'],
      ['inbound-tfo', 'coreDetails.inboundTfo', 'boolean'],
      ['inbound-mptcp', 'coreDetails.inboundMptcp', 'boolean'],
      ['global-ua', 'coreDetails.userAgent', 'text'],
      ['etag-support', 'coreDetails.etag', 'boolean'],
    ]) },
    { id: 'lan', title: 'coreDetails.lan', hint: 'coreDetails.lanHint', fields: detailFields(config, [
      ['allow-lan', 'coreDetails.allowLan', 'boolean'],
      ['lan-allowed-ips', 'coreDetails.allowed', 'strings'],
      ['lan-disallowed-ips', 'coreDetails.denied', 'strings'],
      ['skip-auth-prefixes', 'coreDetails.skipAuth', 'strings'],
      ['authentication', 'coreDetails.users', 'users'],
    ]) },
    { id: 'tun-routes', title: 'coreDetails.routes', hint: 'coreDetails.tunHint', fields: detailFields(tun, [
      ['inet4-address', 'coreDetails.ipv4Address', 'strings'],
      ['inet6-address', 'coreDetails.ipv6Address', 'strings'],
      ['loopback-address', 'coreDetails.loopbackAddress', 'strings'],
      ['route-address', 'coreDetails.routeAddress', 'strings'],
      ['route-address-set', 'coreDetails.routeSet', 'strings'],
      ['route-exclude-address', 'coreDetails.routeExclude', 'strings'],
      ['route-exclude-address-set', 'coreDetails.routeExcludeSet', 'strings'],
      ['inet4-route-address', 'coreDetails.ipv4Route', 'strings'],
      ['inet6-route-address', 'coreDetails.ipv6Route', 'strings'],
      ['inet4-route-exclude-address', 'coreDetails.ipv4Exclude', 'strings'],
      ['inet6-route-exclude-address', 'coreDetails.ipv6Exclude', 'strings'],
    ]) },
    { id: 'tun-filters', title: 'coreDetails.filters', hint: 'coreDetails.filterHint', fields: detailFields(tun, [
      ['include-interface', 'coreDetails.includeInterface', 'strings'],
      ['exclude-interface', 'coreDetails.excludeInterface', 'strings'],
      ['include-uid', 'coreDetails.includeUid', 'numbers'],
      ['include-uid-range', 'coreDetails.includeUidRange', 'strings'],
      ['exclude-uid', 'coreDetails.excludeUid', 'numbers'],
      ['exclude-uid-range', 'coreDetails.excludeUidRange', 'strings'],
      ['include-android-user', 'coreDetails.androidUsers', 'numbers'],
      ['include-package', 'coreDetails.includePackage', 'strings'],
      ['exclude-package', 'coreDetails.excludePackage', 'strings'],
      ['include-mac-address', 'coreDetails.includeMac', 'strings'],
      ['exclude-mac-address', 'coreDetails.excludeMac', 'strings'],
      ['exclude-src-port', 'coreDetails.excludeSrcPort', 'numbers'],
      ['exclude-src-port-range', 'coreDetails.excludeSrcPortRange', 'strings'],
      ['exclude-dst-port', 'coreDetails.excludeDstPort', 'numbers'],
      ['exclude-dst-port-range', 'coreDetails.excludeDstPortRange', 'strings'],
    ]) },
    { id: 'tun-transport', title: 'coreDetails.transport', hint: 'coreDetails.reported', fields: detailFields(tun, [
      ['auto-redirect', 'coreDetails.autoRedirect', 'boolean'],
      ['auto-redirect-input-mark', 'coreDetails.inputMark', 'number'],
      ['auto-redirect-output-mark', 'coreDetails.outputMark', 'number'],
      ['iproute2-table-index', 'coreDetails.routeTable', 'number'],
      ['iproute2-rule-index', 'coreDetails.routeRule', 'number'],
      ['auto-redirect-iproute2-fallback-rule-index', 'coreDetails.fallbackRule', 'number'],
      ['udp-timeout', 'coreDetails.udpTimeout', 'number'],
      ['icmp-timeout', 'coreDetails.icmpTimeout', 'number'],
      ['disable-icmp-forwarding', 'coreDetails.icmpDisabled', 'boolean'],
      ['endpoint-independent-nat', 'coreDetails.endpointNat', 'boolean'],
      ['congestion-controller', 'coreDetails.congestion', 'text'],
      ['gso', 'coreDetails.gso', 'boolean'],
      ['gso-max-size', 'coreDetails.gsoSize', 'number'],
    ]) },
  ]
  return sections.filter(section => section.fields.length > 0)
}
