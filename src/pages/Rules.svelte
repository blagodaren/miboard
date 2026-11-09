<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Tabs } from 'bits-ui'
  import { api, errorMessage, type Rule, type RuleProvider } from '../lib/api'
  import { count } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import RuleProviders from '../components/RuleProviders.svelte'
  import RulesAnalytics from '../components/RulesAnalytics.svelte'
  import Button from '../components/Button.svelte'
  import { currentRuleForToggle, orderedRules, ruleIndex, ruleStats, type RuleSort } from '../lib/rule-status'
  import { canUpdateRuleProvider, ruleProviderUpdateTargets } from '../lib/rule-provider-tools'
  import { runRuleProviderBatch, remainingRuleProviderNames } from '../lib/rule-provider-batch'
  import { core } from '../lib/core.svelte'
  import { IconChevron } from '../lib/icons'

  const LIMIT = 500
  type RuleTab = 'rules' | 'providers'
  const tabFromHash = (): RuleTab => new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab') === 'providers' ? 'providers' : 'rules'
  let tab = $state<RuleTab>(tabFromHash())
  let providerQuery = $state('')
  let rules = $state.raw<Rule[]>([])
  let query = $state('')
  let error = $state.raw<Error | null>(null)
  let loading = $state(true)
  let sort = $state<RuleSort>('config')
  let changing = $state<number | null>(null)
  let ruleActionError = $state('')
  let ruleActionDone = $state(false)
  let stateUncertain = $state(false)
  let loadSequence = 0
  let viewportWidth = $state(0)
  const columns = $derived(viewportWidth >= 768 ? 4 : viewportWidth >= 640 ? 3 : 2)
  let expanded = $state<number | null>(null)
  let providers = $state.raw<Record<string, RuleProvider> | null>(null)
  let providersLoading = $state(false)
  let providersError = $state.raw<Error | null>(null)
  type ProviderUpdate = { busy: boolean; error: Error | null; updated: boolean; reloadOnly: boolean }
  let providerUpdates = $state.raw<Record<string, ProviderUpdate>>({})
  let providerBatch = $state<{
    running: boolean; completed: number; total: number; succeeded: number; failed: number
    refreshing: boolean; reloadFailed: boolean; failedNames: string[]
    cancelled: boolean; interrupted: number; pending: number
  } | null>(null)
  let providerBatchController: AbortController | null = null
  // Keep known errors that a cancelled retry has not reached yet.
  let providerRetryNames = $state.raw<string[]>([])
  let providerResumeNames = $state.raw<string[]>([])
  const retryableProviderNames = $derived(ruleProviderUpdateTargets(providers).filter(name => providerRetryNames.includes(name) && !!updateState(name)?.error && !updateState(name)?.reloadOnly))
  const remainingProviderNames = $derived(ruleProviderUpdateTargets(providers).filter(name => providerResumeNames.includes(name)))
  const providersBusy = $derived(Object.values(providerUpdates).some(update => update.busy))
  const providerCount = $derived(Object.keys(providers ?? {}).length)
  const backend = { ...core.backend }
  const controller = new AbortController()
  let disposed = false
  const current = () => !disposed && core.backend.url === backend.url && core.backend.secret === backend.secret
  const hasStats = $derived(rules.some(rule => ruleStats(rule) !== null))
  const dateTime = (timestamp: number | null) => timestamp === null ? '—' : new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }).format(timestamp)
  const updateState = (name: string) => Object.hasOwn(providerUpdates, name) ? providerUpdates[name] : undefined
  function setUpdate(name: string, state: ProviderUpdate) {
    if (current()) providerUpdates = { ...providerUpdates, [name]: state }
  }

  const isRuleSet = (rule: Rule) => rule.type.replace(/[-_]/g, '').toLowerCase() === 'ruleset'

  async function loadProviders(force = false) {
    if (!current() || providersLoading || providersBusy || providerBatch?.running || (providers !== null && !force)) return
    providersLoading = true
    providersError = null
    try {
      const result = (await api.ruleProviders(backend, controller.signal)).providers ?? {}
      if (current()) {
        providers = result
        providerRetryNames = providerRetryNames.filter(name => Object.hasOwn(result, name))
        providerResumeNames = providerResumeNames.filter(name => Object.hasOwn(result, name) && canUpdateRuleProvider(result[name]))
        // A list refresh also completes an earlier update whose readback failed.
        providerUpdates = Object.fromEntries(Object.entries(providerUpdates)
          .filter(([name]) => Object.hasOwn(result, name))
          .map(([name, update]) => [name, update.reloadOnly
            ? { busy: false, error: null, updated: true, reloadOnly: false }
            : update]))
        if (providerBatch?.reloadFailed) providerBatch = { ...providerBatch, reloadFailed: false }
      }
    } catch (e) {
      if (current()) providersError = e instanceof Error ? e : new Error(String(e))
    } finally {
      if (current()) providersLoading = false
    }
  }

  async function updateProvider(name: string) {
    const previous = updateState(name)
    const provider = providers && Object.hasOwn(providers, name) ? providers[name] : undefined
    if (!current() || providersLoading || providerBatch?.running || previous?.busy || !canUpdateRuleProvider(provider)) return
    let updated = previous?.reloadOnly ?? false
    setUpdate(name, { busy: true, error: null, updated: false, reloadOnly: updated })
    try {
      if (!updated) await api.updateRuleProvider(name, backend, controller.signal)
      updated = true
      if (!current()) return
      // A confirmed update is complete even if its following metadata GET fails.
      providerResumeNames = providerResumeNames.filter(candidate => candidate !== name)
      // Mihomo exposes metadata only through the complete provider list.
      const result = (await api.ruleProviders(backend, controller.signal)).providers ?? {}
      if (!Object.hasOwn(result, name)) throw new Error(t('rules.providerMissing'))
      if (!current()) return
      // Other providers may be updating concurrently: replace only this result.
      providers = { ...providers, [name]: result[name] }
      providersError = null
      setUpdate(name, { busy: false, error: null, updated: true, reloadOnly: false })
      providerRetryNames = providerRetryNames.filter(candidate => candidate !== name)
      if (providerBatch?.reloadFailed) providerBatch = { ...providerBatch, reloadFailed: Object.values(providerUpdates).some(update => update.reloadOnly) }
    } catch (e) {
      setUpdate(name, { busy: false, error: e instanceof Error ? e : new Error(String(e)), updated: false, reloadOnly: updated })
    }
  }

  function cancelProviderBatch() {
    if (!providerBatch?.running || !providerBatchController) return
    providerBatch = { ...providerBatch, cancelled: true }
    providerBatchController.abort()
  }

  async function updateAllProviders(mode: 'all' | 'retry' | 'resume' = 'all') {
    if (!current() || providersLoading || providersBusy || providerBatch?.running) return
    // Snapshot the whole list: filtering the view must not change this action.
    const names = mode === 'retry' ? [...retryableProviderNames] : mode === 'resume' ? [...remainingProviderNames] : ruleProviderUpdateTargets(providers)
    if (!names.length) return
    if (mode === 'all') { providerRetryNames = []; providerResumeNames = [] }
    const batchController = new AbortController()
    providerBatchController = batchController
    const abortBatch = () => batchController.abort()
    controller.signal.addEventListener('abort', abortBatch, { once: true })
    providerBatch = { running: true, completed: 0, total: names.length, succeeded: 0, failed: 0, refreshing: false, reloadFailed: false, failedNames: [], cancelled: false, interrupted: 0, pending: names.length }
    let succeeded: string[] = []
    try {
      const result = await runRuleProviderBatch(names, {
        signal: batchController.signal,
        onStart: (name) => {
          if (current()) providerRetryNames = providerRetryNames.filter(candidate => candidate !== name)
          setUpdate(name, { busy: true, error: null, updated: false, reloadOnly: false })
        },
        update: async (name, signal) => {
          if (!current()) { batchController.abort(); return }
          await api.updateRuleProvider(name, backend, signal)
          if (current() && !signal.aborted) setUpdate(name, { busy: true, error: null, updated: false, reloadOnly: true })
        },
        onProgress: (progress) => {
          if (!current() || !providerBatch) return
          providerRetryNames = [...new Set([...providerRetryNames, ...progress.failed.map(item => item.name)])]
          providerBatch = { ...providerBatch, completed: progress.succeeded.length + progress.failed.length,
            succeeded: progress.succeeded.length, failed: progress.failed.length, failedNames: progress.failed.map(item => item.name),
            cancelled: progress.cancelled, interrupted: progress.interrupted.length, pending: progress.pending.length }
          for (const { name, error: cause } of progress.failed) setUpdate(name, { busy: false, error: cause instanceof Error ? cause : new Error(String(cause)), updated: false, reloadOnly: false })
          for (const name of progress.interrupted) setUpdate(name, { busy: false, error: null, updated: false, reloadOnly: false })
        },
      })
      succeeded = result.succeeded
      if (!current() || !providerBatch) return
      providerResumeNames = remainingRuleProviderNames(providerResumeNames, result)
      if (succeeded.length && !batchController.signal.aborted) {
        providerBatch = { ...providerBatch, refreshing: true }
        try {
          // One readback for the batch, rather than downloading the full list per provider.
          const result = (await api.ruleProviders(backend, batchController.signal)).providers ?? {}
          if (!current() || batchController.signal.aborted) return
          providersError = null
          const refreshed = { ...providers }
          for (const name of succeeded) {
            if (Object.hasOwn(result, name)) {
              refreshed[name] = result[name]
              setUpdate(name, { busy: false, error: null, updated: true, reloadOnly: false })
            } else {
              setUpdate(name, { busy: false, error: new Error(t('rules.providerMissing')), updated: false, reloadOnly: true })
              providerBatch = { ...providerBatch!, reloadFailed: true }
            }
          }
          providers = refreshed
        } catch (cause) {
          if (!current() || batchController.signal.aborted) return
          const error = cause instanceof Error ? cause : new Error(String(cause))
          for (const name of succeeded) setUpdate(name, { busy: false, error, updated: false, reloadOnly: true })
          providerBatch = { ...providerBatch!, reloadFailed: true }
        }
      }
    } finally {
      controller.signal.removeEventListener('abort', abortBatch)
      if (providerBatchController === batchController) providerBatchController = null
      if (current() && providerBatch) {
        if (batchController.signal.aborted) {
          // A confirmed PUT only needs metadata reloading; never repeat it on retry.
          for (const name of succeeded) if (updateState(name)?.busy) setUpdate(name, { busy: false, error: null, updated: false, reloadOnly: true })
          for (const name of names) if (updateState(name)?.busy) setUpdate(name, { busy: false, error: null, updated: false, reloadOnly: false })
        }
        providerBatch = { ...providerBatch, running: false, refreshing: false, cancelled: batchController.signal.aborted }
      }
    }
  }

  function toggle(index: number) {
    expanded = expanded === index ? null : index
  }

  function setTab(next: RuleTab) {
    tab = next
    if (next === 'providers') void loadProviders()
  }

  function changeTab(next: string) {
    if (next !== 'rules' && next !== 'providers') return
    setTab(next)
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
    if (next === 'providers') params.set('tab', 'providers')
    else params.delete('tab')
    const query = params.toString()
    const hash = `#/rules${query ? `?${query}` : ''}`
    if (location.hash !== hash) location.hash = hash
  }

  async function openProvider(name: string) {
    providerQuery = name
    changeTab('providers')
    await tick()
    const trigger = document.getElementById('rules-providers-tab')
    trigger?.focus({ preventScroll: true })
    trigger?.scrollIntoView({ block: 'start' })
  }

  async function loadRules(): Promise<boolean> {
    const sequence = ++loadSequence
    loading = true
    error = null
    try {
      const result = (await api.rules(backend, controller.signal)).rules
      if (!current() || sequence !== loadSequence) return false
      rules = result
      stateUncertain = false
      return true
    } catch (e) {
      if (current() && sequence === loadSequence) error = e instanceof Error ? e : new Error(String(e))
      return false
    } finally {
      if (current() && sequence === loadSequence) loading = false
    }
  }

  async function setRuleEnabled(rule: Rule) {
    const index = ruleIndex(rule)
    const previous = ruleStats(rule)
    if (!current() || changing !== null || loading || stateUncertain || index === null || previous?.disabled == null) return
    const disabled = !previous.disabled
    changing = index
    ruleActionError = ''
    ruleActionDone = false
    try {
      // A configuration may have reloaded since the row was rendered.
      if (!await loadRules()) throw new Error(t('rules.stats.stale'))
      const fresh = currentRuleForToggle(rule, rules)
      if (!fresh) throw new Error(t('rules.stats.configChanged'))
      if (ruleStats(fresh)?.disabled !== disabled) await api.disableRules({ [index]: disabled }, backend, controller.signal)
      if (!current()) return
      if (!await loadRules()) {
        stateUncertain = true
        throw new Error(t('rules.stats.stale'))
      }
      const confirmed = currentRuleForToggle(rule, rules)
      if (!confirmed) throw new Error(t('rules.stats.configChanged'))
      if (ruleStats(confirmed)?.disabled !== disabled) throw new Error(t('rules.stats.notApplied'))
      ruleActionDone = true
    } catch (cause) {
      if (!current()) return
      ruleActionError = t('rules.stats.failed', { message: errorMessage(cause) })
      // Errors can arrive after the server applied a change: re-read authoritative state.
      if (!await loadRules() && current()) stateUncertain = true
    } finally {
      if (current()) changing = null
    }
  }

  function refreshRules() {
    ruleActionError = ''
    ruleActionDone = false
    void loadRules()
  }

  onMount(() => {
    void loadRules()
    if (tab === 'providers') void loadProviders()
    const syncTab = () => {
      if (location.hash.split('?')[0].replace(/^#\/?/, '') === 'rules') setTab(tabFromHash())
    }
    window.addEventListener('hashchange', syncTab)
    return () => { disposed = true; controller.abort(); window.removeEventListener('hashchange', syncTab) }
  })

  const filtered = $derived(orderedRules(rules, sort, query))
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<PageHeader title={t('rules.title')} meta={tab === 'rules' ? rules.length ? t('rules.summary', { count: rules.length }) : undefined : providers === null ? undefined : t('rules.providers.count', { count: providerCount })} />

<Tabs.Root value={tab} onValueChange={changeTab} loop>
  <Tabs.List aria-label={t('rules.tabs.label')} class="mb-5 flex gap-1 border-b border-line">
    <Tabs.Trigger value="rules" class="flex min-h-11 items-center gap-2 border-b-2 border-transparent px-3 text-[13px] text-fg-2 transition-colors hover:text-fg data-[state=active]:border-accent-ink data-[state=active]:font-medium data-[state=active]:text-fg sm:px-4">
      {t('rules.title')}<span class="num font-mono text-xs text-fg-3" aria-hidden="true">{loading && !rules.length ? '…' : count(rules.length)}</span>
    </Tabs.Trigger>
    <Tabs.Trigger id="rules-providers-tab" value="providers" class="flex min-h-11 items-center gap-2 border-b-2 border-transparent px-3 text-[13px] text-fg-2 transition-colors hover:text-fg data-[state=active]:border-accent-ink data-[state=active]:font-medium data-[state=active]:text-fg sm:px-4">
      {t('rules.providers.title')}{#if providers !== null}<span class="num font-mono text-xs text-fg-3" aria-hidden="true">{count(providerCount)}</span>{/if}
    </Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="rules">

<RulesAnalytics connections={core.conns} {rules} ready={core.connectionsReady} online={core.connectionsOnline} />

<div class="mb-3 mt-8 flex flex-wrap items-center justify-between gap-3">
  <h2 class="text-sm font-medium">{t('rules.analytics.configuredRules')}</h2>
  <div class="flex min-w-0 max-w-full flex-wrap items-center gap-3">
    <SearchInput bind:value={query} placeholder={t('rules.search')} />
    {#if hasStats}
      <select bind:value={sort} aria-label={t('rules.stats.sort')} class="h-11 max-w-full rounded-control border border-field-border bg-field px-3 text-[13px] sm:h-8" data-testid="rule-sort">
        <option value="config">{t('rules.stats.config')}</option><option value="hits">{t('rules.stats.hitsSort')}</option><option value="misses">{t('rules.stats.missesSort')}</option>
      </select>
    {/if}
    <Button size="sm" disabled={loading || changing !== null} onclick={refreshRules} data-testid="rules-refresh">{t(loading ? 'rules.stats.refreshing' : 'rules.stats.refresh')}</Button>
  </div>
</div>
{#if hasStats || !loading}<p class="mb-3 text-xs leading-5 text-fg-3">{t(hasStats ? 'rules.stats.note' : 'rules.stats.unsupported')}</p>{/if}
{#if ruleActionError}<p class="mb-3 rounded-card border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{ruleActionError}</p>{/if}
{#if stateUncertain}<p class="mb-3 text-[13px] text-fg-2" role="status">{t('rules.stats.stale')}</p>{:else if ruleActionDone}<p class="mb-3 text-xs text-fg-2" role="status">{t('rules.stats.changed')}</p>{/if}

{#if error}
  <p class="rounded-[var(--radius-card)] border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{errorMessage(error)}</p>
{/if}
{#if loading && !rules.length}
  <p class="text-fg-3">{t('rules.loading')}</p>
{:else if rules.length || !error}
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
          {@const stats = ruleStats(r)}
          {@const serverIndex = ruleIndex(r)}
          <tr class="border-t border-line {expanded === r.i ? 'bg-selected' : 'hover:bg-hover'}" data-testid="rule-row" data-rule-index={serverIndex ?? undefined} data-rule-disabled={stats?.disabled ?? undefined}>
            <td class="num hidden px-4 py-2 text-right font-mono text-xs text-fg-3 md:table-cell">{count(r.i)}</td>
            <td class="hidden truncate px-3 py-2 font-mono text-xs text-fg-2 sm:table-cell" title={r.type}>{r.type}</td>
            <td class="px-3 py-2" title={r.payload}>
                <button class="flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-control)] text-left transition-colors hover:bg-hover {expanded === r.i ? 'text-selected-text' : 'hover:text-fg'}" aria-expanded={expanded === r.i} aria-controls="rules-details-{r.i}" aria-label={isRuleSet(r) ? t(expanded === r.i ? 'rules.collapseSet' : 'rules.expandSet', { name: r.payload }) : t(expanded === r.i ? 'rules.stats.collapse' : 'rules.stats.expand', { number: r.i })} onclick={() => toggle(r.i)}>
                  <IconChevron class="size-4 shrink-0 transition-transform motion-reduce:transition-none {expanded === r.i ? 'rotate-180' : ''}" strokeWidth={1.5} />
                  <span class="min-w-0 truncate">{r.payload || '—'}</span>
                </button>
              {#if !isRuleSet(r) && r.size && r.size > 0}<span class="num font-mono text-xs text-fg-3">{count(r.size)}</span>{/if}
              {#if stats?.hits !== null && stats?.hits !== undefined}<span class="block text-xs text-fg-3">{t('rules.stats.hits')}: <span class="num font-mono">{count(stats.hits)}</span></span>{/if}
              {#if stats?.disabled}<span class="block text-xs text-warning">{t('rules.stats.disabled')}</span>{/if}
              <span class="block truncate font-mono text-xs text-fg-3 sm:hidden">{r.type}</span>
            </td>
            <td class="truncate px-4 py-2 text-fg-2" title={r.proxy}>{r.proxy}</td>
          </tr>
            <tr id="rules-details-{r.i}" hidden={expanded !== r.i}>
              <td colspan={columns} class="p-0">
                {#if expanded === r.i}
                  <section class="border-t border-line bg-raised px-4 py-4 sm:px-5" aria-label={t('rules.stats.details', { number: r.i })}>
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <h3 class="text-[13px] font-medium">{t('rules.stats.title')}</h3>
                      {#if stats?.disabled !== null && stats?.disabled !== undefined}
                        <span class="text-xs {stats.disabled ? 'text-warning' : 'text-fg-2'}">{t(stats.disabled ? 'rules.stats.disabled' : 'rules.stats.enabled')}</span>
                        <Button size="sm" disabled={changing !== null || loading || stateUncertain || !currentRuleForToggle(r, rules)} onclick={() => void setRuleEnabled(r)} data-testid="rule-toggle"
                          aria-label={t('rules.stats.toggleLabel', { action: t(stats.disabled ? 'rules.stats.enable' : 'rules.stats.disable'), number: r.i, payload: r.payload })}>
                          {t(changing !== null && changing === serverIndex ? 'rules.stats.changing' : stats.disabled ? 'rules.stats.enable' : 'rules.stats.disable')}
                        </Button>
                      {/if}
                    </div>
                    {#if stats}
                      <dl class="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 text-xs lg:grid-cols-4">
                        <div><dt class="text-fg-3">{t('rules.stats.hits')}</dt><dd class="num mt-1 font-mono">{stats.hits === null ? '—' : count(stats.hits)}</dd></div>
                        <div><dt class="text-fg-3">{t('rules.stats.misses')}</dt><dd class="num mt-1 font-mono">{stats.misses === null ? '—' : count(stats.misses)}</dd></div>
                        <div><dt class="text-fg-3">{t('rules.stats.lastHit')}</dt><dd class="mt-1">{dateTime(stats.hitAt)}</dd></div>
                        <div><dt class="text-fg-3">{t('rules.stats.lastMiss')}</dt><dd class="mt-1">{dateTime(stats.missAt)}</dd></div>
                      </dl>
                      {#if !currentRuleForToggle(r, rules)}<p class="mt-3 text-xs text-fg-3">{t('rules.stats.noIndex')}</p>{/if}
                    {:else}<p class="mt-3 text-xs text-fg-3">{t('rules.stats.unsupported')}</p>{/if}
                    {#if isRuleSet(r)}
                      <Button class="mt-4" variant="secondary" size="sm" aria-label={t('rules.providers.openLabel', { name: r.payload })} onclick={() => void openProvider(r.payload)}>{t('rules.providers.open')}</Button>
                    {/if}
                  </section>
                {/if}
              </td>
            </tr>
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
  </Tabs.Content>
  <Tabs.Content value="providers">
    <RuleProviders {providers} loading={providersLoading} error={providersError} busy={providersBusy} updates={providerUpdates} batch={providerBatch}
      bind:query={providerQuery} onreload={() => void loadProviders(true)} onupdate={(name) => void updateProvider(name)} onupdateall={() => void updateAllProviders()}
      oncancel={cancelProviderBatch} retryCount={retryableProviderNames.length} onretryfailed={() => void updateAllProviders('retry')}
      resumeCount={remainingProviderNames.length} onresume={() => void updateAllProviders('resume')} />
  </Tabs.Content>
</Tabs.Root>
