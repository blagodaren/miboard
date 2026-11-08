<script lang="ts">
  import { onMount } from 'svelte'
  import Activity from '@lucide/svelte/icons/activity'
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line'
  import ArrowUpFromLine from '@lucide/svelte/icons/arrow-up-from-line'
  import Globe from '@lucide/svelte/icons/globe'
  import ListFilter from '@lucide/svelte/icons/list-filter'
  import Network from '@lucide/svelte/icons/network'
  import Server from '@lucide/svelte/icons/server'
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
    { id: 'download', icon: ArrowDownToLine, label: t('overview.totalDownload'), value: bytes(core.downTotal), caption: speed(core.down), tone: 'down' },
    { id: 'upload', icon: ArrowUpFromLine, label: t('overview.totalUpload'), value: bytes(core.upTotal), caption: speed(core.up), tone: 'up' },
    { id: 'traffic', icon: Server, label: t('overview.totalTraffic'), value: bytes(core.downTotal + core.upTotal), caption: t('overview.coreCounters'), tone: 'traffic' },
    { id: 'connections', icon: Activity, label: t('overview.connections'), value: count(core.analysis.totals.connections), caption: t('overview.activeCount', { count: core.conns.length }), tone: 'connections' },
    { id: 'domains', icon: Globe, label: t('overview.domains'), value: count(core.analysis.domains.length), caption: t('overview.thisSession'), tone: 'domains' },
    { id: 'rules', icon: ListFilter, label: t('overview.rules'), value: rules === null ? '—' : count(rules), caption: rulesError ? t('overview.rulesError') : t('overview.inConfig'), tone: 'rules' },
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
        <span class="live-dot"></span>
        {core.connectionsOnline ? t('overview.live') : t('status.disconnected')}
      </span>
    {/snippet}
  </PageHeader>

  <section class="summary-grid" aria-label={t('overview.summary')}>
    {#each stats as stat (stat.id)}
      <div class="summary-card" data-testid="overview-stat" data-stat={stat.id}>
        <span class="stat-icon" data-tone={stat.tone}><stat.icon size={18} strokeWidth={1.7} /></span>
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
      <h2 id="traffic-title"><Activity size={18} strokeWidth={1.7} />{t('overview.trafficTrend')}</h2>
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
  .overview {
    --traffic-down: light-dark(#4c61d4, #8c9cff);
    --traffic-up: light-dark(#8a4cce, #bf96f4);
    --traffic-down-line: light-dark(#5c73f0, #8c9cff);
    --traffic-up-line: light-dark(#a264e7, #bf96f4);
  }
  .summary-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
  .summary-card { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); box-shadow: var(--shadow-panel); }
  .stat-icon { display: flex; align-items: center; justify-content: center; width: 33px; height: 33px; border-radius: 10px; color: var(--traffic-down); background: color-mix(in srgb, currentColor 8%, var(--card)); }
  .stat-icon[data-tone='up'] { color: var(--traffic-up); }
  .stat-icon[data-tone='traffic'] { color: light-dark(#c43b80, #f28bb7); }
  .stat-icon[data-tone='connections'] { color: var(--good); }
  .stat-icon[data-tone='domains'] { color: light-dark(#147d9b, #66c9e6); }
  .stat-icon[data-tone='rules'] { color: var(--accent-ink); }
  dt { margin-top: 13px; color: var(--text-3); font-size: 11px; font-weight: 500; line-height: 16px; letter-spacing: .075em; text-transform: uppercase; }
  dd { margin-top: 5px; white-space: nowrap; font-size: 24px; line-height: 30px; font-weight: 600; letter-spacing: -.035em; }
  .stat-caption { margin-top: 5px; color: var(--text-3); font-size: 11px; line-height: 17px; }
  .retry { text-align: left; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  .retry:hover { color: var(--text); }
  .live-state { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border: 1px solid var(--line); border-radius: 7px; color: var(--text-3); font-size: 12px; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }
  .live-state[data-online='true'] .live-dot { background: var(--good); }
  .trend-card { margin-top: 22px; padding: 20px 22px 14px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); box-shadow: var(--shadow-panel); }
  .trend-heading, .trend-details { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { display: flex; align-items: center; gap: 9px; color: var(--text-2); font-size: 12px; line-height: 20px; font-weight: 600; letter-spacing: .065em; text-transform: uppercase; }
  .range-control { display: flex; flex-shrink: 0; gap: 2px; padding: 3px; border-radius: 10px; background: var(--raised); }
  .range-control button { min-height: 31px; padding: 0 13px; border: 1px solid transparent; border-radius: 8px; color: var(--text-3); font-size: 12px; cursor: pointer; transition: color 150ms, background 150ms, border-color 150ms; }
  .range-control button:hover { color: var(--text); background: var(--hover); }
  .range-control button:active { transform: translateY(1px); }
  .range-control button[aria-pressed='true'] { border-color: var(--line); background: var(--card); color: var(--traffic-down); box-shadow: var(--shadow-panel); }
  .trend-details { margin-top: 16px; color: var(--text-3); font-size: 12px; }
  .traffic-legend { display: flex; flex-wrap: wrap; gap: 18px; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-item strong { font-weight: 600; }
  .traffic-down { color: var(--traffic-down); }
  .traffic-up { color: var(--traffic-up); }
  .trend-total { white-space: nowrap; }
  .trend-total strong { margin-left: 4px; color: var(--text); font-weight: 600; }
  .chart-container { margin: 22px -4px 0 -12px; min-width: 0; }
  .trend-footnote { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; color: var(--text-3); font-size: 11px; }
  .current-speed { display: flex; align-items: center; gap: 5px; }
  .current-speed :global(svg:nth-of-type(2)) { margin-left: 8px; }
  .rankings-meta { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 23px 0 10px; color: var(--text-3); font-size: 11px; }
  .rankings-meta a { text-decoration: underline; text-underline-offset: 3px; }
  .rankings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px; }
  .geo-note { margin-top: 12px; color: var(--text-3); font-size: 12px; }
  .geo-note button { text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
  @media (max-width: 1279px) {
    .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .rankings-grid { gap: 14px; }
  }
  @media (min-width: 768px) and (max-width: 1099px) { .rankings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 767px) {
    .summary-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .summary-card { padding: 13px 11px 11px; border-radius: 12px; }
    dt { font-size: 9px; line-height: 14px; letter-spacing: .025em; }
    dd { font-size: 20px; line-height: 25px; }
    .stat-caption { font-size: 10px; line-height: 14px; }
    .trend-card { margin-top: 16px; padding: 16px 14px 12px; }
    .trend-heading, .trend-details { align-items: flex-start; flex-wrap: wrap; }
    .trend-heading { gap: 14px; }
    .range-control { width: 100%; }
    .range-control button { flex: 1; min-height: 38px; }
    .traffic-legend { gap: 8px 14px; }
    .chart-container { margin-top: 14px; }
    .rankings-grid { grid-template-columns: 1fr; gap: 22px; }
    .rankings-meta { margin-top: 20px; }
    .current-speed { display: none; }
  }
  @media (max-width: 359px) { .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (prefers-reduced-motion: reduce) { .range-control button { transition: none; } }
</style>
