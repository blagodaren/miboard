<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { onDestroy } from 'svelte'
  import type { ConnRow } from '../lib/core.svelte'
  import type { JournalEntry } from '../lib/connection-journal'
  import { connectionEndpoint, connectionJSON } from '../lib/connection-details'
  import { bytes, speed, since } from '../lib/format'
  import { t, i18n, type MessageKey } from '../lib/i18n.svelte'
  import { IconClose, IconCopy, IconCheck, IconConnections, IconArrowRight } from '../lib/icons'
  import { buttonClass } from '../lib/ui'
  import Button from './Button.svelte'
  import Segmented from './Segmented.svelte'

  type Status = 'live' | 'paused' | 'closed' | 'offline' | 'snapshot'
  type DetailRow = ConnRow & { journal?: JournalEntry }
  type Field = { label: MessageKey; value: unknown; mono?: boolean }
  let { open = $bindable(false), connection, deviceName = '', status = 'snapshot' }: {
    open: boolean
    connection: DetailRow | null
    deviceName?: string
    status?: Status
  } = $props()

  let view = $state<'overview' | 'json'>('overview')
  let copyState = $state<'idle' | 'copying' | 'copied' | 'error'>('idle')
  let now = $state(Date.now())
  let snapshotAt = $state(Date.now())
  let mounted = true
  let returnFocus: HTMLElement | null = null
  const meta = $derived(connection?.metadata)
  const json = $derived(connection ? connectionJSON(connection) : '')
  const identity = $derived(connection ? `${connection.id}\n${connection.start}` : '')
  const tabs = $derived([{ value: 'overview' as const, label: t('connectionDetails.overview') }, { value: 'json' as const, label: 'JSON' }])
  const title = $derived(meta?.host || meta?.sniffHost || meta?.destinationIP || t('connectionDetails.unavailable'))
  const dateFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium', timeStyle: 'medium' }))
  const started = $derived(connection ? Date.parse(connection.start) : NaN)
  const observedEnd = $derived(connection?.journal?.lastSeenAt ?? (status === 'live' ? now : snapshotAt))
  const chain = $derived((connection?.chains ?? []).map((name, index) => ({ name, provider: connection?.providerChains?.[index] ?? '' })).reverse())
  const display = (value: unknown): string => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) ? '—' : Array.isArray(value) ? value.join(', ') : String(value)
  const provided = (value: unknown) => value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
  const stamp = (value: number) => Number.isFinite(value) ? dateFormat.format(value) : '—'
  const validRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const optional = (fields: Field[]) => fields.filter(field => provided(field.value))

  const addresses = $derived<Field[]>([
    { label: 'connectionDetails.host', value: meta?.host },
    ...optional([{ label: 'connectionDetails.sniffHost', value: meta?.sniffHost }]),
    { label: 'connectionDetails.source', value: connectionEndpoint(meta?.sourceIP, meta?.sourcePort), mono: true },
    { label: 'connectionDetails.destination', value: connectionEndpoint(meta?.destinationIP, meta?.destinationPort), mono: true },
    ...optional([{ label: 'connectionDetails.sourceDevice', value: deviceName }, { label: 'connectionDetails.remoteDestination', value: meta?.remoteDestination }]),
    { label: 'connectionDetails.network', value: meta?.network?.toUpperCase() },
    { label: 'connectionDetails.inboundType', value: meta?.type },
    { label: 'connectionDetails.dnsMode', value: meta?.dnsMode },
    ...optional([
      { label: 'connectionDetails.inboundName', value: meta?.inboundName },
      { label: 'connectionDetails.inboundAddress', value: meta?.inboundIP || meta?.inboundPort ? connectionEndpoint(meta?.inboundIP, meta?.inboundPort) : undefined, mono: true },
      { label: 'connectionDetails.inboundUser', value: meta?.inboundUser },
    ]),
  ])
  const application = $derived<Field[]>([
    { label: 'connectionDetails.process', value: meta?.process },
    { label: 'connectionDetails.processPath', value: meta?.processPath, mono: true },
    ...optional([{ label: 'connectionDetails.uid', value: meta?.uid, mono: true }]),
  ])
  const location = $derived(optional([
    { label: 'connectionDetails.sourceGeoIP', value: meta?.sourceGeoIP },
    { label: 'connectionDetails.sourceIPASN', value: meta?.sourceIPASN },
    { label: 'connectionDetails.destinationGeoIP', value: meta?.destinationGeoIP },
    { label: 'connectionDetails.destinationIPASN', value: meta?.destinationIPASN },
    { label: 'connectionDetails.exitGeoIP', value: meta?.exitGeoIP },
    { label: 'connectionDetails.exitIPASN', value: meta?.exitIPASN },
  ]))
  const additional = $derived(optional([
    { label: 'connectionDetails.rematchName', value: meta?.rematchName },
    { label: 'connectionDetails.specialProxy', value: meta?.specialProxy },
    { label: 'connectionDetails.specialRules', value: meta?.specialRules },
    { label: 'connectionDetails.smartBlock', value: meta?.smartBlock },
    { label: 'connectionDetails.smartTarget', value: meta?.smartTarget },
    { label: 'connectionDetails.wildcardTarget', value: meta?.wildcardTarget },
    { label: 'connectionDetails.dscp', value: meta?.dscp, mono: true },
  ]))

  $effect(() => { void identity; void open; view = 'overview'; copyState = 'idle' })
  $effect(() => { if (connection) snapshotAt = Date.now() })
  $effect(() => {
    if (!open) return
    now = Date.now()
    const interval = setInterval(() => { now = Date.now() }, 1000)
    return () => clearInterval(interval)
  })
  onDestroy(() => { mounted = false })

  async function copyJSON() {
    if (!connection || copyState === 'copying') return
    const copiedIdentity = identity
    const content = json
    copyState = 'copying'
    try {
      await navigator.clipboard.writeText(content)
      if (mounted && open && identity === copiedIdentity) copyState = 'copied'
    } catch {
      if (mounted && open && identity === copiedIdentity) { view = 'json'; copyState = 'error' }
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-scrim" />
    <Dialog.Content class="connection-dialog" data-testid="connection-details"
      onOpenAutoFocus={() => { returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
      onCloseAutoFocus={event => { if (returnFocus?.isConnected) { event.preventDefault(); returnFocus.focus({ preventScroll: true }) } }}>
      <header class="dialog-header">
        <div class="dialog-heading">
          <Dialog.Title class="dialog-title"><IconConnections size={16} strokeWidth={1.5} aria-hidden="true" />{t('connectionDetails.title')}</Dialog.Title>
          <Dialog.Description class="dialog-description">{title}</Dialog.Description>
        </div>
        <Dialog.Close class={buttonClass({ variant: 'ghost', size: 'sm', class: 'close-details' })} aria-label={t('connectionDetails.close')} data-testid="connection-details-close"><IconClose size={18} strokeWidth={1.5} aria-hidden="true" /></Dialog.Close>
      </header>

      <div class="dialog-toolbar">
        <Segmented value={view} options={tabs} onchange={value => { view = value }} label={t('connectionDetails.view')} />
        <Button size="sm" data-testid="connection-copy-json" onclick={copyJSON} disabled={copyState === 'copying' || !connection}>
          {#if copyState === 'copied'}<IconCheck strokeWidth={1.5} aria-hidden="true" />{:else}<IconCopy strokeWidth={1.5} aria-hidden="true" />{/if}
          {t(copyState === 'copying' ? 'connectionDetails.copying' : copyState === 'copied' ? 'connectionDetails.copied' : 'connectionDetails.copyJson')}
        </Button>
      </div>

      <div class="dialog-scroll">
        {#if connection}
          <div class="snapshot-status"><span class="status-badge"><span class="led" data-on={status === 'live'}></span>{t(`connectionDetails.${status}`)}</span><p role="status" class:error-message={copyState === 'error'}>{copyState === 'error' ? t('connectionDetails.copyError') : copyState === 'copied' ? t('connectionDetails.copied') : ''}</p></div>
          {#if status !== 'live'}<p class="snapshot-hint">{t(connection.journal ? 'connectionDetails.archivedHint' : status === 'paused' ? 'connectionDetails.pausedHint' : status === 'offline' ? 'connectionDetails.offlineHint' : 'connectionDetails.snapshotHint')}</p>{/if}

          {#if view === 'json'}
            <p class="json-hint">{t(connection.journal ? 'connectionDetails.rawArchivedHint' : 'connectionDetails.rawHint')}</p>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (The focusable JSON region supports keyboard scrolling inside the inspector.) -->
            <pre class="connection-json" data-testid="connection-json" role="region" tabindex="0" aria-label="JSON"><code>{json}</code></pre>
          {:else}
            <div class="traffic-metrics">
              <div><span>{t('connectionDetails.download')}</span><strong class="num down">{bytes(connection.download)}</strong></div>
              <div><span>{t('connectionDetails.upload')}</span><strong class="num up">{bytes(connection.upload)}</strong></div>
              <div><span>{t('connectionDetails.downloadSpeed')}</span><strong class="num">{connection.journal || !validRate(connection.dl) ? '—' : speed(connection.dl)}</strong>{#if validRate(connection.maxDownloadRate)}<small class="num">{t('connectionDetails.peak', { value: speed(connection.maxDownloadRate) })}</small>{/if}</div>
              <div><span>{t('connectionDetails.uploadSpeed')}</span><strong class="num">{connection.journal || !validRate(connection.ul) ? '—' : speed(connection.ul)}</strong>{#if validRate(connection.maxUploadRate)}<small class="num">{t('connectionDetails.peak', { value: speed(connection.maxUploadRate) })}</small>{/if}</div>
            </div>
            {#if validRate(connection.downloadSpeed) || validRate(connection.uploadSpeed)}
              <div class="core-rates">{@render fields([
                { label: 'connectionDetails.coreDownloadSpeed', value: validRate(connection.downloadSpeed) ? speed(connection.downloadSpeed) : '—' },
                { label: 'connectionDetails.coreUploadSpeed', value: validRate(connection.uploadSpeed) ? speed(connection.uploadSpeed) : '—' },
              ])}</div>
            {/if}

            <section class="detail-section"><h3>{t('connectionDetails.addresses')}</h3>{@render fields(addresses)}</section>
            <section class="detail-section">
              <h3>{t('connectionDetails.routing')}</h3>
              <div class="route-label">{t('connectionDetails.chain')}</div>
              <ol class="route-chain" data-testid="connection-route-chain">
                {#each chain as item, index}
                  <li>{#if index}<IconArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />{/if}<div><span>{item.name || '—'}</span>{#if item.provider}<small>{t('connectionDetails.provider')}: {item.provider}</small>{/if}</div></li>
                {:else}<li class="text-fg-3">—</li>{/each}
              </ol>
              {@render fields([{ label: 'connectionDetails.rule', value: connection.rule }, { label: 'connectionDetails.rulePayload', value: connection.rulePayload, mono: true }])}
            </section>
            <section class="detail-section"><h3>{t('connectionDetails.application')}</h3>{@render fields(application)}</section>
            {#if location.length}<section class="detail-section"><h3>{t('connectionDetails.location')}</h3>{@render fields(location)}</section>{/if}
            <section class="detail-section">
              <h3>{t('connectionDetails.timing')}</h3>
              {@render fields([
                { label: 'connectionDetails.started', value: stamp(started) },
                { label: 'connectionDetails.duration', value: Number.isFinite(started) ? since(connection.start, observedEnd) : '—' },
                ...(connection.journal ? [
                  { label: 'connectionDetails.firstSeen' as const, value: stamp(connection.journal.firstSeenAt) },
                  { label: 'connectionDetails.lastSeen' as const, value: stamp(connection.journal.lastSeenAt) },
                  { label: 'connectionDetails.closedAt' as const, value: stamp(connection.journal.closedAt) },
                ] : []),
                { label: 'connectionDetails.id', value: connection.id, mono: true },
                ...optional([{ label: 'connectionDetails.metadataId', value: meta?.id, mono: true }]),
              ])}
              {#if connection.journal?.afterGap}<p class="snapshot-hint gap-hint">{t('connectionDetails.afterGap')}</p>{/if}
            </section>
            {#if additional.length}<section class="detail-section"><h3>{t('connectionDetails.additional')}</h3>{@render fields(additional)}</section>{/if}
          {/if}
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

{#snippet fields(items: Field[])}
  <dl class="detail-fields">
    {#each items as field (field.label)}<div><dt>{t(field.label)}</dt><dd class:font-mono={field.mono}>{display(field.value)}</dd></div>{/each}
  </dl>
{/snippet}

<style>
  :global(.connection-dialog) { position: fixed; top: 50%; left: 50%; z-index: 50; display: flex; flex-direction: column; width: min(900px, calc(100vw - 32px)); max-height: min(90dvh, 1000px); transform: translate(-50%, -50%); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); color: var(--text); box-shadow: var(--shadow-float); }
  .dialog-header { display: flex; flex: none; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 20px 24px 16px; }
  .dialog-heading { min-width: 0; }
  :global(.dialog-title) { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 500; line-height: 24px; }
  :global(.dialog-title svg) { color: var(--text-3); flex: none; }
  :global(.dialog-description) { margin-top: 4px; color: var(--text-2); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  :global(.close-details) { width: 36px; flex: none; padding: 0; }
  .dialog-toolbar { display: flex; flex: none; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding: 0 24px 16px; border-bottom: 1px solid var(--line); }
  .dialog-scroll { min-height: 0; padding: 20px 24px 28px; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
  .snapshot-status { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 16px; margin-bottom: 16px; }
  .status-badge { display: inline-flex; gap: 8px; align-items: center; color: var(--text-2); font-size: 12px; }
  .snapshot-status p { color: var(--text-3); font-size: 12px; }
  .snapshot-status .error-message { color: var(--warning); }
  .snapshot-hint, .json-hint { margin: 0 0 16px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .traffic-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 16px 0 20px; border-block: 1px solid var(--line); }
  .traffic-metrics > div { min-width: 0; padding: 0 16px; }
  .traffic-metrics > div:first-child { padding-left: 0; }
  .traffic-metrics > div + div { border-left: 1px solid var(--line); }
  .traffic-metrics > div > span { display: block; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .traffic-metrics strong { display: block; margin-top: 8px; font-size: 20px; font-weight: 500; line-height: 28px; overflow-wrap: anywhere; }
  .traffic-metrics small { display: block; margin-top: 4px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .down { color: var(--traffic-down-ink); }
  .up { color: var(--traffic-up-ink); }
  .core-rates { margin-top: 16px; }
  .detail-section { margin-top: 24px; }
  .detail-section + .detail-section { padding-top: 24px; border-top: 1px solid var(--line); }
  h3 { margin-bottom: 16px; font-size: 14px; font-weight: 500; line-height: 20px; }
  .detail-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 28px; }
  .detail-fields > div { min-width: 0; }
  dt, .route-label { color: var(--text-3); font-size: 12px; line-height: 20px; }
  dd { margin-top: 4px; color: var(--text-2); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  dd.font-mono { font-size: 12px; }
  .route-chain { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; margin: 8px 0 16px; }
  .route-chain li { display: flex; min-width: 0; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; }
  .route-chain li > div { min-width: 0; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--raised); overflow-wrap: anywhere; }
  .route-chain :global(svg) { flex: none; color: var(--text-3); }
  .route-chain small { display: block; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .gap-hint { margin-top: 16px; margin-bottom: 0; }
  .connection-json { margin: 0; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--deep); color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 20px; tab-size: 2; }
  @media (max-width: 639px) {
    :global(.connection-dialog) { width: calc(100vw - 16px); max-height: calc(100dvh - 24px); }
    .dialog-header { gap: 8px; padding: 16px 16px 12px; }
    :global(.close-details) { width: 44px; height: 44px; }
    .dialog-toolbar { padding: 0 16px 16px; }
    .dialog-scroll { padding: 16px; }
    .traffic-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 0; }
    .traffic-metrics > div:nth-child(odd) { padding-left: 0; border-left: 0; }
    .detail-fields { grid-template-columns: minmax(0, 1fr); gap: 16px; }
    .connection-json { padding: 12px; }
  }
</style>
