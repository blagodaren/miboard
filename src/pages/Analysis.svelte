<script lang="ts">
  import { core } from '../lib/core.svelte'
  import type { AnalysisSnapshot, DomainStat, IPStat, ProxyStat } from '../lib/analysis'
  import { proxyName } from '../lib/analysis-display'
  import { bytes, count } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconChevron, IconPause, IconPlay, IconRefresh } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Confirm from '../components/Confirm.svelte'
  import AnalysisDetails from '../components/AnalysisDetails.svelte'
  import DomainDiagnostics from '../components/DomainDiagnostics.svelte'

  type View = 'domains' | 'ips' | 'proxies'
  type Row = DomainStat | IPStat | ProxyStat
  type Sort = 'name' | 'total' | 'download' | 'upload' | 'connections'
  const PAGE_SIZE = 25
  const views = $derived<{ value: View; label: string }[]>([
    { value: 'domains', label: t('analysis.domains') },
    { value: 'ips', label: t('analysis.ips') },
    { value: 'proxies', label: t('analysis.proxies') },
  ])

  let view = $state<View>('domains')
  let query = $state('')
  let proxyFilter = $state('')
  let sort = $state<Sort>('total')
  let ascending = $state(false)
  let page = $state(1)
  let selected = $state('')
  let paused = $state(false)
  let frozen = $state.raw<AnalysisSnapshot | null>(null)
  let confirmReset = $state(false)
  let diagnosticsOpen = $state(false)
  let diagnosticDomain = $state('')
  let diagnosticRequest = $state(0)
  function diagnose(domain = '') {
    diagnosticDomain = domain
    diagnosticRequest++
    diagnosticsOpen = true
  }

  const stats = $derived(paused && frozen ? frozen : core.analysis)
  const totalTraffic = $derived(stats.totals.download + stats.totals.upload)
  const sessionTime = $derived(new Date(stats.startedAt).toLocaleTimeString(i18n.intlLocale, { hour: '2-digit', minute: '2-digit' }))
  const distribution = $derived([...stats.proxies].sort((a, b) => b.download + b.upload - a.download - a.upload))
  const sorted = $derived.by(() => {
    const q = query.trim().toLowerCase()
    let rows: Row[] = stats[view]
    if (proxyFilter && view !== 'proxies') rows = rows.filter((row) => 'proxies' in row && row.proxies.includes(proxyFilter))
    if (q) rows = rows.filter((row) => {
      const fields = [row.name, rowName(row)]
      if ('ips' in row) fields.push(...row.ips)
      if ('domains' in row) fields.push(...row.domains)
      if ('proxies' in row) fields.push(...row.proxies, ...row.proxies.map(proxyName))
      if ('countries' in row) fields.push(...row.countries, ...row.asn)
      return fields.join(' ').toLowerCase().includes(q)
    })
    return [...rows].sort((a, b) => {
      const result = sort === 'name' ? rowName(a).localeCompare(rowName(b), i18n.intlLocale, { numeric: true })
        : sort === 'total' ? a.download + a.upload - b.download - b.upload : a[sort] - b[sort]
      return (ascending ? result : -result) || rowName(a).localeCompare(rowName(b), i18n.intlLocale)
    })
  })
  const pages = $derived(Math.max(1, Math.ceil(sorted.length / PAGE_SIZE)))
  const currentPage = $derived(Math.min(page, pages))
  const rows = $derived(sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE))

  $effect(() => {
    query; view; proxyFilter
    page = 1
    selected = ''
  })

  function changeSort(key: Sort) {
    if (sort === key) ascending = !ascending
    else { sort = key; ascending = key === 'name' }
  }

  function navigate(target: View, value: string) {
    view = target
    query = value
    proxyFilter = ''
  }

  function togglePause() {
    if (!paused) frozen = core.analysis
    paused = !paused
  }

  function reset() {
    core.resetAnalysis()
    paused = false
    frozen = null
    selected = ''
    page = 1
  }

  function rowName(row: Row): string {
    return view === 'proxies' ? proxyName(row.name) : row.name
  }

  function related(row: Row) {
    if (view === 'domains' && 'ips' in row) return t('analysis.ipCount', { count: row.ips.length })
    if ('domains' in row) return t('analysis.domainCount', { count: row.domains.length })
    return ''
  }

  const percent = (value: number) => new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 1 }).format(totalTraffic ? value / totalTraffic * 100 : 0)
  const th = 'px-3 py-0 text-xs font-normal text-fg-3'
</script>

{#snippet sortHead(key: Sort, label: string, extra = '')}
  <th class="{th} {extra}" aria-sort={sort === key ? ascending ? 'ascending' : 'descending' : 'none'}>
    <button class="inline-flex min-h-11 items-center gap-1 {key === 'name' ? 'text-left' : 'whitespace-nowrap'} transition-colors hover:text-fg {sort === key ? 'text-fg' : ''}" onclick={() => changeSort(key)}>
      {label}{#if sort === key}<span aria-hidden="true">{ascending ? '↑' : '↓'}</span>{/if}
    </button>
  </th>
{/snippet}

<PageHeader title={t('analysis.title')} meta={t('analysis.meta', { time: sessionTime })}>
  {#snippet actions()}
    <Button size="sm" onclick={() => diagnose()} aria-expanded={diagnosticsOpen} aria-controls="domain-diagnostics">{t('diagnostics.open')}</Button>
    <Button size="sm" onclick={togglePause} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('analysis.resume')}{:else}<IconPause strokeWidth={1.5} />{t('analysis.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => (confirmReset = true)}><IconRefresh strokeWidth={1.5} />{t('analysis.newSession')}</Button>
  {/snippet}
</PageHeader>

{#if diagnosticsOpen}<DomainDiagnostics initialHost={diagnosticDomain} requestId={diagnosticRequest} onclose={() => diagnosticsOpen = false} />{/if}

<section class="grid grid-cols-2 overflow-hidden rounded-2xl border border-line bg-card lg:grid-cols-4" aria-label={t('analysis.sessionStats')}>
  {#each [
    { label: t('analysis.sessionTraffic'), value: bytes(totalTraffic), caption: `↓ ${bytes(stats.totals.download)} · ↑ ${bytes(stats.totals.upload)}` },
    { label: t('analysis.connections'), value: count(stats.totals.connections), caption: t('analysis.activeCount', { count: stats.totals.active }) },
    { label: t('analysis.domains'), value: count(stats.domains.length), caption: t('analysis.domainSource') },
    { label: t('analysis.destinationIPs'), value: count(stats.ips.length), caption: t('analysis.exitNodeCount', { count: stats.proxies.length }) },
  ] as metric, i (metric.label)}
    <div class="min-w-0 px-4 py-4 sm:px-5 {i % 2 ? 'border-l border-line' : ''} {i > 1 ? 'border-t border-line lg:border-l lg:border-t-0' : ''}">
      <h2 class="text-[13px] font-normal text-fg-2">{metric.label}</h2>
      <div class="num mt-3 text-[28px] font-medium leading-8">{metric.value}</div>
      <p class="num mt-3 truncate font-mono text-xs text-fg-3" title={metric.caption}>{metric.caption}</p>
    </div>
  {/each}
</section>

<div class="mt-6 flex flex-wrap items-center justify-between gap-3 border-b border-line">
  <div class="flex flex-wrap gap-x-4 gap-y-1 sm:gap-x-6" role="group" aria-label={t('analysis.viewLabel')}>
    {#each views as item (item.value)}
      <button class="flex min-h-11 items-center gap-2 border-b-2 pb-1 text-[13px] transition-colors {view === item.value ? 'border-selected-border text-selected-text' : 'border-transparent text-fg-3 hover:text-fg'}" aria-pressed={view === item.value} onclick={() => (view = item.value)}>
        {item.label}<span class="num font-mono text-xs text-fg-3">{count(stats[item.value].length)}</span>
      </button>
    {/each}
  </div>
  <span class="flex items-center gap-2 pb-2 font-mono text-xs text-fg-3"><span class="led" data-on={core.connectionsOnline && !paused}></span>{paused ? t('analysis.tablePaused') : core.connectionsOnline ? t('analysis.live') : t('analysis.offline')}</span>
</div>

{#if !core.connectionsOnline && core.connectionsReady}
  <p role="status" class="mt-3 rounded-[var(--radius-card)] border border-line bg-card px-4 py-3 text-[13px] text-fg-2">{t('analysis.streamLost')}</p>
{/if}
{#if stats.truncated}
  <p role="status" class="mt-3 rounded-[var(--radius-card)] border border-warning-border bg-warning-surface px-4 py-3 text-[13px] text-warning">{t('analysis.truncated')}</p>
{/if}

{#if view === 'proxies' && distribution.length}
  <section class="mt-4 rounded-2xl border border-line bg-card px-4 py-4 sm:px-5" aria-label={t('analysis.proxyDistribution')}>
    <div class="flex flex-wrap items-baseline justify-between gap-3"><h2 class="font-medium">{t('analysis.exitNodeTraffic')}</h2><span class="text-xs text-fg-3">{t('analysis.sessionShare')}</span></div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2">
      {#each distribution.slice(0, 8) as proxy (proxy.name)}
        {@const traffic = proxy.download + proxy.upload}
        <button class="min-w-0 rounded-md p-1 text-left transition-colors hover:bg-raised" onclick={() => { view = 'domains'; query = ''; proxyFilter = proxy.name }} aria-label={t('analysis.showProxyDomains', { name: proxyName(proxy.name) })}>
          <span class="flex items-baseline justify-between gap-3 text-[13px]"><span class="truncate">{proxyName(proxy.name)}</span><span class="num shrink-0 font-mono text-xs text-fg-2">{bytes(traffic)} <span class="text-fg-3">· {percent(traffic)}%</span></span></span>
          <span class="mt-2 block h-1 overflow-hidden rounded-full bg-raised"><span class="block h-full rounded-full bg-accent" style:width="{totalTraffic ? traffic / totalTraffic * 100 : 0}%"></span></span>
        </button>
      {/each}
    </div>
  </section>
{/if}

<div class="my-4 flex flex-wrap items-center gap-2">
  <SearchInput bind:value={() => proxyName(query), (value) => (query = value)} placeholder={view === 'domains' ? t('analysis.searchDomains') : view === 'ips' ? t('analysis.searchIPs') : t('analysis.searchProxies')} />
  {#if view !== 'proxies'}
    <label class="flex min-w-0 items-center gap-2 text-xs text-fg-3">
      <span class="sr-only">{t('analysis.exitNode')}</span>
      <select bind:value={proxyFilter} aria-label={t('analysis.exitNodeFilter')} class="h-8 max-w-[220px] rounded-[var(--radius-control)] border border-field-border bg-field px-2 text-[13px] text-fg transition-colors hover:border-fg-3 focus-visible:border-accent-ink">
        <option value="">{t('analysis.allExitNodes')}</option>
        {#each stats.proxies as proxy (proxy.name)}<option value={proxy.name}>{proxyName(proxy.name)}</option>{/each}
      </select>
    </label>
  {/if}
  {#if query || (proxyFilter && view !== 'proxies')}
    <Button size="sm" variant="ghost" onclick={() => { query = ''; proxyFilter = '' }}>{t('analysis.clearFilters')}</Button>
  {/if}
  <span class="ml-auto font-mono text-xs text-fg-3">{t('analysis.found', { count: sorted.length })}</span>
</div>

{#if proxyFilter && view !== 'proxies'}
  <p class="mb-4 text-xs leading-5 text-fg-3">{t('analysis.proxyFilterHint', { name: proxyName(proxyFilter) })}</p>
{/if}

{#if !core.connectionsReady && !stats.totals.connections}
  <div class="rounded-2xl border border-line bg-card p-5" role="status"><p class="text-[13px] text-fg-2">{t('analysis.waiting')}</p><div class="mt-4 grid gap-3" aria-hidden="true">{#each [1, 2, 3] as n (n)}<div class="h-8 rounded bg-raised"></div>{/each}</div></div>
{:else}
  <div class="overflow-hidden rounded-2xl border border-line bg-card">
    <table class="w-full table-fixed text-[13px]">
      <caption class="sr-only">{t('analysis.tableCaption', { view: views.find((item) => item.value === view)?.label ?? '' })}</caption>
      <thead><tr class="text-left">
        {@render sortHead('name', view === 'domains' ? t('analysis.domain') : view === 'ips' ? t('analysis.ip') : t('analysis.exitNode'), 'w-auto sm:w-[32%]')}
        <th class="{th} hidden w-[18%] text-left lg:table-cell">{view === 'ips' ? t('analysis.regionASN') : t('analysis.associations')}</th>
        {@render sortHead('download', t('analysis.downloaded'), 'hidden text-right xl:table-cell')}
        {@render sortHead('upload', t('analysis.uploaded'), 'hidden text-right xl:table-cell')}
        {@render sortHead('total', t('analysis.traffic'), 'w-[88px] text-right sm:w-[120px] xl:w-auto')}
        {@render sortHead('connections', t('analysis.connectionsShort'), 'w-[72px] text-right sm:w-[100px] xl:w-auto')}
        <th class="w-8 sm:w-11"><span class="sr-only">{t('analysis.details')}</span></th>
      </tr></thead>
      <tbody>
        {#each rows as row, index (row.name)}
          <tr class="border-t border-line transition-colors {selected === row.name ? 'bg-selected' : 'hover:bg-hover'}">
            <td class="min-w-0 px-3 py-3">
              <button class="max-w-full text-left {selected === row.name ? 'text-selected-text' : 'hover:text-fg'}" aria-expanded={selected === row.name} aria-controls="analysis-details-{index}" onclick={() => (selected = selected === row.name ? '' : row.name)}>
                <span class="block break-all font-mono text-xs leading-5">{rowName(row)}</span>
              </button>
              <span class="mt-0.5 block truncate text-xs text-fg-3">{related(row)}{#if view === 'ips' && 'countries' in row && row.countries.length}{' · '}{row.countries.join(', ')}{/if}</span>
            </td>
            <td class="hidden truncate px-3 py-3 text-xs text-fg-2 lg:table-cell">
              {#if view === 'ips' && 'countries' in row}
                <div class="truncate" title={row.countries.join(', ')}>{row.countries.join(', ') || t('analysis.noData')}</div>
                <div class="mt-1 truncate font-mono text-fg-3" title={row.asn.join(', ')}>{row.asn.join(', ') || t('analysis.noASN')}</div>
              {:else}
                <div>{related(row)}</div>
                <div class="mt-1 truncate text-fg-3" title={'proxies' in row ? row.proxies.map(proxyName).join(', ') : ''}>{'proxies' in row ? row.proxies.map(proxyName).join(', ') : 'ips' in row ? t('analysis.ipCount', { count: row.ips.length }) : ''}</div>
              {/if}
            </td>
            <td class="num hidden whitespace-nowrap px-3 py-3 text-right font-mono text-xs text-traffic-down-ink xl:table-cell">{bytes(row.download)}</td>
            <td class="num hidden whitespace-nowrap px-3 py-3 text-right font-mono text-xs text-traffic-up-ink xl:table-cell">{bytes(row.upload)}</td>
            <td class="num px-3 py-3 text-right font-mono text-xs"><div>{bytes(row.download + row.upload)}</div>{#if view === 'proxies'}<div class="mt-1 text-fg-3">{percent(row.download + row.upload)}%</div>{/if}</td>
            <td class="num whitespace-nowrap px-1 py-3 text-right font-mono text-xs sm:px-3"><div>{count(row.connections)}</div><div class="mt-1 text-fg-3" title={t('analysis.activeConnections')}>{t('analysis.activeShort', { count: row.active })}</div></td>
            <td class="pr-1">
              <button class="flex min-h-11 w-full items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-raised hover:text-fg" aria-label={t(selected === row.name ? 'analysis.hideDetails' : 'analysis.showDetails', { name: rowName(row) })} aria-expanded={selected === row.name} aria-controls="analysis-details-{index}" onclick={() => (selected = selected === row.name ? '' : row.name)}><IconChevron class="size-4 transition-transform {selected === row.name ? 'rotate-180' : ''}" strokeWidth={1.5} /></button>
            </td>
          </tr>
          <tr hidden={selected !== row.name} id="analysis-details-{index}"><td colspan="7" class="p-0">{#if selected === row.name}<AnalysisDetails {row} {view} onnavigate={navigate} ondiagnose={diagnose} />{/if}</td></tr>
        {:else}
          <tr class="border-t border-line"><td colspan="7" class="px-5 py-12 text-center"><p class="text-fg-2">{query || proxyFilter ? t('analysis.noResults') : view === 'domains' ? t('analysis.noDomains') : t('analysis.emptySession')}</p><p class="mx-auto mt-2 max-w-md text-xs text-fg-3">{query || proxyFilter ? t('analysis.changeFilters') : view === 'domains' ? t('analysis.noDomainsHint') : t('analysis.emptySessionHint')}</p></td></tr>
        {/each}
      </tbody>
    </table>
    {#if pages > 1}
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-3"><span class="font-mono text-xs text-fg-3">{count(currentPage)} / {count(pages)}</span><div class="flex flex-wrap gap-2"><Button size="sm" disabled={currentPage === 1} onclick={() => (page = currentPage - 1)}>{t('analysis.previous')}</Button><Button size="sm" disabled={currentPage === pages} onclick={() => (page = currentPage + 1)}>{t('analysis.next')}</Button></div></div>
    {/if}
  </div>
{/if}

<p class="mt-4 max-w-3xl text-xs leading-5 text-fg-3">{t('analysis.sessionHint')}{#if view === 'ips'}{' '}{t('analysis.geoHint')}{/if}{#if paused}{' '}{t('analysis.pauseHint')}{/if}</p>

<Confirm bind:open={confirmReset} title={t('analysis.resetTitle')} description={t('analysis.resetDescription')} action={t('analysis.resetAction')} onconfirm={reset} />
