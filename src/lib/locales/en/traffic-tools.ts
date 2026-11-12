import type { Message } from '../../i18n-types'

export const en = {
  'traffic.export': 'Export domains',
  'traffic.exportHint': 'TXT · {count} unique domains from the full selection',
  'traffic.exportError': 'Could not download the domain list',
  'traffic.inbounds': 'Inbound traffic',
  'traffic.groupBy': 'Group inbound traffic by',
  'traffic.byInbound': 'Inbound',
  'traffic.byProtocol': 'Protocol',
  'traffic.byUser': 'User',
  'traffic.search': 'Inbound, user, protocol, device or domain',
  'traffic.unknownInbound': 'Unknown inbound',
  'traffic.unknownProtocol': 'Unknown protocol',
  'traffic.unknownUser': 'User not reported',
  'traffic.typeOnly': '{type} · unnamed inbound',
  'traffic.sourceDevices': 'Source devices',
  'traffic.inboundHint': 'Observed session traffic. User names are separated by inbound; missing names remain unknown. TCP/UDP describes the connection transport, not the proxy protocol.',
} satisfies Record<string, Message>
