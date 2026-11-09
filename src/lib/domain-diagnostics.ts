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

export function dnsRecords(response: DnsResponse): NonNullable<DnsResponse['Answer']> {
  return (Array.isArray(response.Answer) ? response.Answer : []).filter(record =>
    record && typeof record.name === 'string' && typeof record.data === 'string'
    && Number.isInteger(record.type) && Number.isFinite(record.TTL) && record.TTL >= 0,
  ).slice(0, 100)
}

export const dnsRecordType = (type: number) => ({ 1: 'A', 5: 'CNAME', 28: 'AAAA' })[type] ?? String(type)
