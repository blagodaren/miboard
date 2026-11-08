<script lang="ts">
  import type { ProxySort, ProxySortKey } from '../lib/proxy-sort'
  import { t } from '../lib/i18n.svelte'
  import { IconCheck, IconCopy } from '../lib/icons'

  let { group, order, applied = false, onchange, onreverse, onapply }: {
    group: string
    order: ProxySort
    applied?: boolean
    onchange: (key: ProxySortKey) => void
    onreverse: () => void
    onapply: () => void
  } = $props()

  const direction = $derived(order.key === 'latency'
    ? t(order.direction === 'asc' ? 'proxies.sortFastFirst' : 'proxies.sortSlowFirst')
    : t(order.direction === 'asc' ? 'proxies.sortAscending' : 'proxies.sortDescending'))
</script>

<div class="flex items-center gap-1.5 border-t border-line bg-raised px-3 py-1.5">
  <label class="sr-only" for="sort-{encodeURIComponent(group)}">{t('proxies.sortGroup', { name: group })}</label>
  <select id="sort-{encodeURIComponent(group)}" value={order.key} onchange={(event) => onchange(event.currentTarget.value as ProxySortKey)} class="h-[44px] w-0 min-w-0 max-w-[180px] flex-1 rounded-md border border-field-border bg-field px-2 text-xs text-fg sm:h-8">
    <option value="config">{t('proxies.sortConfig')}</option>
    <option value="latency">{t('proxies.sortLatency')}</option>
    <option value="name">{t('proxies.sortName')}</option>
    <option value="protocol">{t('proxies.sortProtocol')}</option>
  </select>
  {#if order.key !== 'config'}
    <button class="flex size-[44px] shrink-0 items-center justify-center rounded-md font-mono text-base text-fg-2 transition-colors hover:bg-hover hover:text-fg active:scale-[0.98] sm:size-8" onclick={onreverse} title={direction} aria-label={t('proxies.sortDirection', { name: group, direction })}>{order.direction === 'asc' ? '↑' : '↓'}</button>
  {/if}
  <button class="ml-auto inline-flex h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg active:scale-[0.98] sm:h-8" onclick={onapply} title={t('proxies.sortApplyAll')} aria-label={t('proxies.sortApplyAllLabel', { name: group })}>
    {#if applied}<IconCheck class="size-3.5" strokeWidth={1.5} />{:else}<IconCopy class="size-3.5" strokeWidth={1.5} />{/if}
    <span>{t(applied ? 'proxies.sortAppliedShort' : 'proxies.sortApplyShort')}</span>
  </button>
  <span class="sr-only" role="status">{applied ? t('proxies.sortAppliedAll') : ''}</span>
</div>
