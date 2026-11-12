import type { Message } from '../../i18n-types'
import type { en } from '../en/proxy-preferences'

export const ru: Record<keyof typeof en, Message> = {
  'proxyTest.title': 'Группы для общего замера',
  'proxyTest.all': 'Все группы',
  'proxyTest.selected': 'Выбранные группы',
  'proxyTest.summaryAll': 'Все группы и ноды',
  'proxyTest.summarySelected': 'Выбрано групп: {count}',
  'proxyTest.hint': 'Действует на «Замерить все». Отдельный замер группы остаётся доступен. Выбор сохраняется для этого сервера.',
  'proxyTest.selectAll': 'Выбрать все',
  'proxyTest.selectNone': 'Снять выбор',
  'proxyTest.hidden': 'Скрытая',
  'proxyTest.none': 'Выбери хотя бы одну группу для общего замера.',
  'proxyTest.memory': 'Выбор применён на текущую сессию. Хранилище браузера недоступно.',
  'proxyTest.ambiguous': 'Это имя встречается в нескольких подписках. Выбери провайдера в проверке стабильности или открой «Провайдеры» для сведений. При замере группы её состав определяет ядро.',
  'proxyTest.ambiguousShort': 'Несколько подписок',
}
