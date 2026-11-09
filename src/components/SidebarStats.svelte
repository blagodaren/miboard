<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down'
  import ArrowUp from '@lucide/svelte/icons/arrow-up'
  import { core } from '../lib/core.svelte'
  import { bytes, count, speed } from '../lib/format'
  import { t } from '../lib/i18n.svelte'

  const trafficLive = $derived(core.trafficReady && core.trafficOnline)
  const connectionsLive = $derived(core.connectionsFresh && core.connectionsOnline)
  const memoryLive = $derived(core.memoryReady && core.memoryOnline)
  const history = $derived.by(() => {
    void core.tick
    return core.trafficHistory.snapshot(60)
  })
  const ceiling = $derived(Math.max(1024, ...history.down.map(value => value ?? 0), ...history.up.map(value => value ?? 0)))

  function line(values: (number | null)[]): string {
    const end = history.t.at(-1) ?? 0
    let connected = false
    return values.map((value, index) => {
      if (value === null) { connected = false; return '' }
      const x = ((history.t[index]! - (end - 60)) / 60 * 200).toFixed(2)
      const y = (34 - value / ceiling * 30).toFixed(2)
      const point = `${connected ? 'L' : 'M'}${x},${y}`
      connected = true
      return point
    }).join(' ')
  }
</script>

<section class="rounded-card border border-line bg-card p-3" aria-label={t('sidebar.stats')} data-testid="sidebar-stats">
  <dl class="grid grid-cols-2 gap-x-3">
    <div class="min-w-0">
      <dt class="flex items-center gap-1 text-xs text-fg-2"><ArrowDown class="size-3 shrink-0 text-traffic-down-ink" strokeWidth={1.5} aria-hidden="true" />{t('chart.download')}</dt>
      <dd class="num mt-1 font-mono text-[13px] text-traffic-down-ink" data-testid="sidebar-download">{trafficLive ? speed(core.down) : '—'}</dd>
      <dd class="num mt-1 text-xs text-fg-3" title={t('overview.coreCounters')}><span class="sr-only">{t('sidebar.total')}: </span><span data-testid="sidebar-download-total">{connectionsLive ? bytes(core.downTotal) : '—'}</span> <span aria-hidden="true">{t('sidebar.totalShort')}</span></dd>
    </div>
    <div class="min-w-0">
      <dt class="flex items-center gap-1 text-xs text-fg-2"><ArrowUp class="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />{t('chart.upload')}</dt>
      <dd class="num mt-1 font-mono text-[13px] text-traffic-up-ink" data-testid="sidebar-upload">{trafficLive ? speed(core.up) : '—'}</dd>
      <dd class="num mt-1 text-xs text-fg-3" title={t('overview.coreCounters')}><span class="sr-only">{t('sidebar.total')}: </span><span data-testid="sidebar-upload-total">{connectionsLive ? bytes(core.upTotal) : '—'}</span> <span aria-hidden="true">{t('sidebar.totalShort')}</span></dd>
    </div>
  </dl>
  <div class="my-2 h-9" data-testid="sidebar-traffic-history">
    {#if trafficLive}
      <svg class="block h-full w-full" viewBox="0 0 200 36" preserveAspectRatio="none" role="img" aria-label={t('sidebar.trafficHistory')}>
        <title>{t('sidebar.trafficHistory')}</title>
        <path d="M0,35H200" fill="none" stroke="var(--line)" />
        <path d={line(history.down)} fill="none" stroke="var(--traffic-down-line)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        <path d={line(history.up)} fill="none" stroke="var(--traffic-up-line)" stroke-width="1.5" stroke-dasharray="3 3" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
      </svg>
    {:else}
      <p class="flex h-full items-center text-xs text-fg-3">{t('sidebar.waitingTraffic')}</p>
    {/if}
  </div>
  <dl class="grid grid-cols-2 gap-x-3 border-t border-line pt-2 text-xs">
    <div class="min-w-0"><dt class="text-fg-3">{t('sidebar.connections')}</dt><dd class="num mt-1 font-mono text-fg-2" data-testid="sidebar-connections">{connectionsLive ? count(core.conns.length) : '—'}</dd></div>
    <div class="min-w-0"><dt class="text-fg-3">{t('sidebar.memory')}</dt><dd class="num mt-1 font-mono text-fg-2" data-testid="sidebar-memory">{memoryLive ? bytes(core.memory) : '—'}</dd></div>
  </dl>
</section>
