import type { Connection } from './api'

/** Format an endpoint without confusing IPv6 colons with the port separator. */
export function connectionEndpoint(address?: string, port?: string | number): string {
  const host = typeof address === 'string' ? address.trim() : ''
  const service = typeof port === 'string' ? port.trim()
    : typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535 ? String(port) : ''
  if (!service) return host || '—'
  const bracketed = host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host
  return `${bracketed || '—'}:${service}`
}

/** Keep the received backend fields, including extensions, outside local display state. */
export function connectionJSON(row: Connection & { dl?: number; ul?: number; journal?: unknown }): string {
  const { dl: _downloadRate, ul: _uploadRate, journal: _journal, ...connection } = row
  return JSON.stringify(connection, null, 2)
}

/** Search metadata deliberately, so local UI state never becomes a search result. */
export function connectionSearchText(row: Connection, deviceName = ''): string {
  const meta = row.metadata
  return [
    row.id, deviceName, row.rule, row.rulePayload, ...row.chains, ...(row.providerChains ?? []),
    meta.network, meta.type, meta.host, meta.sniffHost, meta.sourceIP, meta.sourcePort,
    meta.destinationIP, meta.destinationPort, meta.remoteDestination, meta.process, meta.processPath,
    meta.inboundIP, meta.inboundPort, meta.inboundName, meta.inboundUser, meta.dnsMode,
    meta.sourceIPASN, meta.destinationIPASN, ...(meta.sourceGeoIP ?? []), ...(meta.destinationGeoIP ?? []),
    meta.rematchName, meta.specialProxy, meta.specialRules, meta.smartBlock, meta.smartTarget,
    meta.wildcardTarget, meta.exitGeoIP, meta.exitIPASN, meta.uid, meta.dscp,
  ].filter(value => value !== undefined && value !== null && value !== '').join(' ').toLowerCase()
}
