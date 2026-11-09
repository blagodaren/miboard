<script lang="ts">
  import { Dialog } from 'bits-ui'
  import type { Proxy, ProxyProvider } from '../lib/api'
  import { nodeHistories, nodeCapabilities, historySummary, historyPlot, NODE_HISTORY_LIMIT } from '../lib/node-diagnostics'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconClose } from '../lib/icons'
  import { buttonClass } from '../lib/ui'

  let { open = $bindable(false), node, provider, providerName = '' }: {
    open: boolean; node: Proxy | null; provider?: ProxyProvider; providerName?: string
  } = $props()
  let chosen = $state('')
  let returnFocus: HTMLElement | null = null
  const histories = $derived(nodeHistories(node))
  const capabilities = $derived(nodeCapabilities(node))
  const source = $derived(histories.find(history => history.id === chosen) ?? histories.find(history => history.url === (provider?.testUrl || node?.testUrl)) ?? histories.find(history => history.url !== null && history.samples.length) ?? histories[0])
  const samples = $derived(source?.samples ?? [])
  const summary = $derived(historySummary(samples))
  const plot = $derived(historyPlot(samples))
  const timestamp = (time: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }).format(time)
  const number = (value: number) => new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 1 }).format(value)
  const delay = (value: number | null) => value === null ? '—' : t('proxies.delay', { delay: number(value) })
  const label = (key: string) => ['udp', 'uot', 'xudp', 'tfo', 'mptcp', 'smux'].includes(key) ? key.toUpperCase() : key
  $effect(() => { void node?.name; void providerName; void open; chosen = '' })
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-scrim" />
    <Dialog.Content class="node-diagnostics-dialog" data-testid="node-diagnostics"
      onOpenAutoFocus={() => { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
      onCloseAutoFocus={event => { if (returnFocus?.isConnected) { event.preventDefault(); returnFocus.focus({ preventScroll: true }) } }}>
      <header class="diagnostics-header">
        <div class="min-w-0"><Dialog.Title class="text-base font-medium">{t('nodeDiagnostics.title')}</Dialog.Title><Dialog.Description class="mt-1 break-words text-[13px] text-fg-2">{node?.name ?? '—'}{node?.type ? ` · ${node.type}` : ''}</Dialog.Description></div>
        <Dialog.Close class={buttonClass({ variant: 'ghost', size: 'sm', class: 'shrink-0' })} aria-label={t('nodeDiagnostics.close')} data-testid="node-diagnostics-close"><IconClose size={18} strokeWidth={1.5} /></Dialog.Close>
      </header>
      <div class="diagnostics-scroll">
        <p class="text-xs leading-5 text-fg-3">{t('nodeDiagnostics.snapshot')}</p>
        <section class="diagnostics-section">
          <h3>{t('nodeDiagnostics.history')}</h3>
          <label class="mt-3 block text-xs text-fg-3" for="node-history-source">{t('nodeDiagnostics.source')}</label>
          <select id="node-history-source" data-testid="node-history-source" class="mt-1 min-h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px] text-fg" value={source?.id ?? 'generic'} onchange={event => { chosen = event.currentTarget.value }}>
            {#each histories as history (history.id)}<option value={history.id}>{history.url ?? t('nodeDiagnostics.generic')}</option>{/each}
          </select>
          {#if source?.url}<p class="mt-2 break-all font-mono text-xs text-fg-2">{source.url}</p>{:else}<p class="mt-2 text-xs leading-5 text-fg-3">{t('nodeDiagnostics.genericHint')}</p>{/if}
          {#if samples.length}
            <dl class="diagnostics-summary">
              <div><dt>{t('nodeDiagnostics.median')}</dt><dd class="num">{delay(summary.median)}</dd></div>
              <div><dt>{t('nodeDiagnostics.range')}</dt><dd class="num">{summary.min === null ? '—' : `${number(summary.min)}–${delay(summary.max)}`}</dd></div>
              <div><dt>{t('nodeDiagnostics.failed')}</dt><dd class="num">{summary.failed}/{summary.total}</dd></div>
            </dl>
            <svg class="history-chart" viewBox={`0 0 ${plot.width} ${plot.height}`} role="img" aria-label={t('nodeDiagnostics.chart')}>
              <line x1="12" y1="138" x2="628" y2="138" stroke="var(--line)" />
              {#each plot.paths as path}<path d={path} fill="none" stroke="var(--accent-ink)" stroke-width="2" vector-effect="non-scaling-stroke" />{/each}
              {#each plot.points as point, index (index)}
                {#if point.failed}<path d={`M${point.x - 3},${point.y - 3}l6,6m-6,0l6,-6`} stroke="var(--text-3)" stroke-width="1.5" vector-effect="non-scaling-stroke"><title>{timestamp(point.time)} · {t('nodeDiagnostics.noResponse')}</title></path>
                {:else}<circle cx={point.x} cy={point.y} r="3" fill="var(--accent-ink)"><title>{timestamp(point.time)} · {delay(point.delay)}</title></circle>{/if}
              {/each}
            </svg>
            <div class="history-table-scroll"><table class="history-table" data-testid="node-history-table"><thead><tr><th>{t('nodeDiagnostics.time')}</th><th>{t('nodeDiagnostics.delay')}</th></tr></thead><tbody>
              {#each [...samples].reverse() as sample, index (index)}<tr data-history-delay={sample.delay}><td class="num">{timestamp(sample.time)}</td><td class="num" class:text-fg-3={sample.failed}>{sample.failed ? t('nodeDiagnostics.noResponse') : delay(sample.delay)}</td></tr>{/each}
            </tbody></table></div>
            {#if source?.truncated}<p class="mt-2 text-xs text-fg-3">{t('nodeDiagnostics.limited', { count: NODE_HISTORY_LIMIT })}</p>{/if}
          {:else}<p class="my-5 text-[13px] text-fg-3">{t('nodeDiagnostics.empty')}</p>{/if}
          <p class="mt-3 text-xs leading-5 text-fg-3">{t('nodeDiagnostics.historyHint')}</p>
        </section>
        <section class="diagnostics-section">
          <h3>{t('nodeDiagnostics.capabilities')}</h3>
          {#if capabilities.length}<dl class="capabilities" data-testid="node-capabilities">{#each capabilities as capability (capability.key)}<div><dt>{label(capability.key)}</dt><dd class="font-mono">{typeof capability.value === 'boolean' ? t(capability.value ? 'nodeDiagnostics.enabled' : 'nodeDiagnostics.disabled') : capability.value}</dd></div>{/each}</dl>
          {:else}<p class="mt-3 text-xs text-fg-3">{t('nodeDiagnostics.noCapabilities')}</p>{/if}
          <p class="mt-3 text-xs leading-5 text-fg-3">{t('nodeDiagnostics.capabilityHint')}</p>
        </section>
        {#if providerName || provider || node?.testUrl || node?.expectedStatus}
          <section class="diagnostics-section"><h3>{t('nodeDiagnostics.provider')}</h3><dl class="capabilities">
            {#if providerName}<div><dt>{t('nodeDiagnostics.provider')}</dt><dd>{providerName}</dd></div>{/if}
            <div><dt>{t('nodeDiagnostics.testUrl')}</dt><dd class="font-mono">{provider?.testUrl || node?.testUrl || t('nodeDiagnostics.unknown')}</dd></div>
            <div><dt>{t('nodeDiagnostics.expectedStatus')}</dt><dd class="font-mono">{provider?.expectedStatus || node?.expectedStatus || t('nodeDiagnostics.unknown')}</dd></div>
          </dl></section>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.node-diagnostics-dialog) { position: fixed; top: 50%; left: 50%; z-index: 50; display: flex; flex-direction: column; width: min(760px, calc(100vw - 32px)); max-height: min(90dvh, 1000px); transform: translate(-50%, -50%); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); color: var(--text); box-shadow: var(--shadow-float); }
  .diagnostics-header { display: flex; flex: none; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 24px; border-bottom: 1px solid var(--line); }
  .diagnostics-scroll { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 20px 24px 28px; }
  .diagnostics-section { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--line); }
  h3 { font-size: 14px; line-height: 20px; font-weight: 500; }
  .diagnostics-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
  dt { color: var(--text-3); font-size: 12px; line-height: 20px; }
  .diagnostics-summary dd { margin-top: 4px; font-size: 20px; line-height: 28px; overflow-wrap: anywhere; }
  .history-chart { display: block; width: 100%; height: auto; margin: 20px 0; border-radius: var(--radius-card); background: var(--raised); }
  .history-table-scroll { max-height: 240px; overflow: auto; border: 1px solid var(--line); border-radius: var(--radius-control); }
  .history-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { padding: 12px; text-align: left; color: var(--text-2); font-weight: 500; }
  td { padding: 12px; border-top: 1px solid var(--line); }
  td:last-child, th:last-child { text-align: right; }
  .capabilities { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; margin-top: 16px; }
  .capabilities dd { margin-top: 4px; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  @media (max-width: 639px) {
    :global(.node-diagnostics-dialog) { width: calc(100vw - 16px); max-height: calc(100dvh - 24px); }
    .diagnostics-header, .diagnostics-scroll { padding: 16px; }
    .diagnostics-summary { gap: 8px; }
    .diagnostics-summary dt { min-height: 40px; }
    .diagnostics-summary dd { font-size: 16px; line-height: 24px; }
    .capabilities { grid-template-columns: minmax(0, 1fr); }
  }
</style>
