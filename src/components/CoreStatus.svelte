<script lang="ts">
  import { onMount } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { bytes } from '../lib/format'
  import { appendMemorySample, memoryChart, visibleConfigUrl, type MemorySample } from '../lib/core-status'

  const id = $props.id()
  const backendUrl = core.backend.url
  let samples = $state.raw<MemorySample[]>([])
  const chart = $derived(memoryChart(samples))
  const live = $derived(core.memoryReady && core.memoryOnline && core.backend.url === backendUrl)
  type Field = { label: MessageKey; value: unknown }
  const supplied = (fields: Field[]) => fields.filter(field => field.value !== undefined && field.value !== null)
  const display = (value: unknown): string => typeof value === 'boolean' ? t(value ? 'coreTools.enabled' : 'coreTools.disabled')
    : Array.isArray(value) ? value.filter(item => typeof item === 'string' || typeof item === 'number').join(', ') || '—'
    : typeof value === 'string' ? value || t('coreTools.default') : typeof value === 'number' && Number.isFinite(value) ? String(value) : '—'
  const network = $derived(supplied([
    { label: 'coreTools.ipv6', value: core.configs?.ipv6 },
    { label: 'coreTools.sniffing', value: core.configs?.sniffing },
    { label: 'coreTools.processMode', value: core.configs?.['find-process-mode'] },
    { label: 'coreTools.concurrent', value: core.configs?.['tcp-concurrent'] },
    { label: 'coreTools.interface', value: core.configs?.['interface-name'] },
    { label: 'coreTools.bind', value: core.configs?.['bind-address'] },
    { label: 'coreTools.routingMark', value: core.configs?.['routing-mark'] },
    { label: 'coreTools.redirPort', value: core.configs?.['redir-port'] },
    { label: 'coreTools.tproxyPort', value: core.configs?.['tproxy-port'] },
    { label: 'coreTools.tunDevice', value: core.configs?.tun?.device },
    { label: 'coreTools.tunStack', value: core.configs?.tun?.stack },
    { label: 'coreTools.tunMtu', value: core.configs?.tun?.mtu },
    { label: 'coreTools.tunRoute', value: core.configs?.tun?.['auto-route'] },
    { label: 'coreTools.tunInterface', value: core.configs?.tun?.['auto-detect-interface'] },
    { label: 'coreTools.tunStrict', value: core.configs?.tun?.['strict-route'] },
    { label: 'coreTools.tunDns', value: core.configs?.tun?.['dns-hijack'] },
    { label: 'coreTools.tunDnsMode', value: core.configs?.tun?.['dns-mode'] },
  ]))
  const geo = $derived(supplied([
    { label: 'coreTools.geoAuto', value: core.configs?.['geo-auto-update'] },
    { label: 'coreTools.geoInterval', value: core.configs?.['geo-update-interval'] },
    { label: 'coreTools.geoMode', value: core.configs?.['geodata-mode'] },
    { label: 'coreTools.geoLoader', value: core.configs?.['geodata-loader'] },
    { label: 'coreTools.geoMatcher', value: core.configs?.['geosite-matcher'] },
    ...(['geo-ip', 'mmdb', 'asn', 'geo-site'] as const).map((key, i) => ({
      label: (['coreTools.geoIp', 'coreTools.geoMmdb', 'coreTools.geoAsn', 'coreTools.geoSite'] as const)[i],
      value: core.configs?.['geox-url']?.[key] ? visibleConfigUrl(core.configs['geox-url'][key]) : undefined,
    })),
  ]))

  onMount(() => {
    const sample = () => { samples = appendMemorySample(samples, Date.now(), live ? core.memory : null) }
    sample()
    const timer = setInterval(sample, 1000)
    return () => clearInterval(timer)
  })
</script>

{#snippet fields(items: Field[])}
  <dl class="fields">
    {#each items as item}<div><dt>{t(item.label)}</dt><dd>{display(item.value)}</dd></div>{/each}
  </dl>
{/snippet}

<section aria-labelledby="{id}-title" data-testid="core-status">
  <h2 id="{id}-title" class="mb-3 px-1 text-[13px] text-fg-2">{t('coreTools.title')}</h2>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <div class="grid grid-cols-2 gap-4">
      <div><p class="text-xs text-fg-3">{t('coreTools.memory')}</p><p class="num mt-1 text-xl" data-testid="core-memory-value">{live ? bytes(core.memory) : '—'}</p></div>
      <div><p class="text-xs text-fg-3">{t('coreTools.peak')}</p><p class="num mt-1 text-xl">{chart.count ? bytes(chart.peak) : '—'}</p></div>
    </div>
    <div class="memory-chart" data-testid="core-memory-chart">
      <svg viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label={t('coreTools.chart', { peak: bytes(chart.peak), count: chart.count })}>
        <line x1="0" y1="119" x2="600" y2="119" class="baseline" />
        {#each chart.paths as path}<path d={path} class="memory-line" vector-effect="non-scaling-stroke" />{/each}
      </svg>
      {#if !chart.count}<p class="chart-empty">{t(core.memoryOnline ? 'coreTools.waiting' : 'coreTools.offline')}</p>{/if}
    </div>
    <div class="flex justify-between gap-4 text-xs text-fg-3"><span>{t('coreTools.elapsed', { seconds: chart.spanSeconds })}</span><span>{t('coreTools.now')}</span></div>
    <p class="mt-3 text-xs leading-relaxed text-fg-3">{t('coreTools.memoryHint')}</p>
    {#if !live && chart.count}<p class="mt-2 text-xs text-fg-2" role="status">{t('coreTools.offline')}</p>{/if}
    {#if network.length}
      <details class="mt-4 border-t border-line"><summary>{t('coreTools.network')}</summary><p class="mb-3 text-xs text-fg-3">{t('coreTools.readOnly')}</p>{@render fields(network)}</details>
    {:else if !core.configs}<p class="mt-4 text-[13px] text-fg-3">{t('coreTools.configMissing')}</p>{/if}
    {#if geo.length}
      <details class="mt-2 border-t border-line"><summary>{t('coreTools.geo')}</summary><p class="mb-3 text-xs leading-relaxed text-fg-3">{t('coreTools.geoHint')}</p>{@render fields(geo)}</details>
    {/if}
  </div>
</section>

<style>
  .memory-chart { position: relative; height: 120px; margin-top: 20px; }
  svg { width: 100%; height: 100%; overflow: visible; }
  .baseline { stroke: var(--line); }
  .memory-line { fill: none; stroke: var(--accent-ink); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .chart-empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-3); font-size: 13px; text-align: center; }
  summary { min-height: 44px; align-content: center; cursor: pointer; font-size: 13px; color: var(--text-2); padding: 10px 0; }
  .fields { display: grid; gap: 12px; font-size: 13px; }
  .fields > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  dt { color: var(--text-3); overflow-wrap: anywhere; }
  dd { min-width: 0; overflow-wrap: anywhere; text-align: right; }
  @media (max-width: 420px) { .fields > div { grid-template-columns: minmax(0, 1fr); gap: 3px; } dd { text-align: left; } }
</style>
