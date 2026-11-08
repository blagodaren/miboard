<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errorMessage, type Rule, type RuleProvider } from '../lib/api'
  import { count } from '../lib/format'
  import { t } from '../lib/i18n.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import RuleSetDetails from '../components/RuleSetDetails.svelte'
  import RulesAnalytics from '../components/RulesAnalytics.svelte'
  import { core } from '../lib/core.svelte'
  import { IconChevron } from '../lib/icons'

  const LIMIT = 500
  let rules = $state.raw<Rule[]>([])
  let query = $state('')
  let error = $state.raw<Error | null>(null)
  let loading = $state(true)
  let viewportWidth = $state(0)
  const columns = $derived(viewportWidth >= 768 ? 4 : viewportWidth >= 640 ? 3 : 2)
  let expanded = $state<number | null>(null)
  let providers = $state.raw<Record<string, RuleProvider> | null>(null)
  let providersLoading = $state(false)
  let providersError = $state.raw<Error | null>(null)

  const isRuleSet = (rule: Rule) => rule.type.replace(/[-_]/g, '').toLowerCase() === 'ruleset'

  async function loadProviders(force = false) {
    if (providersLoading || (providers !== null && !force)) return
    providersLoading = true
    providersError = null
    try {
      providers = (await api.ruleProviders()).providers ?? {}
    } catch (e) {
      providersError = e instanceof Error ? e : new Error(String(e))
    } finally {
      providersLoading = false
    }
  }

  function toggle(rule: Rule, index: number) {
    expanded = expanded === index ? null : index
    if (expanded !== null && isRuleSet(rule)) void loadProviders()
  }

  onMount(async () => {
    try {
      rules = (await api.rules()).rules
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e))
    } finally {
      loading = false
    }
  })

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const indexed = rules.map((r, i) => ({ ...r, i: i + 1 }))
    return q ? indexed.filter((r) => `${r.type} ${r.payload} ${r.proxy}`.toLowerCase().includes(q)) : indexed
  })
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<PageHeader title={t('rules.title')} meta={rules.length ? t('rules.summary', { count: rules.length }) : undefined} />

<RulesAnalytics connections={core.conns} {rules} ready={core.connectionsReady} online={core.connectionsOnline} />

<div class="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
  <h2 class="text-sm font-medium">{t('rules.analytics.configuredRules')}</h2>
  <SearchInput bind:value={query} placeholder={t('rules.search')} />
</div>

{#if error}
  <p class="rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-bad" role="alert">{errorMessage(error)}</p>
{:else if loading}
  <p class="text-fg-3">{t('rules.loading')}</p>
{:else}
  <div class="overflow-x-auto rounded-2xl border border-line bg-card">
    <table class="w-full table-fixed text-[13px]">
      <caption class="sr-only">{t('rules.title')}</caption>
      <thead>
        <tr class="text-left text-xs text-fg-3">
          <th class="hidden w-16 px-4 py-2 text-right font-normal md:table-cell">{t('rules.number')}</th>
          <th class="hidden w-[22%] px-3 py-2 font-normal sm:table-cell">{t('rules.type')}</th>
          <th class="px-3 py-2 font-normal">{t('rules.condition')}</th>
          <th class="w-[32%] px-4 py-2 font-normal sm:w-[24%]">{t('rules.destination')}</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered.slice(0, LIMIT) as r (r.i)}
          <tr class="border-t border-line {expanded === r.i ? 'bg-selected' : 'hover:bg-hover'}">
            <td class="num hidden px-4 py-2 text-right font-mono text-xs text-fg-3 md:table-cell">{count(r.i)}</td>
            <td class="hidden truncate px-3 py-2 font-mono text-xs text-fg-2 sm:table-cell" title={r.type}>{r.type}</td>
            <td class="px-3 py-2" title={r.payload}>
              {#if isRuleSet(r)}
                <button class="flex min-h-11 w-full items-center gap-2 rounded-md text-left transition-colors hover:bg-raised hover:text-accent-ink" aria-expanded={expanded === r.i} aria-controls="rules-details-{r.i}" aria-label={t(expanded === r.i ? 'rules.collapseSet' : 'rules.expandSet', { name: r.payload })} onclick={() => toggle(r, r.i)}>
                  <IconChevron class="size-4 shrink-0 transition-transform motion-reduce:transition-none {expanded === r.i ? 'rotate-180' : ''}" strokeWidth={1.5} />
                  <span class="min-w-0 truncate">{r.payload || '—'}</span>
                </button>
              {:else}
                <span class="block truncate">{r.payload || '—'}</span>
                {#if r.size && r.size > 0}<span class="num font-mono text-xs text-fg-3">{count(r.size)}</span>{/if}
              {/if}
              <span class="block truncate font-mono text-xs text-fg-3 sm:hidden">{r.type}</span>
            </td>
            <td class="truncate px-4 py-2 text-fg-2" title={r.proxy}>{r.proxy}</td>
          </tr>
          {#if isRuleSet(r)}
            <tr id="rules-details-{r.i}" hidden={expanded !== r.i}>
              <td colspan={columns} class="p-0">
                {#if expanded === r.i}
                  <RuleSetDetails name={r.payload} provider={providers && Object.hasOwn(providers, r.payload) ? providers[r.payload] : undefined} loading={providersLoading} error={providersError} onretry={() => void loadProviders(true)} />
                {/if}
              </td>
            </tr>
          {/if}
        {:else}
          <tr class="border-t border-line"><td colspan={columns} class="px-4 py-8 text-center text-fg-3">{t('rules.noResults')}</td></tr>
        {/each}
      </tbody>
    </table>
    {#if filtered.length > LIMIT}
      <p class="border-t border-line px-4 py-3 font-mono text-xs text-fg-3">{t('rules.limit', { limit: count(LIMIT) })}</p>
    {/if}
  </div>
{/if}
