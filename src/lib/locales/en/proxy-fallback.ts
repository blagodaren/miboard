import type { Message } from '../../i18n-types'

export const en = {
  'proxyFallback.label': 'When the group is empty',
  'proxyFallback.hint': 'The core uses this exit when no nodes remain after filtering. It does not report whether this fallback is currently in use.',
} satisfies Record<string, Message>
