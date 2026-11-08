import { UNKNOWN_PROXY } from './analysis'
import { t } from './i18n.svelte'

export function proxyName(value: string): string {
  return value === UNKNOWN_PROXY ? t('analysis.unknownProxy') : value
}
