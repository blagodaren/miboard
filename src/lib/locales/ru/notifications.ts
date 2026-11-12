import type { Message } from '../../i18n-types'
import type { en } from '../en/notifications'

export const ru: Record<keyof typeof en, Message> = {
  'notifications.label': 'Уведомления',
  'notifications.close': 'Закрыть уведомление',
  'notifications.modeError': 'Не удалось изменить режим: {message}',
}
