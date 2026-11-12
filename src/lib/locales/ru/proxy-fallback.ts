import type { Message } from '../../i18n-types'
import type { en } from '../en/proxy-fallback'

export const ru: Record<keyof typeof en, Message> = {
  'proxyFallback.label': 'При пустой группе',
  'proxyFallback.hint': 'Ядро использует этот выход, когда после фильтрации в группе не осталось узлов. Ядро отдельно не сообщает, используется ли резерв сейчас.',
}
