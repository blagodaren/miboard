import type { Message } from '../../i18n-types'

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
