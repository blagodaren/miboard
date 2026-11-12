<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, errorMessage, type Backend, type Proxy, type SmartWeight } from '../lib/api'
  import { i18n, t, type MessageKey } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { IconChevron, IconRefresh } from '../lib/icons'
  import Button from './Button.svelte'

  let { group, backend }: { group: Proxy; backend: Backend } = $props()
  let active = true
  let controller: AbortController | null = null
  let sequence = 0
  let expanded = $state(false)
  let loading = $state(false)
  let loaded = $state(false)
  let weights = $state.raw<SmartWeight[]>([])
  let error = $state.raw<unknown>(null)
  const numberFormat = $derived(new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 2 }))

  const parameters = $derived.by(() => {
    const items: { key: MessageKey; value: string }[] = []
    const addBoolean = (key: MessageKey, value: boolean | undefined) => {
      if (typeof value === 'boolean') items.push({ key, value: t(value ? 'prizrak.enabled' : 'prizrak.disabled') })
    }
    addBoolean('prizrak.useLightGBM', group.useLightGBM)
    addBoolean('prizrak.collectData', group.collectData)
    if (typeof group.sampleRate === 'number' && Number.isFinite(group.sampleRate)) {
      items.push({ key: 'prizrak.sampleRate', value: t('prizrak.percent', { count: group.sampleRate * 100 }) })
    }
    addBoolean('prizrak.preferASN', group.preferASN)
    if (typeof group.tolerance === 'number' && Number.isFinite(group.tolerance)) {
      items.push({ key: 'prizrak.tolerance', value: t('prizrak.milliseconds', { count: group.tolerance }) })
    }
    if (typeof group['policy-priority'] === 'string' && group['policy-priority']) {
      items.push({ key: 'prizrak.policyPriority', value: group['policy-priority'] })
    }
    return items
  })

  function rank(value: string) {
    if (value === 'MostUsed') return t('prizrak.rankMostUsed')
    if (value === 'OccasionalUsed') return t('prizrak.rankOccasionalUsed')
    if (value === 'RarelyUsed') return t('prizrak.rankRarelyUsed')
    return t('prizrak.rankUnknown')
  }

  async function load() {
    if (!active || loading) return
    controller?.abort()
    controller = new AbortController()
    const requestController = controller
    const requestSequence = ++sequence
    const name = group.name
    const target = { ...backend }
    const current = () => active && requestSequence === sequence && !requestController.signal.aborted &&
      group.name === name && backend.url === target.url && backend.secret === target.secret
    loading = true
    error = null
    try {
      const response = await api.smartGroupWeights(name, target, requestController.signal)
      if (!current()) return
      weights = Array.isArray(response.weights) ? response.weights : []
      loaded = true
    } catch (cause) {
      if (current()) {
        if (loaded) notifications.show({
          id: `smart-weights:${JSON.stringify([target.url, name])}`, tone: 'error', scope: target.url,
          title: () => `${t('prizrak.weights')}: ${name}`, message: () => errorMessage(cause),
          testId: 'smart-weights-notice',
        })
        else error = cause
      }
    } finally {
      if (current()) loading = false
    }
  }

  function toggleWeights() {
    expanded = !expanded
    if (expanded && !loaded && !loading) void load()
  }

  onDestroy(() => {
    active = false
    ++sequence
    controller?.abort()
  })
</script>

<section class="border-t border-line bg-raised px-4 py-3 sm:px-5" aria-label={`${t('prizrak.groupParameters')}: ${group.name}`}>
  {#if parameters.length}
    <dl class="grid grid-cols-2 gap-x-5 gap-y-3 text-[13px] sm:grid-cols-3">
      {#each parameters as parameter (parameter.key)}
        <div class="min-w-0">
          <dt class="text-xs text-fg-3">{t(parameter.key)}</dt>
          <dd class="mt-1 break-words text-fg-2">{parameter.value}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  <div class="flex flex-wrap items-center justify-between gap-2 {parameters.length ? 'mt-4' : ''}">
    <Button size="sm" variant="ghost" class="-ml-2" aria-expanded={expanded} onclick={toggleWeights}>
      <IconChevron class="transition-transform duration-150 {expanded ? '' : '-rotate-90'}" strokeWidth={1.5} aria-hidden="true" />
      {t('prizrak.weights')}
    </Button>
    {#if expanded}
      <Button size="sm" variant="ghost" disabled={loading} onclick={load} aria-label={t('prizrak.refreshWeights')}>
        <IconRefresh strokeWidth={1.5} aria-hidden="true" />{t('prizrak.refreshWeights')}
      </Button>
    {/if}
  </div>
  {#if expanded}
    <div class="mt-2" aria-busy={loading}>
      <p class="text-xs leading-5 text-fg-3">{t('prizrak.weightsHint')}</p>
      {#if loading}
        <p class="mt-3 text-[13px] text-fg-2" role="status">{t('prizrak.loadingWeights')}</p>
      {:else if error}
        <p class="mt-3 break-words text-[13px] text-bad" role="alert">{errorMessage(error)}</p>
      {:else if weights.length}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus lets users scroll the bounded weights table.) -->
        <div class="mt-3 max-h-64 overflow-auto rounded-lg border border-line bg-card" tabindex="0" role="region" aria-label={`${t('prizrak.weights')}: ${group.name}`}>
          <table class="w-full min-w-[420px] table-fixed text-[13px]">
            <thead class="sticky top-0 bg-[var(--table-head)] text-xs text-fg-2">
              <tr>
                <th scope="col" class="px-3 py-2 text-left font-normal">{t('prizrak.node')}</th>
                <th scope="col" class="w-20 px-3 py-2 text-right font-normal">{t('prizrak.weight')}</th>
                <th scope="col" class="w-28 px-3 py-2 text-left font-normal sm:w-36">{t('prizrak.rank')}</th>
              </tr>
            </thead>
            <tbody>
              {#each weights as weight, index (index)}
                <tr class="border-t border-line">
                  <th scope="row" class="break-words px-3 py-2 text-left font-normal text-fg-2">{weight.Name}</th>
                  <td class="num px-3 py-2 text-right font-mono">{Number.isFinite(weight.Weight) ? numberFormat.format(weight.Weight) : '—'}</td>
                  <td class="break-words px-3 py-2 text-xs text-fg-2">{rank(weight.Rank)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="mt-3 text-[13px] text-fg-2" role="status">{t('prizrak.noWeights')}</p>
      {/if}
    </div>
  {/if}
</section>
