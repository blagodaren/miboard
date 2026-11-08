<script lang="ts">
  import { onMount } from 'svelte'
  import Activity from '@lucide/svelte/icons/activity'
  import Globe from '@lucide/svelte/icons/globe'
  import Network from '@lucide/svelte/icons/network'
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import { api } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { bytes, speed, count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import { proxyName } from '../lib/analysis-display'
  import { countryName } from '../lib/geography'
  import { loadGeoDatabase, type GeoDatabase } from '../lib/geo-db'
  import { overviewRegions } from '../lib/overview'
  import PageHeader from '../components/PageHeader.svelte'
  import TrafficChart from '../components/TrafficChart.svelte'
  import OverviewRanking from '../components/OverviewRanking.svelte'

  let range = $state(1800)
  let rules = $state<number | null>(null)
  let rulesError = $state(false)
  let rulesLoading = $state(false)
  let database = $state.raw<GeoDatabase | null>(null)
  let databaseError = $state(false)
  let mounted = false
  let rulesRequest = 0

  const ranges = $derived([
    { value: 1800, label: t('overview.range30m') },
    { value: 3600, label: t('overview.range1h') },
    { value: 86400, label: t('overview.range24h') },
  ])
  const modeLabel = $derived({ rule: t('overview.modeRule'), global: t('overview.modeGlobal'), direct: t('overview.modeDirect') })
  const history = $derived.by(() => {
    void core.tick
    return core.trafficHistory.snapshot(range)
  })
  const observedSince = $derived(history.startedAt === null ? '—' : new Date(history.startedAt * 1000).toLocaleTimeString(i18n.intlLocale, { hour: '2-digit', minute: '2-digit' }))
  const sessionSince = $derived(new Date(core.analysis.startedAt).toLocaleTimeString(i18n.intlLocale, { hour: '2-digit', minute: '2-digit' }))
  const domains = $derived(core.analysis.domains.map((row) => ({ ...row, id: row.name })))
  const proxies = $derived(core.analysis.proxies.map((row) => ({ ...row, id: row.name, name: proxyName(row.name) })))
  const regions = $derived(overviewRegions(core.analysis, database ? (ip) => database!.lookup(ip) : undefined).map((row) => ({
    ...row,
    id: row.name,
    name: row.name === 'unknown' ? t('geography.unknown') : countryName(row.name, i18n.intlLocale),
    flag: row.name === 'unknown' ? '' : String.fromCodePoint(...[...row.name].map((letter) => 127397 + letter.charCodeAt(0))),
  })))
  const stats = $derived([
    { id: 'download', label: t('overview.totalDownload'), value: bytes(core.downTotal), caption: speed(core.down) },
    { id: 'upload', label: t('overview.totalUpload'), value: bytes(core.upTotal), caption: speed(core.up) },
    { id: 'traffic', label: t('overview.totalTraffic'), value: bytes(core.downTotal + core.upTotal), caption: t('overview.coreCounters') },
    { id: 'connections', label: t('overview.connections'), value: count(core.analysis.totals.connections), caption: t('overview.activeCount', { count: core.conns.length }) },
    { id: 'domains', label: t('overview.domains'), value: count(core.analysis.domains.length), caption: t('overview.thisSession') },
    { id: 'rules', label: t('overview.rules'), value: rules === null ? '—' : count(rules), caption: rulesError ? t('overview.rulesError') : t('overview.inConfig') },
  ])

  async function refreshRules() {
    const request = ++rulesRequest
    rulesLoading = true
    rulesError = false
    try {
      const result = await api.rules()
      if (mounted && request === rulesRequest) rules = result.rules.length
    } catch {
      if (mounted && request === rulesRequest) { rules = null; rulesError = true }
    } finally {
      if (mounted && request === rulesRequest) rulesLoading = false
    }
  }

  async function loadDatabase() {
    databaseError = false
    try {
      const result = await loadGeoDatabase()
      if (mounted) database = result
    } catch {
      if (mounted) databaseError = true
    }
  }

  onMount(() => {
    mounted = true
    void loadDatabase()
    return () => { mounted = false; rulesRequest++ }
  })

  $effect(() => {
    void core.backend.url
    void core.backend.secret
    rules = null
    void refreshRules()
  })
</script>

<div class="overview">
  <PageHeader
    title={t('overview.title')}
    meta={core.configs ? t('overview.meta', { mode: modeLabel[core.configs.mode], host: core.backend.url.replace(/^https?:\/\//, '') }) : undefined}
  >
    {#snippet actions()}
      <span class="live-state" data-online={core.connectionsOnline}>
        <span class="led" data-on={core.connectionsOnline} data-state={!core.connectionsOnline ? 'down' : undefined} aria-hidden="true"></span>
        {core.connectionsOnline ? t('overview.live') : t('status.disconnected')}
      </span>
    {/snippet}
  </PageHeader>

  <section class="summary-grid" aria-label={t('overview.summary')}>
    {#each stats as stat (stat.id)}
      <div class="summary-card" data-testid="overview-stat" data-stat={stat.id}>
        <dl>
          <dt>{stat.label}</dt>
          <dd class="num">{stat.value}</dd>
        </dl>
        {#if stat.id === 'rules' && rulesError}
          <button class="stat-caption retry" onclick={refreshRules} disabled={rulesLoading}>{t('overview.retryRules')}</button>
        {:else}
          <p class="stat-caption num">{stat.caption}</p>
        {/if}
      </div>
    {/each}
  </section>

  <section class="trend-card" aria-labelledby="traffic-title">
    <div class="trend-heading">
      <h2 id="traffic-title"><Activity size={18} strokeWidth={1.5} aria-hidden="true" />{t('overview.trafficTrend')}</h2>
      <div class="range-control" role="group" aria-label={t('overview.chartRange')}>
        {#each ranges as option (option.value)}
          <button aria-pressed={range === option.value} onclick={() => { range = option.value }}>{option.label}</button>
        {/each}
      </div>
    </div>
    <div class="trend-details">
      <div class="traffic-legend">
        <span class="legend-item"><ArrowDown size={14} /><span>{t('overview.download')}</span><strong class="num traffic-down">{bytes(history.download)}</strong></span>
        <span class="legend-item"><ArrowUp size={14} /><span>{t('overview.upload')}</span><strong class="num traffic-up">{bytes(history.upload)}</strong></span>
      </div>
      <span class="trend-total">{t('overview.chartTotal')} <strong class="num">{bytes(history.download + history.upload)}</strong></span>
    </div>
    <div class="chart-container"><TrafficChart height={260} {range} /></div>
    <div class="trend-footnote">
      <span>{t('overview.observedSince', { time: observedSince })}</span>
      <span class="current-speed num"><ArrowDown size={12} />{speed(core.down)}<ArrowUp size={12} />{speed(core.up)}</span>
    </div>
  </section>

  <div class="rankings-meta">
    <span>{t('overview.sessionSince', { time: sessionSince })}</span>
    {#if core.analysis.truncated}<a href="#/analysis">{t('overview.limitedStats')}</a>{/if}
  </div>
  <div class="rankings-grid">
    <OverviewRanking title={t('overview.topDomains')} icon={Globe} rows={domains} href="#/analysis" bars={false} />
    <OverviewRanking title={t('overview.topProxies')} icon={Network} rows={proxies} href="#/proxies" />
    <OverviewRanking title={t('overview.topRegions')} icon={Globe} rows={regions} href="#/geography" />
  </div>
  {#if databaseError}
    <p class="geo-note">{t('overview.geoUnavailable')} <button onclick={loadDatabase}>{t('overview.retry')}</button></p>
  {/if}
</div>

<style>
  .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
  .summary-card { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  dt { color: var(--text-2); font-size: 12px; font-weight: 400; line-height: 20px; }
  dd { margin-top: 8px; white-space: nowrap; font-size: 24px; line-height: 32px; font-weight: 500; }
  .stat-caption { margin-top: 8px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .retry { text-align: left; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .retry:hover { color: var(--text); }
  .live-state { display: inline-flex; align-items: center; gap: 8px; min-height: 24px; color: var(--text-3); font-size: 12px; }
  .trend-card { margin-top: 24px; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .trend-heading, .trend-details { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 14px; line-height: 20px; font-weight: 500; }
  .range-control { display: flex; flex-shrink: 0; gap: 2px; padding: 2px; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--raised); }
  .range-control button { min-height: 32px; padding: 0 12px; border: 1px solid transparent; border-radius: 8px; color: var(--text-2); font-size: 12px; cursor: pointer; transition: color 150ms, background 150ms, border-color 150ms; }
  .range-control button:hover { color: var(--text); background: var(--hover); }
  .range-control button:active { transform: translateY(1px); }
  .range-control button[aria-pressed='true'] { border-color: var(--selected-border); background: var(--selected); color: var(--selected-text); }
  .trend-details { margin-top: 16px; color: var(--text-3); font-size: 12px; }
  .traffic-legend { display: flex; flex-wrap: wrap; gap: 16px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item strong { font-weight: 500; }
  .traffic-down { color: var(--traffic-down-ink); }
  .traffic-up { color: var(--traffic-up-ink); }
  .trend-total { white-space: nowrap; }
  .trend-total strong { margin-left: 4px; color: var(--text); font-weight: 500; }
  .chart-container { margin: 24px 0 0; min-width: 0; }
  .trend-footnote { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; color: var(--text-3); font-size: 12px; }
  .current-speed { display: flex; align-items: center; gap: 4px; }
  .current-speed :global(svg:nth-of-type(2)) { margin-left: 8px; }
  .rankings-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 24px 0 12px; color: var(--text-3); font-size: 12px; }
  .rankings-meta a { text-decoration: underline; text-underline-offset: 3px; }
  .rankings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
  .geo-note { margin-top: 12px; color: var(--text-3); font-size: 12px; }
  .geo-note button { text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  @media (max-width: 1279px) {
    .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .rankings-grid { gap: 16px; }
  }
  @media (min-width: 768px) and (max-width: 1099px) { .rankings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 767px) {
    .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .summary-card { padding: 16px; border-radius: var(--radius-card); }
    dd { font-size: 20px; line-height: 28px; }
    .stat-caption { font-size: 12px; line-height: 20px; }
    .trend-card { margin-top: 24px; padding: 16px; }
    .trend-heading, .trend-details { align-items: flex-start; flex-wrap: wrap; }
    .trend-heading { gap: 16px; }
    .range-control { width: 100%; }
    .range-control button { flex: 1; min-height: 44px; }
    .traffic-legend { gap: 8px 16px; }
    .chart-container { margin-top: 16px; }
    .rankings-grid { grid-template-columns: 1fr; gap: 24px; }
    .rankings-meta { margin-top: 20px; }
    .current-speed { display: none; }
  }
  @media (max-width: 359px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (prefers-reduced-motion: reduce) { .range-control button { transition: none; } }
</style>
