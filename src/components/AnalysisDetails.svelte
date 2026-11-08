<script lang="ts">
  import type { DomainStat, IPStat, ProxyStat } from '../lib/analysis'
  import { bytes } from '../lib/format'
  import { proxyName } from '../lib/analysis-display'
  import { t } from '../lib/i18n.svelte'

  let { row, view, onnavigate }: {
    row: DomainStat | IPStat | ProxyStat
    view: 'domains' | 'ips' | 'proxies'
    onnavigate: (view: 'domains' | 'ips' | 'proxies', value: string) => void
  } = $props()

  let limits = $state<Record<string, number>>({})
  $effect(() => { row.name; view; limits = {} })

  const groups = $derived.by(() => {
    const result: { title: string; view?: 'domains' | 'ips' | 'proxies'; values: string[] }[] = []
    if ('domains' in row) result.push({ title: t('analysis.relatedDomains'), view: 'domains', values: row.domains })
    if ('ips' in row) result.push({ title: t('analysis.destinationIPs'), view: 'ips', values: row.ips })
    if ('proxies' in row) result.push({ title: t('analysis.exitNodes'), view: 'proxies', values: row.proxies })
    if (view === 'ips' && 'countries' in row) {
      result.push({ title: t('analysis.geoRegions'), values: row.countries })
      result.push({ title: t('analysis.asnOrganization'), values: row.asn })
    }
    return result
  })
</script>

<div class="border-t border-line bg-deep/60 px-4 py-4 sm:px-5">
  <div class="flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-fg-2">
    <span>↓ {bytes(row.download)}</span>
    <span>↑ {bytes(row.upload)}</span>
    <span>{t('analysis.activeOfTotal', { active: row.active, total: row.connections })}</span>
  </div>
  <div class="mt-4 grid gap-5 sm:grid-cols-2">
    {#each groups as group (group.title)}
      <section class="min-w-0">
        <h3 class="mb-2 text-xs text-fg-3">{group.title}</h3>
        {#if group.values.length}
          <ul class="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto">
            {#each group.values.slice(0, limits[group.title] ?? 100) as value (value)}
              <li class="max-w-full">
                {#if group.view}
                  <button class="min-h-11 max-w-full break-all rounded-md border border-line bg-card px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:border-line-strong hover:text-accent-ink active:scale-[0.98]" onclick={() => onnavigate(group.view!, value)}>{group.view === 'proxies' ? proxyName(value) : value}</button>
                {:else}
                  <span class="inline-block break-all py-1.5 font-mono text-xs text-fg-2">{value}</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if group.values.length > (limits[group.title] ?? 100)}
            <button class="mt-2 min-h-11 text-xs text-fg-2 transition-colors hover:text-fg" onclick={() => (limits[group.title] = (limits[group.title] ?? 100) + 100)}>{t('analysis.moreRelations', { count: Math.min(100, group.values.length - (limits[group.title] ?? 100)) })}</button>
          {/if}
        {:else}
          <p class="text-[13px] text-fg-3">{group.view === 'domains' ? t('analysis.noDomain') : t('analysis.noData')}</p>
        {/if}
      </section>
    {/each}
  </div>
</div>
