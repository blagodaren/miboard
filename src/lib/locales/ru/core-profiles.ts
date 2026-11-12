import type { Message } from '../../i18n-types'
import type { en } from '../en/core-profiles'

export const ru: Record<keyof typeof en, Message> = {
  'coreProfiles.title': 'Профили памяти',
  'coreProfiles.hint': 'Снимок для анализа в Go pprof. Доступен, если ядро было запущено с уровнем логирования debug. Скачивание не меняет настройки ядра.',
  'coreProfiles.heap': 'Скачать heap',
  'coreProfiles.allocs': 'Скачать allocations',
  'coreProfiles.busy': 'Скачивание…',
  'coreProfiles.saved': 'Профиль скачан · {size}',
  'coreProfiles.unsupported': 'Профили недоступны. Нужна поддержка pprof и запуск ядра с log-level: debug.',
  'coreProfiles.unauthorized': 'Ядро запретило доступ к профилю. Проверьте данные подключения.',
  'coreProfiles.network': 'Не удалось скачать профиль. Проверьте подключение и настройки CORS.',
  'coreProfiles.timeout': 'Время скачивания профиля истекло. Попробуйте ещё раз.',
  'coreProfiles.invalid': 'Ядро вернуло неподдерживаемый формат профиля.',
  'coreProfiles.tooLarge': 'Профиль превышает ограничение скачивания в 32 МБ.',
  'coreProfiles.http': 'Ядро не смогло предоставить профиль. Попробуйте ещё раз.',
}
