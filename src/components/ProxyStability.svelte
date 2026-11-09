<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, type Backend } from '../lib/api'
  import { t, i18n } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { core } from '../lib/core.svelte'
  import type { DelaySettings, DelayTarget } from '../lib/latency'
  import { runStabilitySeries, summarizeStability, STABILITY_ATTEMPTS, type StabilitySample } from '../lib/stability'
  import { IconChevron } from '../lib/icons'
  import Button from './Button.svelte'
  import LatencyProgress from './LatencyProgress.svelte'

  let { backend, targets, settings, disabled = false, onrunning, oncomplete }: {
    backend: Backend
    targets: DelayTarget[]
    settings: Readonly<DelaySettings>
    disabled?: boolean
    onrunning: (running: boolean) => void
    oncomplete: () => void
  } = $props()

  type Series = { name: string; url: string; timeout: number; startedAt: number; samples: readonly StabilitySample[]; cancelled: boolean }
  const selectId = $props.id()
  let selected = $state('')
  let running = $state(false)
  let result = $state.raw<Series | null>(null)
  let controller: AbortController | null = null
  let active = true
  const targetKey = (target: DelayTarget) => JSON.stringify([target.provider ?? null, target.name])
  const repeatedNames = $derived.by(() => {
    const seen = new Set<string>(), repeated = new Set<string>()
    for (const target of targets) { if (seen.has(target.name)) repeated.add(target.name); seen.add(target.name) }
    return repeated
  })
  const targetLabel = (target: DelayTarget) => `${target.name}${repeatedNames.has(target.name) && target.provider ? ` · ${target.provider}` : ''}`
  const statistics = $derived(summarizeStability(result?.samples ?? []))
  const number = (value: number) => new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 1 }).format(value)
  const displayDelay = (value: number | null) => value === null ? '—' : t('proxies.delay', { delay: number(value) })
  const displayRange = $derived(statistics.min === null || statistics.max === null ? '—' : t('proxies.delay', { delay: `${number(statistics.min)}–${number(statistics.max)}` }))
  const parameters = $derived(result ?? settings)

  $effect(() => {
    if (!running && !targets.some((target) => targetKey(target) === selected)) selected = targets[0] ? targetKey(targets[0]) : ''
  })

  async function start() {
    const target = targets.find((item) => targetKey(item) === selected)
    if (!active || disabled || running || !target) return
    const session = { ...backend }
    const noticeId = `proxy-stability:${session.url}`
    notifications.dismiss(noticeId)
    const preferences = { url: settings.url, timeout: settings.timeout }
    const current = new AbortController()
    controller = current
    result = { name: targetLabel(target), ...preferences, startedAt: Date.now(), samples: [], cancelled: false }
    running = true
    onrunning(true)
    try {
      const completed = await runStabilitySeries(target, preferences,
        (endpoint, url, timeout, signal) => endpoint.provider
          ? api.providerProxyDelay(endpoint.provider, endpoint.name, url, timeout, session, signal)
          : api.proxyDelay(endpoint.name, url, timeout, session, signal),
        current.signal,
        (samples) => { if (active && controller === current && result) result = { ...result, samples } },
      )
      if (active && controller === current && result) {
        result = { ...result, ...completed }
        if (core.backend.url === session.url && core.backend.secret === session.secret) {
          const summary = summarizeStability(completed.samples)
          notifications.show({
            id: noticeId, tone: completed.cancelled ? 'info' : summary.failed ? 'warning' : 'success',
            title: targetLabel(target), scope: session.url, testId: 'proxy-stability-notice',
            message: () => `${t(completed.cancelled ? 'stability.cancelled' : 'stability.complete', { done: summary.completed })} · ${t('stability.failed')}: ${summary.failed}/${summary.completed}`,
          })
        }
      }
    } finally {
      if (controller === current) controller = null
      if (active) {
        running = false
        onrunning(false)
        oncomplete()
      }
    }
  }

  onDestroy(() => {
    active = false
    controller?.abort()
    onrunning(false)
  })
</script>

<details class="group min-w-0 rounded-panel border border-line bg-card" data-testid="proxy-stability">
  <summary class="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] marker:content-none">
    <IconChevron class="size-4 shrink-0 -rotate-90 text-fg-3 transition-transform group-open:rotate-0" strokeWidth={1.5} />
    <span>{t('stability.title')}</span>
    {#if running}<span class="ml-auto font-mono text-xs text-fg-3">{statistics.completed}/{STABILITY_ATTEMPTS}</span>{/if}
  </summary>
  <div class="space-y-4 border-t border-line p-4">
    <p class="text-xs leading-5 text-fg-3">{t('stability.description')}</p>
    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-0 flex-1 basis-48">
        <label for={selectId} class="mb-1 block text-xs text-fg-2">{t('stability.node')}</label>
        <select id={selectId} bind:value={selected} disabled={running || !targets.length} class="h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-field-border bg-field px-3 text-[13px] text-fg sm:h-9">
          {#if !targets.length}<option value="">{t('stability.empty')}</option>{/if}
          {#each targets as target (targetKey(target))}<option value={targetKey(target)}>{targetLabel(target)}</option>{/each}
        </select>
      </div>
      {#if running}
        <Button size="sm" onclick={() => controller?.abort()}>{t('stability.cancel')}</Button>
      {:else}
        <Button size="sm" disabled={disabled || !selected} onclick={start}>{t('stability.start')}</Button>
      {/if}
    </div>
    <div class="space-y-1 text-xs text-fg-3">
      <p class="break-all font-mono">{parameters.url}</p>
      <p>{t('stability.parameters', { timeout: parameters.timeout })}</p>
    </div>
    {#if result}
      <div class="space-y-2" role="status">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
          <strong class="min-w-0 break-words font-medium">{result.name}</strong>
          <span class="text-fg-3">{t(running ? 'stability.running' : result.cancelled ? 'stability.cancelled' : 'stability.complete', { done: statistics.completed })}</span>
        </div>
        <LatencyProgress label={t('stability.title')} done={statistics.completed} total={STABILITY_ATTEMPTS} />
        <p class="text-xs text-fg-3">{t('stability.started', { time: new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }).format(result.startedAt) })}</p>
      </div>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-xs" data-testid="stability-statistics">
        <div><dt class="text-fg-3">{t('stability.median')}</dt><dd class="mt-1 font-mono num text-sm" data-stat="median">{displayDelay(statistics.median)}</dd></div>
        <div title={t('stability.p95Hint')}><dt class="text-fg-3">{t('stability.p95')}</dt><dd class="mt-1 font-mono num text-sm" data-stat="p95">{displayDelay(statistics.p95)}</dd></div>
        <div><dt class="text-fg-3">{t('stability.range')}</dt><dd class="mt-1 font-mono num text-sm" data-stat="range">{displayRange}</dd></div>
        <div><dt class="text-fg-3">{t('stability.failed')}</dt><dd class="mt-1 font-mono num text-sm" class:text-bad={statistics.failed > 0} data-stat="failed">{statistics.failed}/{statistics.completed}</dd></div>
      </dl>
      {#if result.samples.length}
        <ol class="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label={t('stability.title')}>
          {#each result.samples as sample (sample.attempt)}
            <li class="flex min-w-0 flex-col gap-1 rounded-[var(--radius-control)] bg-raised px-2 py-2 text-xs" title={t('stability.sample', { attempt: sample.attempt })}>
              <span class="font-mono text-fg-3">{sample.attempt}</span>
              <span class="break-words font-mono num" class:text-bad={sample.delay === null}>{sample.delay === null ? t('stability.noResponse') : displayDelay(sample.delay)}</span>
            </li>
          {/each}
        </ol>
      {/if}
      <p class="text-xs leading-5 text-fg-3">{t('stability.failuresHint')}</p>
    {:else}
      <p class="text-xs text-fg-3">{t('stability.noResults')}</p>
    {/if}
  </div>
</details>
