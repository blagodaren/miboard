import type { Message } from '../i18n-types'

export const en = {
  'logDetails.search': 'Search messages and fields',
  'logDetails.searchIn': 'Search in',
  'logDetails.allFields': 'Message and all fields',
  'logDetails.coreTime': 'Core time',
  'logDetails.receivedAt': 'Received by this browser',
  'logDetails.timeHint': 'Times come from the core when available; otherwise the browser receive time is shown',
  'logDetails.levelHint': 'Minimum level for this log subscription',
  'logDetails.structured': 'Structured logs',
  'logDetails.legacy': 'Text logs · core time unavailable',
  'logDetails.connecting': 'Connecting to the log stream',
  'logDetails.offline': 'Log stream offline · reconnecting',
  'logDetails.fields': 'Event fields',
  'logDetails.noFields': 'The core did not provide additional fields for this event',
  'logDetails.noMatches': 'No events match this search',
  'logDetails.details': 'Event details',
} satisfies Record<string, Message>

export const ru = {
  'logDetails.search': 'Поиск по сообщениям и полям',
  'logDetails.searchIn': 'Искать в',
  'logDetails.allFields': 'Сообщение и все поля',
  'logDetails.coreTime': 'Время ядра',
  'logDetails.receivedAt': 'Получено этим браузером',
  'logDetails.timeHint': 'Показываем время ядра, если оно передано; иначе — время получения браузером',
  'logDetails.levelHint': 'Минимальный уровень этой подписки на логи',
  'logDetails.structured': 'Структурированные логи',
  'logDetails.legacy': 'Текстовые логи · время ядра недоступно',
  'logDetails.connecting': 'Подключение к потоку логов',
  'logDetails.offline': 'Поток логов недоступен · переподключение',
  'logDetails.fields': 'Поля события',
  'logDetails.noFields': 'Ядро не передало дополнительные поля для этого события',
  'logDetails.noMatches': 'Нет событий, соответствующих поиску',
  'logDetails.details': 'Детали события',
} satisfies Record<string, Message>
