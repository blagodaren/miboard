import type { Message } from '../../i18n-types'
import type { en } from '../en/log-details'

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
