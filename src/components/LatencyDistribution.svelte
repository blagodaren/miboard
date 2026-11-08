<script lang="ts">
  import { summarizeLatencyDistribution } from '../lib/latency-distribution'
  import { t } from '../lib/i18n.svelte'

  let { values, yellow, red, label }: {
    values: readonly (number | undefined)[]
    yellow: number
    red: number
    label: string
  } = $props()

  const counts = $derived(summarizeLatencyDistribution(values, yellow, red))
  const summary = $derived(t('latency.distributionSummary', counts))
  const bands = $derived([
    { name: 'fast', count: counts.fast },
    { name: 'ok', count: counts.ok },
    { name: 'slow', count: counts.slow },
    { name: 'none', count: counts.none },
  ])
</script>

<div
  class="latency-distribution"
  data-testid="latency-distribution"
  data-fast={counts.fast}
  data-ok={counts.ok}
  data-slow={counts.slow}
  data-none={counts.none}
  data-total={counts.total}
  role="img"
  aria-label="{label}. {summary}"
  title="{label}. {summary}"
>
  {#each bands as band (band.name)}
    {#if band.count > 0}
      <span class="latency-band" data-band={band.name} data-count={band.count} style:flex-grow={band.count} aria-hidden="true"></span>
    {/if}
  {/each}
</div>

<style>
  .latency-distribution { display: flex; width: 100%; height: 4px; overflow: hidden; border-radius: 2px; background: var(--line); }
  .latency-band { min-width: 0; height: 100%; flex-basis: 0; }
  .latency-band[data-band='fast'] { background: var(--good); }
  .latency-band[data-band='ok'] { background: var(--warning); }
  .latency-band[data-band='slow'] { background: var(--bad); }
  .latency-band[data-band='none'] { background: var(--line); }
</style>
