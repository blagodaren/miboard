import type { Connection, DnsResponse } from './api'

/** A DNS lookup always targets the controller; a pasted URL contributes only its host. */
export function diagnosticHost(value: string): string | null {
  const input = value.trim()
  if (!input || input.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(input)) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (!host || host.length > 253 || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return null
    if (host.split('.').some(label => label.length > 63 || !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return null
    return host
  } catch {
    return null
  }
}

type ObservedClosed = { connection: Connection; firstSeenAt: number; lastSeenAt: number; closedAt: number; afterGap?: boolean }
export type DomainObservation = {
  key: string
  connection: Connection
  source: 'active' | 'closed'
  observedAt: number
  afterGap: boolean
}

export function domainObservations(host: string, active: readonly Connection[], closed: readonly ObservedClosed[], now: number): DomainObservation[] {
  const matches = (connection: Connection) => [connection.metadata.host, connection.metadata.sniffHost]
    .some(value => typeof value === 'string' && diagnosticHost(value) === host)
  const identity = (connection: Connection) => JSON.stringify([connection.id, connection.start])
  const activeIds = new Set(active.map(identity))
  const live = active.filter(matches).map(connection => ({
    key: `active:${identity(connection)}`, connection, source: 'active' as const, observedAt: now, afterGap: false,
  })).sort((a, b) => (Date.parse(b.connection.start) || 0) - (Date.parse(a.connection.start) || 0))
  const history = closed.filter(entry => !activeIds.has(identity(entry.connection)) && matches(entry.connection))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(entry => ({ key: `closed:${identity(entry.connection)}:${entry.closedAt}`, connection: entry.connection, source: 'closed' as const, observedAt: entry.lastSeenAt, afterGap: !!entry.afterGap }))
  // Shared CDN addresses are not evidence that a connection belongs to this domain.
  return [...live, ...history].slice(0, 50)
}

export function diagnosticRoute(connection: Connection): string[] {
  return (connection.chains ?? []).filter(value => typeof value === 'string' && value.trim()).slice().reverse()
}

export const DNS_QUERY_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'CAA'] as const
export type DnsQueryType = typeof DNS_QUERY_TYPES[number]
export type DnsSection = 'Answer' | 'Authority' | 'Additional'

/** Reverse only strict IP literals; URL's permissive IPv4 formats must not enter queries. */
export function reverseDnsName(value: string): string | null {
  const input = value.trim().toLowerCase().replace(/\.$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(input)) {
    const parts = input.split('.')
    return parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
      ? parts.reverse().join('.') + '.in-addr.arpa' : null
  }
  if (/^(?:[0-9a-f]\.){32}ip6\.arpa$/.test(input)) return input
  if (input.endsWith('.in-addr.arpa')) {
    const parts = input.slice(0, -'.in-addr.arpa'.length).split('.')
    return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) ? input : null
  }
  if (!input.includes(':') || !(input.startsWith('[') ? /^\[[0-9a-f:.]+\]$/.test(input) : /^[0-9a-f:.]+$/.test(input))) return null
  try {
    const host = new URL(`http://${input.startsWith('[') ? input : `[${input}]`}`).hostname
    if (!host.startsWith('[') || !host.endsWith(']')) return null
    const [left, right] = host.slice(1, -1).split('::')
    const head = left ? left.split(':') : []
    const tail = right ? right.split(':') : []
    const parts = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null
    return parts.map(part => part.padStart(4, '0')).join('').split('').reverse().join('.') + '.ip6.arpa'
  } catch { return null }
}

export function dnsQueryName(value: string, type: DnsQueryType | 'A+AAAA'): string | null {
  if (type === 'PTR') return reverseDnsName(value)
  const host = diagnosticHost(value)
  if (host) return host
  // TXT records such as _dmarc.example.com have DNS labels, not host labels.
  const input = value.trim().toLowerCase().replace(/\.$/, '')
  if (!input || input.length > 253 || !input.includes('_') || /[^a-z\d_.-]/.test(input)) return null
  return input.split('.').every(label => label.length <= 63 && /^[a-z\d_](?:[a-z\d_-]*[a-z\d_])?$/.test(label)) ? input : null
}

export function dnsRecords(response: DnsResponse, section: DnsSection = 'Answer'): NonNullable<DnsResponse['Answer']> {
  return (Array.isArray(response[section]) ? response[section] : []).filter(record =>
    record && typeof record.name === 'string' && typeof record.data === 'string'
    && Number.isInteger(record.type) && record.type >= 0 && record.type <= 65535 && Number.isFinite(record.TTL) && record.TTL >= 0,
  ).slice(0, 100)
}

export function dnsQuestions(response: DnsResponse) {
  return (Array.isArray(response.Question) ? response.Question : []).filter(question => question &&
    typeof question.Name === 'string' && Number.isInteger(question.Qtype) && question.Qtype >= 0 && question.Qtype <= 65535 &&
    Number.isInteger(question.Qclass) && question.Qclass >= 0 && question.Qclass <= 65535).slice(0, 100)
}

export function dnsFlags(response: DnsResponse) {
  return (['TC', 'RD', 'RA', 'AD', 'CD'] as const).flatMap(name => typeof response[name] === 'boolean' ? [{ name, value: response[name] }] : [])
}

export const dnsRecordType = (type: number) => ({ 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 257: 'CAA' })[type] ?? String(type)
