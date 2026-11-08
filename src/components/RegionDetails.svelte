<script lang="ts">
  import { countryName, type CountryTraffic } from '../lib/geography'
  import { bytes, count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import { IconOverview, IconConnections, IconArrowRight } from '../lib/icons'

  type Metric = 'traffic' | 'connections'
  type Props = {
    countries: CountryTraffic[]
    selected: string | null
    onselect: (code: string | null) => void
    metric: Metric
    onmetricchange: (metric: Metric) => void
    loading?: boolean
  }

  let { countries, selected, onselect, metric, onmetricchange, loading = false }: Props = $props()
  let expanded = $state(false)
  const headingId = $props.id()
  const INITIAL_COUNT = 6

  const percent = $derived(new Intl.NumberFormat(i18n.intlLocale, {
    style: 'percent', maximumFractionDigits: 1,
  }))
  const ranked = $derived(countries.map((country) => ({
    ...country,
    name: countryName(country.code, i18n.intlLocale),
    total: country.download + country.upload,
    value: metric === 'traffic' ? country.download + country.upload : country.count,
  })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, i18n.intlLocale)))
  const denominator = $derived(ranked.reduce((sum, country) => sum + country.value, 0))
  const cards = $derived.by(() => {
    const all = ranked.map((country) => ({
      ...country,
      share: denominator > 0 ? country.value / denominator : 0,
    }))
    if (expanded || all.length <= INITIAL_COUNT) return all
    const visible = all.slice(0, INITIAL_COUNT)
    const chosen = all.find((country) => country.code === selected)
    // Keep the current selection visible without adding a row to the collapsed panel.
    if (chosen && !visible.some((country) => country.code === selected)) visible[INITIAL_COUNT - 1] = chosen
    return visible
  })

  function flag(code: string): string {
    return /^[A-Z]{2}$/.test(code)
      ? String.fromCodePoint(...[...code].map((letter) => letter.charCodeAt(0) + 127397))
      : code
  }
</script>

<section class="regions-panel" aria-labelledby={headingId} aria-busy={loading} data-testid="region-details" data-metric={metric}>
  <header class="regions-heading">
    <div class="min-w-0">
      <h2 id={headingId}>{t('geography.regionDetails')}</h2>
      <p class="share-hint">{t('geography.regionShareHint')}</p>
    </div>
    <div class="metric-switch" role="group" aria-label={t('geography.regionDetails')}>
      <button
        type="button"
        data-testid="region-metric-traffic"
        aria-label={t('geography.rankByTraffic')}
        title={t('geography.rankByTraffic')}
        aria-pressed={metric === 'traffic'}
        onclick={() => onmetricchange('traffic')}
      ><IconOverview aria-hidden="true" strokeWidth={1.5} /></button>
      <button
        type="button"
        data-testid="region-metric-connections"
        aria-label={t('geography.rankByConnections')}
        title={t('geography.rankByConnections')}
        aria-pressed={metric === 'connections'}
        onclick={() => onmetricchange('connections')}
      ><IconConnections aria-hidden="true" strokeWidth={1.5} /></button>
    </div>
  </header>

  {#if loading && !countries.length}
    <p class="sr-only" role="status">{t('geography.regionLoading')}</p>
    <div class="region-grid" aria-hidden="true">
      {#each Array(INITIAL_COUNT) as _, index (index)}
        <div class="region-skeleton">
          <span class="skeleton-name"></span>
          <span class="skeleton-value"></span>
          <span class="skeleton-bar"></span>
          <span class="skeleton-detail"></span>
          <span class="skeleton-detail short"></span>
        </div>
      {/each}
    </div>
  {:else if !countries.length}
    <p class="regions-empty" role="status">{t('geography.regionNoData')}</p>
  {:else}
    <div class="region-grid">
      {#each cards as country (country.code)}
        <button
          type="button"
          class="region-card"
          class:chosen={selected === country.code}
          aria-pressed={selected === country.code}
          aria-label="{country.name}. {metric === 'traffic' ? t('geography.totalTraffic') : t('geography.connections')}: {metric === 'traffic' ? bytes(country.total) : count(country.count)}. {t('geography.regionShare', { value: percent.format(country.share) })}. {t('geography.downloaded')}: {bytes(country.download)}. {t('geography.uploaded')}: {bytes(country.upload)}. {t('geography.connectionCount', { count: country.count })}"
          data-testid="region-card"
          data-country={country.code}
          data-total={country.total}
          data-download={country.download}
          data-upload={country.upload}
          data-count={country.count}
          data-share={country.share * 100}
          onclick={() => onselect(selected === country.code ? null : country.code)}
        >
          <span class="region-name" title={country.name}>
            <span class="region-flag" aria-hidden="true">{flag(country.code)}</span>
            <span class="name-text">{country.name}</span>
          </span>
          <span class="region-main">
            <span class="region-value" data-testid="region-value">{metric === 'traffic' ? bytes(country.total) : count(country.count)}</span>
            <span class="region-share" data-testid="region-share" title={t('geography.regionShareHint')}>{percent.format(country.share)}</span>
          </span>
          <span class="share-track" aria-hidden="true"><span style:transform="scaleX({country.share})"></span></span>
          <span class="region-breakdown">
            <span class="download" title={t('geography.downloaded')}>
              <IconArrowRight class="download-icon" aria-hidden="true" strokeWidth={1.5} />
              <span>{bytes(country.download)}</span>
            </span>
            <span title={t('geography.uploaded')}>
              <IconArrowRight class="upload-icon" aria-hidden="true" strokeWidth={1.5} />
              <span>{bytes(country.upload)}</span>
            </span>
            <span class="region-count" title={t('geography.connectionCount', { count: country.count })}>
              <IconConnections aria-hidden="true" strokeWidth={1.5} />
              <span>{count(country.count)}</span>
            </span>
          </span>
        </button>
      {/each}
    </div>
    {#if countries.length > INITIAL_COUNT}
      <div class="regions-footer">
        <button type="button" data-testid="region-show-all" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
          {expanded ? t('geography.showFewerRegions') : t('geography.showAllRegions', { count: countries.length })}
        </button>
      </div>
    {/if}
  {/if}
</section>

<style>
  .regions-panel { overflow-anchor: none; }
  .regions-panel { padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); }
  .regions-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h2 { font-size: 14px; line-height: 20px; font-weight: 500; }
  .share-hint { margin-top: 4px; color: var(--text-3); font-size: 12px; line-height: 18px; }
  .metric-switch { display: flex; flex: none; gap: 2px; padding: 2px; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--raised); }
  .metric-switch button { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: 1px solid transparent; border-radius: 8px; color: var(--text-2); cursor: pointer; transition: color 150ms var(--ease-out), background-color 150ms var(--ease-out), border-color 150ms var(--ease-out); }
  .metric-switch button:hover { color: var(--text); background: var(--hover); }
  .metric-switch button[aria-pressed='true'] { color: var(--selected-text); background: var(--selected); border-color: var(--selected-border); }
  .metric-switch :global(svg) { width: 18px; height: 18px; }
  .region-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .region-card { min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--card); text-align: left; cursor: pointer; transition: background-color 150ms var(--ease-out), border-color 150ms var(--ease-out); }
  .region-card:hover { border-color: var(--field-border); background: color-mix(in oklab, var(--raised) 35%, var(--card)); }
  .region-card.chosen { border-color: var(--selected-border); background: var(--selected); box-shadow: inset 3px 0 var(--selected-border); }
  .region-card:active, .metric-switch button:active { transform: scale(0.99); }
  .region-name { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 24px; font-size: 14px; line-height: 20px; color: var(--text); }
  .region-flag { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 28px; font-family: 'Twemoji Country Flags', sans-serif; font-size: 22px; line-height: 24px; }
  .name-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .region-main { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 12px; }
  .region-value { font-family: var(--font-mono); font-size: 22px; font-weight: 500; line-height: 28px; font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
  .region-share { flex: none; color: var(--text-3); font-family: var(--font-mono); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
  .share-track { display: block; overflow: hidden; height: 4px; margin-top: 8px; border-radius: 2px; background: var(--raised); }
  .share-track > span { display: block; width: 100%; height: 100%; border-radius: inherit; background: var(--accent); transform-origin: left; }
  .region-breakdown { display: grid; gap: 4px; margin-top: 8px; font-family: var(--font-mono); font-size: 12px; line-height: 18px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .region-breakdown > span { display: flex; align-items: center; gap: 6px; }
  .region-breakdown :global(svg) { width: 14px; height: 14px; flex: none; }
  .download { color: var(--traffic-down-ink); }
  .region-breakdown > span:not(.download):not(.region-count) { color: var(--traffic-up-ink); }
  .download :global(.download-icon) { transform: rotate(90deg); }
  .region-breakdown :global(.upload-icon) { transform: rotate(-90deg); }
  .region-count { color: var(--text-3); }
  .region-card.chosen .region-share, .region-card.chosen .region-count { color: var(--text-2); }
  .regions-footer { display: flex; justify-content: flex-end; margin-top: 12px; }
  .regions-footer button { min-height: 44px; padding: 8px 12px; border-radius: 8px; font-size: 13px; color: var(--text-2); cursor: pointer; transition: color 150ms var(--ease-out), background-color 150ms var(--ease-out); }
  .regions-footer button:hover { color: var(--text); background: var(--hover); }
  .regions-empty { padding: 20px 0; color: var(--text-3); font-size: 13px; line-height: 20px; }
  .region-skeleton { min-height: 196px; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-card); }
  .region-skeleton > span { display: block; border-radius: 4px; background: var(--raised); }
  .skeleton-name { width: 72%; height: 20px; }
  .skeleton-value { width: 58%; height: 28px; margin-top: 16px; }
  .skeleton-bar { height: 4px; margin-top: 12px; }
  .skeleton-detail { width: 62%; height: 12px; margin-top: 12px; }
  .skeleton-detail.short { width: 46%; margin-top: 8px; }
  @media (min-width: 1600px) { .region-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
  @media (max-width: 1099px) { .region-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 599px) { .regions-panel { padding: 16px; } .regions-heading { align-items: flex-start; gap: 12px; } .region-grid { grid-template-columns: minmax(0, 1fr); } }
  @media (prefers-reduced-motion: reduce) { .region-card, .metric-switch button, .regions-footer button { transition: none; } }
</style>
