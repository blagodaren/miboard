<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Connection } from '../lib/api'
  import { core, type ConnRow } from '../lib/core.svelte'
  import { countryName, destinationCountry, summarizeGeography } from '../lib/geography'
  import { loadGeoDatabase, type GeoDatabase } from '../lib/geo-db'
  import { GeoResolver } from '../lib/geo-resolver'
  import { bytes, count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import { IconClose, IconPause, IconPlay } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Button from '../components/Button.svelte'
  import GeographyMap from '../components/GeographyMap.svelte'
  import RegionDetails from '../components/RegionDetails.svelte'

  type Metric = 'connections' | 'traffic'
  type Location = { code: string | null; source: 'metadata' | 'ip' | 'dns' | 'unknown' }
  const UNKNOWN = 'unknown'
  const options: { value: Metric; label: string }[] = $derived([
    { value: 'connections', label: t('geography.connections') },
    { value: 'traffic', label: t('geography.traffic') },
  ])

  let metric = $state<Metric>('connections')
  let regionMetric = $state<Metric>('traffic')
  let selected = $state<string | null>(null)
  let paused = $state(false)
  let frozen = $state.raw<ConnRow[]>([])
  let frozenLocations = $state.raw<Map<string, Location>>(new Map())
  let database = $state.raw<GeoDatabase | null>(null)
  let databaseLoading = $state(true)
  let databaseError = $state(false)
  let resolver = $state.raw<GeoResolver | null>(null)
  let revision = $state(0)
  let mounted = false

  async function loadDatabase() {
    databaseLoading = true
    databaseError = false
    try {
      const loaded = await loadGeoDatabase()
      if (mounted) database = loaded
    } catch {
      if (mounted) databaseError = true
    } finally {
      if (mounted) databaseLoading = false
    }
  }

  onMount(() => {
    mounted = true
    void loadDatabase()
    return () => { mounted = false }
  })

  $effect(() => {
    if (!database || !core.backend.url) return
    // Bind DNS requests and their cache to this controller, including its credentials.
    const backend = { url: core.backend.url, secret: core.backend.secret }
    const current = new GeoResolver(
      (ip) => database!.lookup(ip),
      (name, type) => api.dnsQuery(name, type, backend),
      () => { revision++ },
    )
    resolver = current
    return () => {
      current.dispose()
      if (resolver === current) resolver = null
    }
  })

  $effect(() => {
    resolver?.update(!paused && core.connectionsOnline ? core.conns : [])
  })

  function location(connection: Connection): Location {
    const code = destinationCountry(connection)
    if (code) return { code, source: 'metadata' }
    const resolved = resolver?.locate(connection)
    return resolved ? { code: resolved.country, source: resolved.source } : { code: null, source: 'unknown' }
  }

  const source = $derived(paused ? frozen : core.conns)
  const locations = $derived.by(() => {
    revision
    return paused ? frozenLocations : new Map(source.map((connection) => [connection.id, location(connection)]))
  })
  const summary = $derived(summarizeGeography(source, (connection) => locations.get(connection.id)?.code ?? null))
  const pending = $derived.by(() => { revision; return paused ? 0 : resolver?.pending ?? 0 })
  const sourceCounts = $derived.by(() => {
    const result = { metadata: 0, ip: 0, dns: 0 }
    for (const value of locations.values()) if (value.source !== 'unknown') result[value.source]++
    return result
  })
  const formatValue = $derived(metric === 'connections' ? count : bytes)
  const countries = $derived(summary.countries.map((country) => ({
    ...country,
    name: countryName(country.code, i18n.intlLocale),
    value: metric === 'connections' ? country.count : country.download + country.upload,
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, i18n.intlLocale)))
  const max = $derived(Math.max(1, ...countries.map((country) => country.value)))
  const locatedValue = $derived(countries.reduce((sum, country) => sum + country.value, 0))
  const selectionName = $derived(selected === UNKNOWN ? t('geography.unknown') : selected ? countryName(selected, i18n.intlLocale) : t('geography.allDestinations'))

  // Выбор сохраняется при кратком исчезновении страны из текущего снимка.
  const hosts = $derived.by(() => {
    const grouped = new Map<string, { host: string; count: number; total: number; dns: number }>()
    for (const connection of source) {
      const resolved = locations.get(connection.id)
      const code = resolved?.code ?? null
      if (selected === UNKNOWN ? code !== null : selected && code !== selected) continue
      const host = connection.metadata.host || connection.metadata.sniffHost || connection.metadata.destinationIP || t('geography.unknownHost')
      const row = grouped.get(host) ?? { host, count: 0, total: 0, dns: 0 }
      row.count++
      if (resolved?.source === 'dns') row.dns++
      row.total += connection.download + connection.upload
      grouped.set(host, row)
    }
    return [...grouped.values()].sort((a, b) =>
      (metric === 'connections' ? b.count - a.count : b.total - a.total) || a.host.localeCompare(b.host),
    )
  })

  function select(code: string | null) {
    selected = selected === code ? null : code
  }

  function togglePause() {
    if (!paused) {
      frozen = core.conns
      frozenLocations = new Map(locations)
    }
    paused = !paused
  }
</script>

<PageHeader title={t('geography.title')} meta={t('geography.meta')}>
  {#snippet actions()}
    <Segmented label={t('geography.metric')} value={metric} {options} onchange={(value) => (metric = value)} />
    <Button size="sm" onclick={togglePause} aria-pressed={paused} disabled={!core.connectionsReady}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('geography.resume')}{:else}<IconPause strokeWidth={1.5} />{t('geography.pause')}{/if}
    </Button>
  {/snippet}
</PageHeader>

<div class="geo-stats">
  <div>
    <p class="text-xs text-fg-3">{t('geography.countries')}</p>
    <p class="stat-value">{core.connectionsReady ? count(countries.length) : '—'}</p>
  </div>
  <div>
    <p class="text-xs text-fg-3">{t('geography.located')}</p>
    <p class="stat-value">{core.connectionsReady ? count(summary.located) : '—'}<span class="ml-2 text-xs text-fg-3">{t('geography.ofTotal', { total: summary.total })}</span></p>
  </div>
  <div>
    <button
      class="unknown-stat"
      class:chosen={selected === UNKNOWN}
      disabled={!summary.unknown}
      aria-pressed={selected === UNKNOWN}
      aria-label={t('geography.showUnknown', { count: summary.unknown })}
      onclick={() => select(UNKNOWN)}
    >
      <span class="text-xs text-fg-3">{t('geography.unknown')}</span>
      <span class="stat-value">{core.connectionsReady ? count(summary.unknown) : '—'}</span>
    </button>
  </div>
  <div>
    <p class="text-xs text-fg-3">{t('geography.connectionVolume')}</p>
    <p class="stat-value">{core.connectionsReady ? bytes(summary.download + summary.upload) : '—'}</p>
  </div>
</div>

{#if databaseError}
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 text-[13px] text-fg-2" data-testid="geo-db-error" role="status">
    <span>{t('geography.databaseError')}</span>
    <Button size="sm" onclick={loadDatabase}>{t('geography.retry')}</Button>
  </div>
{/if}

{#if !core.connectionsOnline && core.connectionsReady && !paused}
  <p class="mb-4 rounded-lg border border-line px-4 py-3 text-[13px] text-fg-2" role="status">
    {t('geography.streamLost')}
  </p>
{/if}

<div class="geo-layout">
  <section class="map-panel" aria-label={t('geography.mapLabel')}>
    <div class="panel-heading">
      <h2 class="text-sm font-medium">{t('geography.mapTitle')}</h2>
      <span class="flex items-center gap-2 text-xs text-fg-3" role="status">
        <span class="led" data-on={!paused && core.connectionsOnline} data-state={!core.connectionsOnline && !paused ? 'down' : undefined}></span>
        {paused ? t('geography.pause') : !core.connectionsReady ? t('geography.waiting') : core.connectionsOnline ? t('geography.live') : t('geography.offline')}
      </span>
    </div>
    <GeographyMap
      {countries}
      selected={selected === UNKNOWN ? null : selected}
      onselect={select}
      metricLabel={metric === 'connections' ? t('geography.connections') : t('geography.traffic')}
      {formatValue}
    />
    {#if !core.connectionsReady}
      <p class="map-message" role="status">{t('geography.loading')}</p>
    {:else if !summary.total}
      <p class="map-message">{t('geography.empty')}</p>
    {:else if databaseLoading && !summary.located}
      <p class="map-message" role="status">{t('geography.databaseLoading')}</p>
    {:else if pending && !summary.located}
      <p class="map-message" role="status">{t('geography.dnsLoading', { count: pending })}</p>
    {:else if !summary.located}
      <p class="map-message">{t('geography.noGeodata')}</p>
    {/if}
  </section>

  <section class="country-panel" aria-labelledby="countries-title">
    <div class="panel-heading">
      <h2 id="countries-title" class="text-sm font-medium">{t('geography.countries')}</h2>
      <span class="text-xs text-fg-3">{metric === 'connections' ? t('geography.connections') : t('geography.traffic')}</span>
    </div>
    <div class="country-list">
      {#each countries as country (country.code)}
        <button class="country-row" class:chosen={selected === country.code} aria-pressed={selected === country.code} onclick={() => select(country.code)}>
          <span class="country-code">{country.code}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline justify-between gap-3">
              <span class="truncate" title={country.name}>{country.name}</span>
              <span class="num shrink-0 font-mono text-xs">{formatValue(country.value)}</span>
            </span>
            <span class="country-bar"><span style:transform="scaleX({country.value / max})"></span></span>
          </span>
        </button>
      {:else}
        <p class="px-4 py-8 text-[13px] text-fg-3">{core.connectionsReady ? t('geography.noCountries') : t('geography.firstSnapshot')}</p>
      {/each}
    </div>
    <div class="country-footer">
      <span>{t('geography.mapTotal')}</span>
      <span class="num font-mono">{formatValue(locatedValue)}</span>
    </div>
  </section>
</div>

<div
  class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-3"
  data-testid="geo-sources"
  data-pending={pending}
  data-metadata={sourceCounts.metadata}
  data-ip={sourceCounts.ip}
  data-dns={sourceCounts.dns}
>
  <span>{t('geography.sourceMetadata', { count: sourceCounts.metadata })}</span>
  <span>{t('geography.sourceIp', { count: sourceCounts.ip })}</span>
  <span>{t('geography.sourceDns', { count: sourceCounts.dns })}</span>
  {#if pending}<span role="status">{t('geography.dnsLoading', { count: pending })}</span>{/if}
  <a href="https://db-ip.com" target="_blank" rel="noreferrer" class="underline decoration-line-strong underline-offset-4 hover:text-fg">IP Geolocation by DB-IP</a>
</div>
{#if sourceCounts.dns}
  <p class="mt-2 max-w-[90ch] text-xs leading-5 text-fg-3">{t('geography.dnsHint')}</p>
{/if}

{#if summary.unknown}
  <p class="mt-4 max-w-[80ch] text-xs leading-5 text-fg-3">
    {t('geography.unknownHint', { count: summary.unknown })}
  </p>
{/if}

<div class="mt-6">
  <RegionDetails
    countries={countries}
    selected={selected === UNKNOWN ? null : selected}
    onselect={select}
    metric={regionMetric}
    onmetricchange={(value) => (regionMetric = value)}
    loading={!core.connectionsReady || (!summary.located && summary.total > 0 && (databaseLoading || pending > 0))}
  />
</div>

<section class="mt-6 overflow-hidden rounded-2xl border border-line bg-card" aria-labelledby="hosts-title">
  <div class="panel-heading">
    <div class="flex min-w-0 items-baseline gap-3">
      <h2 id="hosts-title" class="truncate text-sm font-medium">{selectionName}</h2>
      <span class="shrink-0 text-xs text-fg-3">{t('geography.hostCount', { count: hosts.length })}</span>
    </div>
    {#if selected}
      <button class="clear-selection" onclick={() => (selected = null)} aria-label={t('geography.clearSelection')}>
        <IconClose class="size-4" strokeWidth={1.5} /><span class="hidden sm:inline">{t('geography.clear')}</span>
      </button>
    {/if}
  </div>
  <table class="w-full table-fixed text-[13px]">
    <thead>
      <tr class="text-xs text-fg-3">
        <th class="px-4 py-2 text-left font-normal">{t('geography.host')}</th>
        <th class="w-[76px] px-2 py-2 text-right font-normal sm:w-[120px]"><span class="sm:hidden">{t('geography.connectionsShort')}</span><span class="hidden sm:inline">{t('geography.connections')}</span></th>
        <th class="w-[100px] px-4 py-2 text-right font-normal sm:w-[150px]">{t('geography.traffic')}</th>
      </tr>
    </thead>
    <tbody>
      {#each hosts.slice(0, 8) as host (host.host)}
        <tr class="border-t border-line">
          <td class="px-4 py-3">
            <div class="truncate" title={host.host}>{host.host}</div>
            {#if host.dns}<div class="mt-0.5 text-xs text-fg-3">{t('geography.hostDns', { count: host.dns })}</div>{/if}
          </td>
          <td class="num px-2 py-3 text-right font-mono text-xs text-fg-2">{count(host.count)}</td>
          <td class="num whitespace-nowrap px-4 py-3 text-right font-mono text-xs text-fg-2">{bytes(host.total)}</td>
        </tr>
      {:else}
        <tr class="border-t border-line"><td colspan="3" class="px-4 py-8 text-center text-fg-3">{core.connectionsReady ? t('geography.noSelectedConnections') : t('geography.waiting')}</td></tr>
      {/each}
    </tbody>
  </table>
  {#if hosts.length > 8}
    <p class="border-t border-line px-4 py-3 text-xs text-fg-3">{metric === 'connections' ? t('geography.hostLimitConnections') : t('geography.hostLimitTraffic')}</p>
  {/if}
</section>

<style>
  .geo-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px; margin-bottom: 24px; padding: 0 0 24px; border-bottom: 1px solid var(--line); }
  .stat-value { display: block; margin-top: 8px; font-family: var(--font-mono); font-size: 24px; line-height: 32px; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
  .unknown-stat { display: block; text-align: left; border-radius: 6px; cursor: pointer; }
  .unknown-stat:not(:disabled):hover .stat-value, .unknown-stat.chosen .stat-value { color: var(--accent-ink); }
  .unknown-stat:disabled { cursor: default; }
  .geo-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; align-items: stretch; gap: 16px; }
  .map-panel, .country-panel { overflow: hidden; min-width: 0; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  .map-panel { display: flex; flex-direction: column; }
  .panel-heading { display: flex; min-height: 56px; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .country-panel { display: flex; flex-direction: column; }
  .country-list { flex: 1; min-height: 280px; max-height: 390px; overflow-y: auto; padding: 8px; }
  .country-row { display: flex; width: 100%; min-height: 54px; align-items: center; gap: 12px; border-radius: 8px; padding: 10px 8px; text-align: left; cursor: pointer; transition: background-color 150ms, color 150ms; }
  .country-row:hover { background: var(--raised); }
  .country-row.chosen { background: var(--selected); color: var(--selected-text); box-shadow: inset 3px 0 var(--selected-border); }
  .country-row:active { transform: scale(0.99); }
  .country-code { width: 28px; flex: none; color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }
  .country-bar { display: block; overflow: hidden; height: 2px; margin-top: 8px; background: var(--line); border-radius: 1px; }
  .country-bar > span { display: block; height: 100%; background: var(--accent); transform-origin: left; }
  .country-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 12px 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--text-3); }
  .map-message { margin: auto 16px 16px; padding: 12px 0 0; font-size: 12px; line-height: 20px; color: var(--text-3); }
  .clear-selection { display: inline-flex; min-width: 44px; min-height: 40px; align-items: center; justify-content: center; gap: 6px; padding: 0 8px; border-radius: 6px; color: var(--text-2); font-size: 12px; cursor: pointer; }
  .clear-selection:hover { background: var(--raised); color: var(--text); }
  @media (max-width: 1199px) { .geo-layout { grid-template-columns: minmax(0, 1fr); } .country-list { min-height: 0; max-height: 280px; } }
  @media (max-width: 639px) { .geo-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 16px; } .stat-value { font-size: 22px; } }
  @media (prefers-reduced-motion: reduce) { .country-row { transition: none; } }
</style>
