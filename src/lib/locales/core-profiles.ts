import type { Message } from '../i18n-types'

export const en = {
  'coreProfiles.title': 'Memory profiles',
  'coreProfiles.hint': 'Download a snapshot for analysis with Go pprof. Available when the core was started with debug logging. Downloading does not change its settings.',
  'coreProfiles.heap': 'Download heap',
  'coreProfiles.allocs': 'Download allocations',
  'coreProfiles.busy': 'Downloading…',
  'coreProfiles.saved': 'Profile downloaded · {size}',
  'coreProfiles.unsupported': 'Profiles are unavailable. The core must support pprof and have been started with log-level: debug.',
  'coreProfiles.unauthorized': 'The core denied access to this profile. Check the connection credentials.',
  'coreProfiles.network': 'Could not download the profile. Check the connection and CORS settings.',
  'coreProfiles.timeout': 'The profile download timed out. Try again.',
  'coreProfiles.invalid': 'The core returned an unsupported profile format.',
  'coreProfiles.tooLarge': 'The profile exceeds the 32 MB download limit.',
  'coreProfiles.http': 'The core could not provide the profile. Try again.',
} satisfies Record<string, Message>

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
