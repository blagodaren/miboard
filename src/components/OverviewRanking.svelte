<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import ChartNoAxesColumn from '@lucide/svelte/icons/chart-no-axes-column'
  import Globe from '@lucide/svelte/icons/globe'
  import Link2 from '@lucide/svelte/icons/link-2'
  import Network from '@lucide/svelte/icons/network'
  import { bytes, count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'

  type Row = { id: string; name: string; download: number; upload: number; connections: number; flag?: string }
  let { title, icon: Icon, rows, href, bars = true }: {
    title: string
    icon: typeof Globe
    rows: Row[]
    href: string
    bars?: boolean
  } = $props()
  let metric = $state<'traffic' | 'connections'>('traffic')
  const value = (row: Row) => metric === 'traffic' ? row.download + row.upload : row.connections
  const ranked = $derived([...rows].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name, i18n.intlLocale)).slice(0, 6))
  const total = $derived(rows.reduce((sum, row) => sum + value(row), 0))
  const percent = (amount: number) => new Intl.NumberFormat(i18n.intlLocale, { style: 'percent', maximumFractionDigits: 1 }).format(total ? amount / total : 0)
</script>

<section class="ranking" aria-label={title} data-testid="overview-ranking">
  <header class="ranking-header">
    <a href={href} class="ranking-title"><Icon size={17} strokeWidth={1.7} /><h2>{title}</h2><ArrowUpRight class="open-icon" size={13} /></a>
    <div class="metric-control" role="group" aria-label={t('overview.rankBy', { title })}>
      <button aria-label={t('overview.byTraffic')} title={t('overview.byTraffic')} aria-pressed={metric === 'traffic'} onclick={() => { metric = 'traffic' }}><ChartNoAxesColumn size={16} strokeWidth={1.7} /></button>
      <button aria-label={t('overview.byConnections')} title={t('overview.byConnections')} aria-pressed={metric === 'connections'} onclick={() => { metric = 'connections' }}><Link2 size={16} strokeWidth={1.7} /></button>
    </div>
  </header>
  {#if ranked.length}
    <ol class="ranking-list">
      {#each ranked as row, index (row.id)}
        {@const rowTotal = row.download + row.upload}
        <li class="ranking-row" data-testid="overview-rank-row">
          <span class="rank num" data-medal={index < 3 ? index + 1 : undefined}>{index + 1}</span>
          <div class="row-content">
            <div class="row-heading">
              <span class="row-name" title={row.name}>
                {#if row.flag}<span class="country-flag" aria-hidden="true">{row.flag}</span>
                {:else if !bars}<span class="domain-icon"><Globe size={12} strokeWidth={1.6} /></span>{/if}
                <span class="name-text">{row.name}</span>
              </span>
              <strong class="row-value num">{metric === 'traffic' ? bytes(rowTotal) : count(row.connections)}</strong>
            </div>
            {#if bars}
              <div class="traffic-bar" aria-hidden="true">
                {#if metric === 'traffic'}
                  <span class="bar-down" style:width="{total ? row.download / total * 100 : 0}%"></span>
                  <span class="bar-up" style:width="{total ? row.upload / total * 100 : 0}%"></span>
                {:else}
                  <span class="bar-down" style:width="{total ? row.connections / total * 100 : 0}%"></span>
                {/if}
              </div>
            {/if}
            <div class="row-meta num">
              <span class="download" title={t('overview.downloaded')}><ArrowDown size={12} />{bytes(row.download)}</span>
              <span class="upload" title={t('overview.uploaded')}><ArrowUp size={12} />{bytes(row.upload)}</span>
              <span class="connections" title={t('overview.connections')}><Link2 size={12} />{count(row.connections)}</span>
              {#if bars}<span class="share">{percent(value(row))}</span>{/if}
            </div>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <div class="empty-ranking"><Network size={24} strokeWidth={1.3} /><p>{t('overview.noSessionData')}</p></div>
  {/if}
</section>

<style>
  .ranking { min-width: 0; }
  .ranking-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 11px; }
  .ranking-title { display: flex; min-width: 0; align-items: center; gap: 8px; min-height: 34px; color: var(--text-2); transition: color 150ms; }
  .ranking-title:hover { color: var(--text); }
  h2 { font-size: 12px; line-height: 17px; font-weight: 600; letter-spacing: .055em; text-transform: uppercase; }
  .ranking-title :global(svg) { flex-shrink: 0; }
  .ranking-title :global(.open-icon) { opacity: 0; transition: opacity 150ms, transform 150ms; }
  .ranking-title:hover :global(.open-icon), .ranking-title:focus-visible :global(.open-icon) { opacity: 1; transform: translate(1px, -1px); }
  .metric-control { display: flex; flex-shrink: 0; gap: 2px; padding: 2px; border-radius: 10px; background: var(--raised); }
  .metric-control button { display: flex; align-items: center; justify-content: center; width: 31px; height: 30px; border: 1px solid transparent; border-radius: 8px; color: var(--text-3); cursor: pointer; transition: color 150ms, background 150ms, border-color 150ms; }
  .metric-control button:hover { background: var(--hover); color: var(--text); }
  .metric-control button[aria-pressed='true'] { color: var(--traffic-down); border-color: var(--line); background: var(--card); box-shadow: var(--shadow-panel); }
  .metric-control button:active { transform: translateY(1px); }
  .ranking-list { display: flex; flex-direction: column; gap: 8px; }
  .ranking-row { display: flex; align-items: flex-start; gap: 9px; min-width: 0; padding: 12px 11px 11px; border: 1px solid color-mix(in srgb, var(--line) 65%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--card) 78%, var(--page)); }
  .rank { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background: var(--raised); color: var(--text-3); font-size: 10px; font-weight: 600; }
  .rank[data-medal='1'] { background: light-dark(#fff0bd, #483619); color: light-dark(#80500d, #f3cb74); }
  .rank[data-medal='2'] { background: light-dark(#e9edf5, #2b303c); color: light-dark(#4a586c, #bfccdf); }
  .rank[data-medal='3'] { background: light-dark(#ffe8cf, #463021); color: light-dark(#a05117, #f5b07b); }
  .row-content { flex: 1; min-width: 0; }
  .row-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; line-height: 20px; }
  .row-name { display: inline-flex; align-items: center; min-width: 0; gap: 7px; font-size: 13px; font-weight: 450; }
  .name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .country-flag { flex-shrink: 0; font-size: 15px; }
  .domain-icon { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 18px; height: 18px; border-radius: 5px; background: var(--raised); color: var(--text-3); }
  .row-value { flex-shrink: 0; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .traffic-bar { display: flex; margin: 6px 0 5px; height: 5px; overflow: hidden; border-radius: 4px; background: var(--raised); }
  .traffic-bar span { height: 100%; }
  .bar-down { background: var(--traffic-down-line); }
  .bar-up { background: var(--traffic-up-line); }
  .row-meta { display: flex; align-items: center; gap: 7px; margin-top: 4px; font-size: 10px; line-height: 16px; color: var(--text-3); }
  .row-meta > span { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
  .download { color: var(--traffic-down); }
  .upload { color: var(--traffic-up); }
  .connections { min-width: 0; }
  .row-meta :global(svg) { flex-shrink: 0; }
  .row-meta > .share { margin-left: auto; }
  .empty-ranking { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 132px; padding: 20px; border: 1px dashed var(--line); border-radius: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
  @media (min-width: 1100px) and (max-width: 1279px) { .row-meta { flex-wrap: wrap; gap: 1px 7px; } .row-meta > .share { margin-left: 0; } }
  @media (max-width: 767px) { .metric-control button { width: 40px; height: 38px; } .row-meta { font-size: 11px; gap: 8px; } }
  @media (prefers-reduced-motion: reduce) { .ranking-title, .ranking-title :global(.open-icon), .metric-control button { transition: none; } }
</style>
