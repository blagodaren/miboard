import type { Message } from '../i18n-types'

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

export const ru: Record<keyof typeof en, Message> = {
  'traffic.export': 'Экспорт доменов',
  'traffic.exportHint': 'TXT · {count} уникальных доменов из полной выборки',
  'traffic.exportError': 'Не удалось скачать список доменов',
  'traffic.inbounds': 'Входящий трафик',
  'traffic.groupBy': 'Группировать входящий трафик по',
  'traffic.byInbound': 'Вход',
  'traffic.byProtocol': 'Протокол',
  'traffic.byUser': 'Пользователь',
  'traffic.search': 'Вход, пользователь, протокол, устройство или домен',
  'traffic.unknownInbound': 'Неизвестный вход',
  'traffic.unknownProtocol': 'Неизвестный протокол',
  'traffic.unknownUser': 'Пользователь не передан',
  'traffic.typeOnly': '{type} · вход без имени',
  'traffic.sourceDevices': 'Устройства-источники',
  'traffic.inboundHint': 'Наблюдавшийся трафик сеанса. Пользователи разделены по входам; отсутствующие имена остаются неизвестными. TCP/UDP — транспорт соединения, а не протокол прокси.',
}
