<script lang="ts">
  import { onDestroy } from 'svelte'
  import { request, errorMessage, type Backend, type ProxyProvider, type Proxy } from '../lib/api'
  import { providerSubscription, providerUpdatedAt, providerHealthSummary, providerQuotaStatus, visibleProxyProviders, updateProxyProvider, healthCheckProxyProvider, ProviderRefreshError, ProviderHealthRefreshError } from '../lib/provider-tools'
  import { bytes } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { core } from '../lib/core.svelte'
  import { IconChevron, IconRefresh } from '../lib/icons'
  import Button from './Button.svelte'
  import SearchInput from './SearchInput.svelte'
  import ProviderNodes from './ProviderNodes.svelte'

  let { backend, providers, loadError, disabled = false, loading = false, onreload, onbusy, oninspect }: {
    backend: Backend
    providers: Record<string, ProxyProvider>
    loadError: string | null
    disabled?: boolean
    loading?: boolean
    onreload: (signal?: AbortSignal) => Promise<boolean>
    onbusy: (busy: boolean) => void
    oninspect: (node: Proxy, provider: ProxyProvider, providerName: string) => void
  } = $props()

  let active = true
  let controller: AbortController | null = null
  let action = $state<'update' | 'health' | 'batch' | 'reload' | null>(null)
  let activeName = $state('')
  let query = $state('')
  let expanded = $state<Record<string, boolean>>({})
  let batchProgress = $state({ done: 0, total: 0 })
  let batchRunning = $state<string[]>([])
  let staleAfterCancel = $state(false)
  const rows = $derived(visibleProxyProviders(providers))
  const filtered = $derived(rows.filter(row => [row.name, row.provider.vehicleType ?? ''].join(' ').toLocaleLowerCase(i18n.intlLocale).includes(query.trim().toLocaleLowerCase(i18n.intlLocale))))
  const ownBusy = $derived(action !== null)
  const locked = $derived(disabled || loading || ownBusy)
  const dateTime = (timestamp: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
  const date = (timestamp: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium' }).format(timestamp)
  const keyFor = (name: string) => JSON.stringify(name)
  const healthConfigured = (provider: ProxyProvider) => typeof provider.testUrl !== 'string' || !!provider.testUrl.trim()

  function begin(kind: NonNullable<typeof action>, name = '') {
    if (!active || locked) return null
    const session = { ...backend }
    if (core.backend.url !== session.url || core.backend.secret !== session.secret) return null
    const abort = new AbortController()
    controller = abort
    action = kind
    activeName = name
    onbusy(true)
    const current = () => active && !abort.signal.aborted && core.backend.url === session.url && core.backend.secret === session.secret
    return { session, abort, current }
  }
  function finish(abort: AbortController) {
    if (controller !== abort) return
    controller = null
    if (active) { action = null; activeName = ''; batchRunning = []; onbusy(false) }
  }
  async function operate(name: string, kind: 'update' | 'health') {
    if (kind === 'health' && providers[name] && !healthConfigured(providers[name])) return
    const job = begin(kind, name)
    if (!job) return
    const { session, abort, current } = job
    const noticeId = `proxy-provider:${JSON.stringify([session.url, name])}`
    notifications.dismiss(noticeId)
    const refresh = async (signal: AbortSignal) => {
      const loaded = await onreload(signal)
      if (current() && loaded) staleAfterCancel = false
      return loaded
    }
    try {
      if (kind === 'health') await healthCheckProxyProvider(name, (path, init) => request(path, { ...init, timeout: 180000 }, session), refresh, abort.signal)
      else await updateProxyProvider(name, (path, init) => request(path, { ...init, timeout: 30000 }, session), refresh, abort.signal)
      if (current()) notifications.show({ id: noticeId, tone: 'success', title: name, scope: session.url,
        message: () => t(kind === 'health' ? 'providers.healthDone' : 'providers.updatedNow'), testId: 'proxy-provider-notice' })
    } catch (error) {
      if (current()) notifications.show({ id: noticeId, tone: 'error', title: name, scope: session.url,
        message: () => error instanceof ProviderRefreshError ? t('providers.reloadFailed')
          : error instanceof ProviderHealthRefreshError ? t('providers.healthReloadFailed')
          : t(kind === 'health' ? 'providers.healthFailed' : 'providers.refreshFailed', { message: errorMessage(error) }), testId: 'proxy-provider-notice' })
    } finally { finish(abort) }
  }
  async function reload() {
    const job = begin('reload')
    if (!job) return
    const { session, abort, current } = job
    try {
      const loaded = await onreload(abort.signal)
      if (current() && loaded) staleAfterCancel = false
      if (current() && !loaded) notifications.show({ id: 'proxy-providers:reload', tone: 'error', scope: session.url,
        message: () => t('providers.reloadListFailed'), testId: 'proxy-provider-notice' })
    } catch (error) {
      if (current()) notifications.show({ id: 'proxy-providers:reload', tone: 'error', scope: session.url,
        message: () => errorMessage(error), testId: 'proxy-provider-notice' })
    } finally { finish(abort) }
  }
  async function updateAll() {
    const names = rows.map(row => row.name)
    if (!names.length) return
    const job = begin('batch')
    if (!job) return
    const { session, abort } = job
    const current = () => active && core.backend.url === session.url && core.backend.secret === session.secret
    const noticeId = `proxy-providers:batch:${session.url}`
    notifications.dismiss(noticeId)
    batchProgress = { done: 0, total: names.length }
    const succeeded: string[] = []
    const failed: Array<{ name: string; error: unknown }> = []
    let index = 0
    let refreshed = true
    const worker = async () => {
      while (current() && !abort.signal.aborted && index < names.length) {
        const name = names[index++]
        batchRunning = [...batchRunning, name]
        try {
          await request(`/providers/proxies/${encodeURIComponent(name)}`, { method: 'PUT', signal: abort.signal, timeout: 30000 }, session)
          if (current() && !abort.signal.aborted) succeeded.push(name)
        } catch (error) {
          if (current() && !abort.signal.aborted) failed.push({ name, error })
        } finally {
          if (active) {
            batchRunning = batchRunning.filter(item => item !== name)
            batchProgress = { done: succeeded.length + failed.length, total: names.length }
          }
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(2, names.length) }, worker))
      if (current() && !abort.signal.aborted && succeeded.length) {
        try { refreshed = await onreload(abort.signal) } catch { refreshed = false }
        if (current() && !abort.signal.aborted && refreshed) staleAfterCancel = false
      }
      if (current()) {
        const cancelled = abort.signal.aborted
        notifications.show({ id: noticeId, tone: cancelled ? 'info' : !succeeded.length && failed.length ? 'error' : failed.length || !refreshed ? 'warning' : 'success',
          title: () => t('providers.updateAll'), scope: session.url, testId: 'proxy-provider-batch-notice',
          message: () => t(cancelled ? 'providers.batchCancelled' : 'providers.batchDone', { done: succeeded.length, failed: failed.length, total: names.length }) + (!cancelled && !refreshed ? ` ${t('providers.reloadListFailed')}` : ''),
          sections: failed.length ? [{ title: () => t('providers.failedProviders'), tone: 'error',
            items: failed.slice(0, 50).map(item => ({ label: item.name, description: () => errorMessage(item.error) })) }] : [],
        })
      }
    } finally { finish(abort) }
  }

  function cancelBatch() {
    staleAfterCancel = true
    controller?.abort()
  }

  onDestroy(() => { active = false; controller?.abort(); controller = null; onbusy(false) })
</script>

<section class="min-w-0 space-y-4" data-testid="proxy-providers" aria-busy={loading || action === 'reload'}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div><h2 class="text-sm font-medium">{t('providers.title')}</h2><p class="mt-1 text-xs text-fg-3">{t('providers.providerResults', { count: filtered.length, total: rows.length })}</p></div>
    <div class="flex max-w-full flex-wrap gap-3">
      <div data-testid="providers-search"><SearchInput bind:value={query} placeholder={t('providers.search')} /></div>
      <Button size="sm" data-testid="providers-reload" disabled={locked} onclick={reload}><IconRefresh strokeWidth={1.5} />{t(action === 'reload' ? 'providers.loading' : 'providers.retry')}</Button>
      <Button size="sm" data-testid="providers-update-all" disabled={locked || !rows.length} onclick={updateAll}>{t('providers.updateAll')}</Button>
      {#if action === 'batch'}<Button size="sm" variant="ghost" data-testid="providers-cancel" onclick={cancelBatch}>{t('providers.cancelBatch')}</Button>{/if}
    </div>
  </div>
  <p class="text-xs leading-5 text-fg-3">{t('providers.healthHint')}</p>
  {#if disabled && !loading && !ownBusy}<p class="text-xs text-fg-3" role="status">{t('providers.otherBusy')}</p>{/if}
  {#if loading}<p class="text-[13px] text-fg-2" role="status">{t('providers.loading')}</p>{/if}
  {#if action === 'batch'}<p class="num text-[13px] text-fg-2" role="status">{t('providers.batchProgress', batchProgress)}</p>{/if}
  {#if staleAfterCancel}<p class="text-xs leading-5 text-fg-3" role="status">{t('providers.cancelStale')}</p>{/if}
  {#if loadError}
    <div class="rounded-card border border-line bg-card p-4 text-[13px]" role="status">
      <p class="text-fg-2">{t('providers.unavailable')}</p><p class="mt-1 break-words text-xs text-fg-3">{loadError}</p>
      {#if rows.length}<p class="mt-2 text-xs text-fg-3">{t('providers.stale')}</p>{/if}
    </div>
  {/if}
  {#each filtered as row (row.name)}
    {@const key = keyFor(row.name)}
    {@const subscription = providerSubscription(row.provider.subscriptionInfo)}
    {@const quota = providerQuotaStatus(row.provider.subscriptionInfo)}
    {@const health = providerHealthSummary(row.provider)}
    {@const timestamp = providerUpdatedAt(row.provider.updatedAt)}
    {@const updating = action === 'update' && activeName === row.name || batchRunning.includes(row.name)}
    {@const checking = action === 'health' && activeName === row.name}
    <section class="min-w-0 rounded-panel border border-line bg-card" data-provider={row.name}>
      <div class="p-4 sm:p-5">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1 basis-52">
            <h3 class="break-words text-sm font-medium [overflow-wrap:anywhere]">{row.name}</h3>
            <p class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-3"><span>{t('providers.source')}: <span class="font-mono text-fg-2">{row.provider.vehicleType || t('providers.unknownType')}</span></span><span>{t('providers.nodes', { count: health.total })}</span></p>
          </div>
          <div class="flex max-w-full flex-wrap gap-2">
            <Button size="sm" data-testid="provider-update" disabled={locked} aria-label={t('providers.refreshNamed', { name: row.name })} aria-busy={updating} onclick={() => operate(row.name, 'update')}>{t(updating ? 'providers.updating' : 'providers.refresh')}</Button>
            <Button size="sm" data-testid="provider-healthcheck" disabled={locked || !health.total || !healthConfigured(row.provider)} aria-label={t('providers.healthNamed', { name: row.name })} aria-busy={checking} onclick={() => operate(row.name, 'health')}>{t(checking ? 'providers.checking' : 'providers.health')}</Button>
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          <span class={health.alive ? 'text-good' : 'text-fg-3'}>{t('providers.aliveCount', { count: health.alive })}</span>
          <span class="text-fg-2">{t('providers.deadCount', { count: health.dead })}</span>
          <span class="text-fg-3">{t('providers.unknownCount', { count: health.unknown })}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-fg-3">
          <p>{timestamp === null ? t('providers.updateUnknown') : t('providers.updated', { time: dateTime(timestamp) })}</p>
          <p>{health.lastCheckedAt === null ? t('providers.measurementUnknown') : t('providers.latestMeasurement', { time: dateTime(health.lastCheckedAt) })}</p>
        </div>
        {#if checking}<p class="mt-3 text-xs text-fg-2" role="status">{t('providers.healthWaiting')}</p>{/if}
        {#if !healthConfigured(row.provider)}<p class="mt-3 text-xs text-fg-3">{t('providers.healthUrlMissing')}</p>{/if}
        {#if subscription}
          <dl class="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-line pt-4 text-xs sm:grid-cols-3">
            <div><dt class="text-fg-3">{t('providers.used')}</dt><dd class="num mt-1 font-mono">{subscription.used === null ? t('providers.notReported') : bytes(subscription.used)}</dd></div>
            <div><dt class="text-fg-3">{t('providers.total')}</dt><dd class="num mt-1 font-mono">{subscription.total === null ? t('providers.notReported') : bytes(subscription.total)}</dd></div>
            <div><dt class="text-fg-3">{t('providers.remaining')}</dt><dd class="num mt-1 font-mono">{subscription.remaining === null ? t('providers.notReported') : bytes(subscription.remaining)}</dd></div>
            {#if subscription.download !== null}<div><dt class="text-fg-3">{t('providers.download')}</dt><dd class="num mt-1 font-mono">{bytes(subscription.download)}</dd></div>{/if}
            {#if subscription.upload !== null}<div><dt class="text-fg-3">{t('providers.upload')}</dt><dd class="num mt-1 font-mono">{bytes(subscription.upload)}</dd></div>{/if}
            {#if subscription.expiresAt !== null}<div><dt class="text-fg-3">{t('providers.expiry')}</dt><dd class="mt-1" class:text-warning={quota.expired === true}>{t(quota.expired ? 'providers.expired' : 'providers.expires', { date: date(subscription.expiresAt) })}</dd></div>{/if}
          </dl>
          {#if quota.ratio !== null}
            <progress class="quota-progress mt-4" max="1" value={quota.ratio} aria-label={t('providers.quotaUsage', { used: bytes(subscription.used!), total: bytes(subscription.total!) })}></progress>
          {/if}
          {#if quota.exhausted}<p class="mt-2 text-xs text-warning">{t('providers.exhausted')}</p>{/if}
        {:else}
          <p class="mt-4 text-xs text-fg-3">{t('providers.subscriptionUnknown')}</p>
        {/if}
      </div>
      <details bind:open={expanded[key]} class="group border-t border-line" data-testid="provider-nodes">
        <summary class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] marker:content-none sm:px-5">
          <IconChevron class="size-4 shrink-0 -rotate-90 text-fg-3 transition-transform group-open:rotate-0" strokeWidth={1.5} aria-hidden="true" />
          <span>{t('providers.showNodes')}</span><span class="num ml-auto font-mono text-xs text-fg-3">{health.total}</span>
        </summary>
        {#if expanded[key]}<ProviderNodes name={row.name} nodes={health.nodes} rawNodes={row.provider.proxies ?? []} oninspect={node => oninspect(node, row.provider, row.name)} />{/if}
      </details>
    </section>
  {:else}
    {#if !loading && (!loadError || rows.length)}<p class="rounded-panel border border-line p-5 text-[13px] text-fg-3">{t(query.trim() && rows.length ? 'providers.noMatching' : 'providers.empty')}</p>{/if}
  {/each}
</section>

<style>
  .quota-progress { display: block; width: 100%; height: 4px; overflow: hidden; border: 0; border-radius: 999px; appearance: none; background: var(--line); }
  .quota-progress::-webkit-progress-bar { background: var(--line); }
  .quota-progress::-webkit-progress-value { background: var(--accent); }
  .quota-progress::-moz-progress-bar { background: var(--accent); }
</style>
