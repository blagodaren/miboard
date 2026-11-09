<script lang="ts">
  import type { ProviderNodeHealth } from '../lib/provider-tools'
  import type { Proxy } from '../lib/api'
  import IconInfo from '@lucide/svelte/icons/info'
  import { t, i18n } from '../lib/i18n.svelte'
  import { count } from '../lib/format'
  import Button from './Button.svelte'
  import SearchInput from './SearchInput.svelte'

  let { name, nodes, rawNodes, oninspect }: { name: string; nodes: ProviderNodeHealth[]; rawNodes: Proxy[]; oninspect: (node: Proxy) => void } = $props()
  function inspect(name: string) { const node = rawNodes.find(item => item.name === name); if (node) oninspect(node) }
  const PAGE_SIZE = 50
  let query = $state('')
  let protocol = $state('*')
  let sort = $state('config')
  let page = $state(1)
  const protocols = $derived([...new Set(nodes.map(node => node.type))].sort((a, b) => a.localeCompare(b, i18n.intlLocale)))
  const filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase(i18n.intlLocale)
    const result = nodes.filter(node => (!needle || node.name.toLocaleLowerCase(i18n.intlLocale).includes(needle)) && (protocol === '*' || node.type === protocol))
    if (sort === 'name') result.sort((a, b) => a.name.localeCompare(b.name, i18n.intlLocale, { numeric: true }))
    if (sort === 'latency') {
      const band = (node: ProviderNodeHealth) => node.status === 'alive' ? 0 : node.status === 'dead' ? 1 : 2
      result.sort((a, b) => band(a) - band(b) || (a.delay ?? Infinity) - (b.delay ?? Infinity) || a.name.localeCompare(b.name, i18n.intlLocale))
    }
    if (sort === 'checked') result.sort((a, b) => (b.checkedAt ?? -Infinity) - (a.checkedAt ?? -Infinity) || a.name.localeCompare(b.name, i18n.intlLocale))
    return result
  })
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)))
  const currentPage = $derived(Math.min(page, pages))
  const rows = $derived(filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE))
  const dateTime = (timestamp: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
  $effect(() => { query; protocol; sort; page = 1 })
  $effect(() => { if (protocol !== '*' && !protocols.includes(protocol)) protocol = '*' })
  const selectClass = 'h-11 max-w-full rounded-control border border-field-border bg-field px-3 text-[13px] text-fg sm:h-8'
</script>

<div class="border-t border-line" data-testid="provider-node-list" aria-label={t('providers.nodesFor', { name })}>
  <div class="flex flex-wrap items-end gap-3 p-4 sm:px-5">
    <div class="min-w-0 flex-1 basis-52" data-testid="provider-nodes-search"><SearchInput bind:value={query} placeholder={t('providers.searchNodes')} /></div>
    <label class="flex min-w-0 flex-col gap-1 text-xs text-fg-3">
      <span>{t('providers.protocol')}</span>
      <select class={selectClass} bind:value={protocol} data-testid="provider-nodes-protocol">
        <option value="*">{t('providers.allProtocols')}</option>
        {#each protocols as type (type)}<option value={type}>{type || t('providers.unknownType')}</option>{/each}
      </select>
    </label>
    <label class="flex min-w-0 flex-col gap-1 text-xs text-fg-3">
      <span>{t('providers.sort')}</span>
      <select class={selectClass} bind:value={sort} data-testid="provider-nodes-sort">
        <option value="config">{t('providers.sortConfig')}</option>
        <option value="name">{t('providers.sortName')}</option>
        <option value="latency">{t('providers.sortLatency')}</option>
        <option value="checked">{t('providers.sortChecked')}</option>
      </select>
    </label>
  </div>
  <p class="px-4 pb-3 text-xs text-fg-3 sm:px-5">{t('providers.nodeResults', { count: filtered.length, total: nodes.length })}</p>
  <div class="overflow-x-auto border-t border-line">
    <table class="w-full min-w-[640px] text-left text-xs">
      <thead class="bg-raised text-fg-3"><tr>
        <th class="px-4 py-3 font-normal">{t('providers.nodeName')}</th>
        <th class="px-3 py-3 font-normal">{t('providers.protocol')}</th>
        <th class="px-3 py-3 font-normal">{t('providers.nodeStatus')}</th>
        <th class="px-3 py-3 text-right font-normal">{t('providers.nodeDelay')}</th>
        <th class="px-4 py-3 font-normal">{t('providers.lastCheck')}</th>
      </tr></thead>
      <tbody>
        {#each rows as node, index (index)}
          <tr class="border-t border-line" data-testid="provider-node-row">
            <td class="max-w-72 break-words px-4 py-3 font-mono [overflow-wrap:anywhere]"><button type="button" class="inline-flex min-h-11 items-center gap-2 rounded-control text-left text-fg hover:bg-hover sm:min-h-8" data-testid="provider-node-diagnostics" data-node={node.name} aria-label={t('nodeDiagnostics.open', { name: node.name })} onclick={() => inspect(node.name)}><span class="min-w-0 break-words">{node.name}</span><IconInfo class="size-3 shrink-0 text-fg-3" strokeWidth={1.5} aria-hidden="true" /></button></td>
            <td class="px-3 py-3 text-fg-2">{node.type || t('providers.unknownType')}</td>
            <td class="px-3 py-3 whitespace-nowrap {node.status === 'alive' ? 'text-good' : 'text-fg-2'}">{t(node.status === 'alive' ? 'providers.alive' : node.status === 'dead' ? 'providers.dead' : 'providers.unknown')}</td>
            <td class="num px-3 py-3 text-right font-mono whitespace-nowrap">{node.status === 'alive' && node.delay !== null ? t('proxies.delay', { delay: count(node.delay) }) : '—'}</td>
            <td class="px-4 py-3 text-fg-3 whitespace-nowrap">{node.checkedAt === null ? t('providers.checkTimeUnknown') : dateTime(node.checkedAt)}</td>
          </tr>
        {:else}
          <tr><td colspan="5" class="px-4 py-6 text-fg-3">{t(nodes.length ? 'providers.noMatchingNodes' : 'providers.noNodes')}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if pages > 1}
    <nav class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 sm:px-5" aria-label={t('providers.nodePages', { name })}>
      <p class="num text-xs text-fg-3" data-testid="provider-nodes-page">{t('providers.page', { current: currentPage, total: pages })}</p>
      <div class="flex gap-2">
        <Button size="sm" data-testid="provider-nodes-previous" disabled={currentPage <= 1} onclick={() => page = currentPage - 1}>{t('providers.previous')}</Button>
        <Button size="sm" data-testid="provider-nodes-next" disabled={currentPage >= pages} onclick={() => page = currentPage + 1}>{t('providers.next')}</Button>
      </div>
    </nav>
  {/if}
</div>
