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
    <a href={href} class="ranking-title"><Icon size={18} strokeWidth={1.5} aria-hidden="true" /><h2>{title}</h2><ArrowUpRight class="open-icon" size={16} strokeWidth={1.5} aria-hidden="true" /></a>
    <div class="metric-control" role="group" aria-label={t('overview.rankBy', { title })}>
      <button aria-label={t('overview.byTraffic')} title={t('overview.byTraffic')} aria-pressed={metric === 'traffic'} onclick={() => { metric = 'traffic' }}><ChartNoAxesColumn size={16} strokeWidth={1.5} aria-hidden="true" /></button>
      <button aria-label={t('overview.byConnections')} title={t('overview.byConnections')} aria-pressed={metric === 'connections'} onclick={() => { metric = 'connections' }}><Link2 size={16} strokeWidth={1.5} aria-hidden="true" /></button>
    </div>
  </header>
  {#if ranked.length}
    <ol class="ranking-list">
      {#each ranked as row, index (row.id)}
        {@const rowTotal = row.download + row.upload}
        <li class="ranking-row" data-testid="overview-rank-row">
          <span class="rank num">{index + 1}</span>
          <div class="row-content">
            <div class="row-heading">
              <span class="row-name" title={row.name}>
                {#if row.flag}<span class="country-flag" aria-hidden="true">{row.flag}</span>{/if}
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
    <div class="empty-ranking"><Network size={24} strokeWidth={1.5} aria-hidden="true" /><p>{t('overview.noSessionData')}</p></div>
  {/if}
</section>

<style>
  .ranking { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .ranking-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .ranking-title { display: flex; min-width: 0; align-items: center; gap: 8px; min-height: 36px; color: var(--text); transition: color 150ms; }
  .ranking-title:hover { color: var(--accent-ink); }
  h2 { font-size: 14px; line-height: 20px; font-weight: 500; }
  .ranking-title :global(svg) { flex-shrink: 0; }
  .ranking-title :global(.open-icon) { opacity: 0; transition: opacity 150ms, transform 150ms; }
  .ranking-title:hover :global(.open-icon), .ranking-title:focus-visible :global(.open-icon) { opacity: 1; transform: translate(1px, -1px); }
  .metric-control { display: flex; flex-shrink: 0; gap: 2px; padding: 2px; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--raised); }
  .metric-control button { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid transparent; border-radius: 7px; color: var(--text-2); cursor: pointer; transition: color 150ms, background 150ms, border-color 150ms; }
  .metric-control button:hover { background: var(--hover); color: var(--text); }
  .metric-control button[aria-pressed='true'] { color: var(--selected-text); border-color: var(--selected-border); background: var(--selected); }
  .metric-control button:active { transform: translateY(1px); }
  .ranking-list { display: flex; flex-direction: column; gap: 8px; }
  .ranking-row { display: flex; align-items: flex-start; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--card); }
  .rank { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 20px; height: 20px; color: var(--text-3); font-size: 12px; font-weight: 400; }
  .row-content { flex: 1; min-width: 0; }
  .row-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; line-height: 20px; }
  .row-name { display: inline-flex; align-items: center; min-width: 0; gap: 8px; font-size: 13px; font-weight: 400; }
  .name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .country-flag { flex-shrink: 0; font-size: 15px; }
  .row-value { flex-shrink: 0; font-size: 13px; font-weight: 500; white-space: nowrap; }
  .traffic-bar { display: flex; margin: 8px 0; height: 4px; overflow: hidden; border-radius: 4px; background: var(--raised); }
  .traffic-bar span { height: 100%; }
  .bar-down { background: var(--traffic-down-line); }
  .bar-up { background: var(--traffic-up-line); }
  .row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--text-3); }
  .row-meta > span { display: inline-flex; align-items: center; gap: 2px; white-space: nowrap; }
  .download { color: var(--traffic-down-ink); }
  .upload { color: var(--traffic-up-ink); }
  .connections { min-width: 0; }
  .row-meta :global(svg) { flex-shrink: 0; }
  .row-meta > .share { margin-left: auto; }
  .empty-ranking { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; min-height: 132px; padding: 20px; border: 1px dashed var(--line); border-radius: var(--radius-card); color: var(--text-3); font-size: 12px; text-align: center; }
  @media (min-width: 1100px) and (max-width: 1279px) { .row-meta { flex-wrap: wrap; gap: 4px 8px; } .row-meta > .share { margin-left: 0; } }
  @media (max-width: 767px) { .ranking { padding: 16px; } .metric-control button { width: 44px; height: 44px; } .row-meta { gap: 8px; } }
  @media (prefers-reduced-motion: reduce) { .ranking-title, .ranking-title :global(.open-icon), .metric-control button { transition: none; } }
  @media (max-width: 479px) { .ranking-header { flex-wrap: wrap; } .ranking-title { flex: 1 1 160px; } .row-heading { flex-wrap: wrap; gap: 4px 8px; } .row-name { flex: 1 1 120px; } }
</style>
