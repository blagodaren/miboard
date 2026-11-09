<script lang="ts">
  import { onDestroy } from 'svelte'
  import { request, errorMessage, type Backend, type ProxyProvider } from '../lib/api'
  import { providerSubscription, providerUpdatedAt, visibleProxyProviders, updateProxyProvider, ProviderRefreshError } from '../lib/provider-tools'
  import { bytes } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconChevron } from '../lib/icons'
  import Button from './Button.svelte'

  let { backend, providers, loadError, disabled = false, onreload, onbusy }: {
    backend: Backend
    providers: Record<string, ProxyProvider>
    loadError: string | null
    disabled?: boolean
    onreload: (signal?: AbortSignal) => Promise<boolean>
    onbusy: (busy: boolean) => void
  } = $props()

  let active = true
  const jobs = new Map<string, AbortController>()
  let pending = $state<Record<string, boolean>>({})
  let failures = $state<Record<string, string>>({})
  let updated = $state<Record<string, boolean>>({})
  let reloading = $state(false)
  const rows = $derived(visibleProxyProviders(providers))
  const dateTime = (timestamp: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(timestamp)
  const date = (timestamp: number) => new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium' }).format(timestamp)

  async function update(name: string) {
    const key = JSON.stringify(name)
    if (!active || disabled || jobs.size || pending[key] || reloading) return
    const session = { ...backend }
    const controller = new AbortController()
    jobs.set(key, controller)
    pending[key] = true
    delete failures[key]
    delete updated[key]
    onbusy(true)
    try {
      await updateProxyProvider(name, (path, init) => request(path, init, session), onreload, controller.signal)
      if (active && !controller.signal.aborted) updated[key] = true
    } catch (error) {
      if (active && !controller.signal.aborted) failures[key] = error instanceof ProviderRefreshError ? t('providers.reloadFailed') : errorMessage(error)
    } finally {
      jobs.delete(key)
      if (active) { delete pending[key]; onbusy(jobs.size > 0) }
    }
  }

  async function reload() {
    if (!active || disabled || jobs.size || reloading) return
    const controller = new AbortController()
    jobs.set('reload', controller)
    reloading = true
    onbusy(true)
    try { await onreload(controller.signal) }
    finally {
      jobs.delete('reload')
      if (active) { reloading = false; onbusy(false) }
    }
  }

  onDestroy(() => {
    active = false
    for (const controller of jobs.values()) controller.abort()
    jobs.clear()
    onbusy(false)
  })
</script>

<details class="group min-w-0 rounded-panel border border-line bg-card" data-testid="proxy-providers">
  <summary class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] marker:content-none">
    <IconChevron class="size-4 shrink-0 -rotate-90 text-fg-3 transition-transform group-open:rotate-0" strokeWidth={1.5} />
    <span>{t('providers.title')}</span><span class="ml-auto font-mono text-xs text-fg-3">{rows.length}</span>
  </summary>
  <div class="border-t border-line">
    {#if loadError}
      <div class="space-y-2 p-4 text-xs" role="status">
        <p class="text-fg-2">{t('providers.unavailable')}</p>
        <p class="break-words text-fg-3">{loadError}</p>
        <Button size="sm" disabled={disabled || reloading || Object.keys(pending).length > 0} onclick={reload}>{t('providers.retry')}</Button>
      </div>
    {/if}
    {#each rows as row (row.name)}
      {@const key = JSON.stringify(row.name)}
      {@const subscription = providerSubscription(row.provider.subscriptionInfo)}
      {@const timestamp = providerUpdatedAt(row.provider.updatedAt)}
      <section class="space-y-3 border-t border-line p-4 first:border-t-0" data-provider={row.name}>
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <h3 class="break-words text-[13px] font-medium">{row.name}</h3>
            <p class="mt-1 text-xs text-fg-3">{row.provider.vehicleType ?? row.provider.type ?? t('providers.unknownType')} · {t('providers.nodes', { count: row.provider.proxies?.length ?? 0 })}</p>
          </div>
          <Button size="sm" disabled={disabled || Object.keys(pending).length > 0 || reloading} aria-label={t('providers.refreshNamed', { name: row.name })} aria-busy={!!pending[key]} onclick={() => update(row.name)}>{t(pending[key] ? 'providers.updating' : 'providers.refresh')}</Button>
        </div>
        <p class="text-xs text-fg-3">{timestamp === null ? t('providers.updateUnknown') : t('providers.updated', { time: dateTime(timestamp) })}</p>
        {#if subscription}
          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {#if subscription.download !== null}<div><dt class="text-fg-3">{t('providers.download')}</dt><dd class="mt-1 font-mono num">{bytes(subscription.download)}</dd></div>{/if}
            {#if subscription.upload !== null}<div><dt class="text-fg-3">{t('providers.upload')}</dt><dd class="mt-1 font-mono num">{bytes(subscription.upload)}</dd></div>{/if}
            {#if subscription.total !== null}<div><dt class="text-fg-3">{t('providers.total')}</dt><dd class="mt-1 font-mono num">{bytes(subscription.total)}</dd></div>{/if}
            {#if subscription.remaining !== null}<div><dt class="text-fg-3">{t('providers.remaining')}</dt><dd class="mt-1 font-mono num">{bytes(subscription.remaining)}</dd></div>{/if}
          </dl>
          {#if subscription.expiresAt !== null}<p class="text-xs" class:text-warning={subscription.expiresAt <= Date.now()}>{t(subscription.expiresAt <= Date.now() ? 'providers.expired' : 'providers.expires', { date: date(subscription.expiresAt) })}</p>{/if}
        {/if}
        {#if failures[key]}<p class="break-words text-xs text-bad" role="alert">{t('providers.refreshFailed', { message: failures[key] })}</p>
        {:else if updated[key]}<p class="text-xs text-good" role="status">{t('providers.updatedNow')}</p>{/if}
      </section>
    {:else}
      {#if !loadError}<p class="p-4 text-xs text-fg-3">{t('providers.empty')}</p>{/if}
    {/each}
  </div>
</details>
