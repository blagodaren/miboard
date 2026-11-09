import type { Message } from '../i18n-types'

export const en = {
  'notifications.label': 'Notifications',
  'notifications.close': 'Dismiss notification',
  'notifications.modeError': 'Could not change routing mode: {message}',
} satisfies Record<string, Message>
export const ru: Record<keyof typeof en, Message> = {
  'notifications.label': 'Уведомления',
  'notifications.close': 'Закрыть уведомление',
  'notifications.modeError': 'Не удалось изменить режим: {message}',
}
