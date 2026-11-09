import type { Message } from '../i18n-types'

export const en = {
  'liveUpdates.title': 'Live updates',
  'liveUpdates.mode': 'Background collection',
  'liveUpdates.realtime': 'Continuous',
  'liveUpdates.eco': 'Economy',
  'liveUpdates.hint': 'Applies to traffic, connections and core memory across all pages',
  'liveUpdates.realtimeHint': 'Continue collecting while this browser tab is open, including in the background',
  'liveUpdates.ecoHint': 'Pause collection while this tab is hidden. Resume when you return; history will contain gaps. Connections that start and end during a pause cannot be recorded',
  'liveUpdates.memory': 'Applied for this session. Browser storage is unavailable',
  'liveUpdates.paused': 'Economy mode: collection is paused while this tab is hidden',
  'liveUpdates.reconnecting': 'Restoring live updates. Values remain a snapshot until new data arrives',
  'liveUpdates.gap': 'This session contains gaps in observation. Traffic during a pause is not reconstructed; connection totals may include bytes transferred during the gap',
  'liveUpdates.dismiss': 'Dismiss the observation gap notice',
} satisfies Record<string, Message>

export const ru: Record<keyof typeof en, Message> = {
  'liveUpdates.title': 'Обновление данных',
  'liveUpdates.mode': 'Сбор данных в фоне',
  'liveUpdates.realtime': 'Непрерывно',
  'liveUpdates.eco': 'Экономно',
  'liveUpdates.hint': 'Трафик, соединения и память ядра на всех страницах',
  'liveUpdates.realtimeHint': 'Продолжать сбор, пока вкладка браузера открыта, в том числе в фоне',
  'liveUpdates.ecoHint': 'Приостанавливать сбор, когда вкладка скрыта. При возвращении сбор продолжится, но в истории будут пропуски. Соединения, начавшиеся и завершившиеся во время паузы, не попадут в журнал',
  'liveUpdates.memory': 'Применено на текущую сессию. Хранилище браузера недоступно',
  'liveUpdates.paused': 'Экономный режим: сбор приостановлен, пока вкладка скрыта',
  'liveUpdates.reconnecting': 'Восстанавливаем обновление данных. До нового ответа показан последний снимок',
  'liveUpdates.gap': 'В этой сессии были перерывы наблюдения. График не восстанавливает трафик за время паузы; счётчики соединений могут включать переданные за это время байты',
  'liveUpdates.dismiss': 'Скрыть сообщение о перерыве наблюдения',
}
