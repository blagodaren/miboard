import type { Message } from '../../i18n-types'
import type { en } from '../en/traffic-tools'

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
