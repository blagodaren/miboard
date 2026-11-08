<script lang="ts">
  import { ApiError, errorMessage, type RuleProvider } from '../lib/api'
  import { count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import Button from './Button.svelte'
  import SearchInput from './SearchInput.svelte'

  let { name, provider, loading, error, onretry }: {
    name: string
    provider?: RuleProvider
    loading: boolean
    error: Error | null
    onretry: () => void
  } = $props()

  const LIMIT = 200
  let query = $state('')
  const inline = $derived(provider?.vehicleType?.toLowerCase() === 'inline')
  const hasPayload = $derived(Array.isArray(provider?.payload))
  const entries = $derived((Array.isArray(provider?.payload) ? provider.payload : []).filter((value) => typeof value === 'string').map((value, index) => ({ value, index, search: value.toLowerCase() })))
  const filtered = $derived.by(() => {
    const search = query.trim().toLowerCase()
    return search ? entries.filter((entry) => entry.search.includes(search)) : entries
  })
  const updatedAt = $derived.by(() => {
    if (!provider?.updatedAt) return null
    const date = new Date(provider.updatedAt)
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1 ? date : null
  })
  const dateFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium', timeStyle: 'short' }))
  const source = $derived.by(() => {
    switch (provider?.vehicleType?.toLowerCase()) {
      case 'http': return 'HTTP'
      case 'file': return t('rules.sourceFile')
      case 'inline': return t('rules.sourceInline')
      default: return provider?.vehicleType || t('rules.unavailable')
    }
  })
  const behavior = $derived.by(() => {
    switch (provider?.behavior?.toLowerCase()) {
      case 'domain': return t('rules.behaviorDomain')
      case 'ipcidr': return t('rules.behaviorIP')
      case 'classical': return t('rules.behaviorClassical')
      default: return provider?.behavior || t('rules.unavailable')
    }
  })
</script>

<section class="border-t border-line bg-raised px-4 py-4 sm:px-5" aria-label={t('rules.setTitle', { name })} aria-busy={loading}>
  {#if loading}
    <p class="text-[13px] text-fg-2" role="status">{t('rules.providerLoading')}</p>
  {:else if error}
    <p class="text-[13px] text-bad" role="alert">{error instanceof ApiError && [404, 405, 501].includes(error.status) ? t('rules.providerUnsupported') : t('rules.providerError', { message: errorMessage(error) })}</p>
    <Button class="mt-3" variant="secondary" size="sm" onclick={onretry}>{t('rules.retry')}</Button>
  {:else if !provider}
    <p class="text-[13px] text-fg-2" role="status">{t('rules.providerMissing')}</p>
    <Button class="mt-3" variant="secondary" size="sm" onclick={onretry}>{t('rules.retry')}</Button>
  {:else}
    <h2 class="break-all text-[13px] font-medium">{t('rules.setTitle', { name: provider.name || name })}</h2>
    <dl class="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
      <div class="min-w-0"><dt class="text-xs text-fg-3">{t('rules.source')}</dt><dd class="mt-1 break-words text-fg-2">{source}</dd></div>
      <div class="min-w-0"><dt class="text-xs text-fg-3">{t('rules.behavior')}</dt><dd class="mt-1 break-words text-fg-2">{behavior}</dd></div>
      <div class="min-w-0"><dt class="text-xs text-fg-3">{t('rules.ruleCount')}</dt><dd class="num mt-1 font-mono text-fg-2">{Number.isFinite(provider.ruleCount) && provider.ruleCount >= 0 ? count(provider.ruleCount) : t('rules.unavailable')}</dd></div>
      <div class="min-w-0"><dt class="text-xs text-fg-3">{t('rules.format')}</dt><dd class="mt-1 break-words font-mono text-fg-2">{provider.format || t('rules.unavailable')}</dd></div>
      <div class="min-w-0"><dt class="text-xs text-fg-3">{t('rules.updatedAt')}</dt><dd class="mt-1 text-fg-2">{#if updatedAt}<time datetime={provider.updatedAt}>{dateFormat.format(updatedAt)}</time>{:else}{t('rules.unavailable')}{/if}</dd></div>
    </dl>

    {#if inline}
      <div class="mt-5 border-t border-line pt-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-[13px] font-medium">{t('rules.inlineRules')}</h3>
          {#if hasPayload || provider.ruleCount === 0}<span class="num font-mono text-xs text-fg-3" role="status">{t('rules.inlineMatches', { matched: filtered.length, total: entries.length })}</span>{/if}
        </div>
        {#if hasPayload && entries.length}
          <div class="mt-3"><SearchInput bind:value={query} placeholder={t('rules.inlineSearch')} /></div>
          {#if filtered.length}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus lets users scroll the bounded list with arrow and PageDown keys.) -->
            <ul class="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line bg-card" aria-label={t('rules.inlineRules')} tabindex="0">
              {#each filtered.slice(0, LIMIT) as entry (entry.index)}
                <li class="flex gap-3 border-b border-line px-3 py-2 last:border-0">
                  <span class="num w-8 shrink-0 text-right font-mono text-xs leading-5 text-fg-3" aria-hidden="true">{count(entry.index + 1)}</span>
                  <span class="min-w-0 break-all font-mono text-xs leading-5 text-fg-2">{entry.value}</span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="mt-3 py-3 text-[13px] text-fg-2" role="status">{t('rules.inlineNoResults')}</p>
          {/if}
          {#if filtered.length > LIMIT}
            <p class="mt-2 text-xs leading-5 text-fg-3">{t('rules.inlineLimit', { limit: count(LIMIT) })}</p>
          {/if}
        {:else}
          <p class="mt-3 text-[13px] text-fg-2">{hasPayload || provider.ruleCount === 0 ? t('rules.inlineEmpty') : t('rules.inlineMissing')}</p>
        {/if}
      </div>
    {:else}
      <p class="mt-5 max-w-2xl text-[13px] leading-5 text-fg-3">{t('rules.externalContent')}</p>
    {/if}
  {/if}
</section>
