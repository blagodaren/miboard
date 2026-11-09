<script lang="ts">
  import { ApiError, errorMessage, type RuleProvider } from '../lib/api'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconRefresh } from '../lib/icons'
  import { orderedRuleProviders, ruleProviderUpdateTargets } from '../lib/rule-provider-tools'
  import Button from './Button.svelte'
  import SearchInput from './SearchInput.svelte'
  import RuleSetDetails from './RuleSetDetails.svelte'

  let { providers, loading, error, busy, updates, batch, retryCount, resumeCount, query = $bindable(''), onreload, onupdate, onupdateall, oncancel, onretryfailed, onresume }: {
    providers: Record<string, RuleProvider> | null
    loading: boolean
    error: Error | null
    busy: boolean
    updates: Record<string, { busy: boolean; error: Error | null; updated: boolean; reloadOnly: boolean }>
    batch: { running: boolean; completed: number; total: number; succeeded: number; failed: number; refreshing: boolean; reloadFailed: boolean; failedNames: string[]; cancelled: boolean; interrupted: number; pending: number } | null
    retryCount: number
    resumeCount: number
    query?: string
    onreload: () => void
    onupdate: (name: string) => void
    onupdateall: () => void
    oncancel: () => void
    onretryfailed: () => void
    onresume: () => void
  } = $props()

  const rows = $derived(orderedRuleProviders(providers))
  const updateCount = $derived(ruleProviderUpdateTargets(providers).length)
  const locked = $derived(loading || busy || !!batch?.running)
  const filtered = $derived.by(() => {
    const search = query.trim().toLocaleLowerCase(i18n.intlLocale)
    return search ? rows.filter(([name, provider]) => [name, provider.vehicleType, provider.behavior, provider.format].join(' ').toLocaleLowerCase(i18n.intlLocale).includes(search)) : rows
  })
</script>

<section class="min-w-0 space-y-4" data-testid="rule-providers" aria-busy={loading}>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-sm font-medium">{t('rules.providers.title')}</h2>
      {#if providers !== null}<p class="mt-1 text-xs text-fg-3">{t('rules.providers.results', { count: filtered.length, total: rows.length })}</p>{/if}
    </div>
    <div class="flex max-w-full flex-wrap items-center gap-3">
      <SearchInput bind:value={query} placeholder={t('rules.providers.search')} />
      {#if query}<Button size="sm" variant="ghost" onclick={() => { query = '' }}>{t('rules.providers.clearSearch')}</Button>{/if}
      <Button size="sm" disabled={locked} onclick={onreload}>
        <IconRefresh size={14} strokeWidth={1.5} class={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
        {t('rules.providers.reload')}
      </Button>
      <Button size="sm" variant="secondary" disabled={locked || !updateCount} onclick={onupdateall} data-testid="rule-providers-update-all" title={t('rules.providers.updateAllHint')}>
        <IconRefresh size={14} strokeWidth={1.5} class={batch?.running ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
        {t('rules.providers.updateAll')}
      </Button>
    </div>
  </div>
  {#if batch}
    <div class="space-y-2 rounded-card border border-line bg-card px-4 py-3" data-testid="rule-provider-batch">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="num text-[13px] text-fg-2" role="status">
          {t(batch.running ? batch.cancelled ? 'rules.providers.batchCancelling' : batch.refreshing ? 'rules.providers.batchRefreshing' : 'rules.providers.batchProgress' : batch.cancelled ? 'rules.providers.batchCancelled' : batch.failed ? 'rules.providers.batchFailed' : 'rules.providers.batchDone', { done: batch.running ? batch.completed : batch.succeeded, total: batch.total, failed: batch.failed })}
        </p>
        {#if batch.running}
          <Button size="sm" variant="secondary" disabled={batch.cancelled} onclick={oncancel} data-testid="rule-providers-cancel">{t('rules.providers.cancel')}</Button>
        {:else}
          <div class="flex flex-wrap gap-2">
            {#if resumeCount}<Button size="sm" variant="secondary" disabled={locked} onclick={onresume} data-testid="rule-providers-resume" title={t('rules.providers.resumeHint', { count: resumeCount })}>{t('rules.providers.resume')}</Button>{/if}
            {#if retryCount}<Button size="sm" variant="secondary" disabled={locked} onclick={onretryfailed} data-testid="rule-providers-retry-failed" title={t('rules.providers.retryFailedHint', { count: retryCount })}>{t('rules.providers.retryFailed')}</Button>{/if}
          </div>
        {/if}
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-raised" role="progressbar" aria-label={t('rules.providers.batchProgressLabel')} aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.completed}>
        <div class="h-full origin-left rounded-full bg-accent" style:transform="scaleX({batch.completed / batch.total})"></div>
      </div>
      {#if batch.failedNames.length}<p class="break-words text-xs text-bad">{t('rules.providers.batchFailedNames', { names: batch.failedNames.join(', ') })}</p>{/if}
      {#if batch.cancelled && !batch.running}
        <p class="num text-xs text-fg-2">{t('rules.providers.batchRemaining', { interrupted: batch.interrupted, pending: batch.pending })}</p>
        <p class="text-xs leading-5 text-fg-3">{t('rules.providers.batchCancelHint')}</p>
      {/if}
      {#if batch.reloadFailed}<p class="text-xs text-bad" role="alert">{t('rules.providers.batchReloadFailed')}</p>{/if}
    </div>
  {/if}
  {#if loading}<p class="text-[13px] text-fg-2" role="status">{t('rules.providers.loading')}</p>{/if}
  {#if error}
    <div class="rounded-card border border-bad-border bg-bad-surface px-4 py-3">
      <p class="text-[13px] text-bad" role="alert">{error instanceof ApiError && [404, 405, 501].includes(error.status) ? t('rules.providerUnsupported') : t('rules.providers.error', { message: errorMessage(error) })}</p>
      <Button class="mt-3" variant="secondary" size="sm" disabled={locked} onclick={onreload}>{t('rules.retry')}</Button>
    </div>
  {/if}
  {#if filtered.length}
    <div class="grid min-w-0 grid-cols-1 items-start gap-4 xl:grid-cols-2">
      {#each filtered as [name, provider], index (name)}
        {@const update = Object.hasOwn(updates, name) ? updates[name] : undefined}
        <div class="min-w-0 {provider.vehicleType?.toLowerCase() === 'inline' && (index === 0 || filtered[index - 1][1].vehicleType?.toLowerCase() !== 'inline') ? 'xl:col-start-1' : ''}">
        <RuleSetDetails {name} {provider} standalone loading={false} error={null} onretry={onreload} disabled={loading || !!batch?.running}
          updating={update?.busy ?? false} updateError={update?.error ?? null} updated={update?.updated ?? false} reloadOnly={update?.reloadOnly ?? false} onupdate={() => onupdate(name)} />
        </div>
      {/each}
    </div>
  {:else if !loading && !error}
    <p class="rounded-card border border-line bg-card px-4 py-10 text-center text-[13px] text-fg-3" role="status">{t(rows.length ? 'rules.providers.noResults' : 'rules.providers.empty')}</p>
  {/if}
</section>
