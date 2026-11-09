import type { Message } from '../i18n-types'

export const en = {
  'proxyTest.title': 'Groups for Test all',
  'proxyTest.all': 'All groups',
  'proxyTest.selected': 'Selected groups',
  'proxyTest.summaryAll': 'All groups and nodes',
  'proxyTest.summarySelected': '{count} groups selected',
  'proxyTest.hint': 'Applies to Test all. Individual group checks remain available. Saved for this server.',
  'proxyTest.selectAll': 'Select all',
  'proxyTest.selectNone': 'Clear selection',
  'proxyTest.hidden': 'Hidden',
  'proxyTest.none': 'Select at least one group to start a bulk test.',
  'proxyTest.memory': 'Selection applies for this session. Browser storage is unavailable.',
  'proxyTest.ambiguous': 'This name exists in multiple subscriptions. Choose its provider in the stability check or open Providers for details. The group check is resolved by the core.',
  'proxyTest.ambiguousShort': 'Multiple providers',
} satisfies Record<string, Message>

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
