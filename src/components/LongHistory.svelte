<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { api, ApiError, errorMessage } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { longHistory } from '../lib/long-history.svelte'
  import { aggregateHistory, createHistoryShare, HISTORY_DAY, HISTORY_COLLECTOR_MAX, validHistoryCollector, historyShareKey, HistoryShareError, parseHistoryShare, writeHistoryShare, type HistoryShare } from '../lib/long-history'
  import { historyRandomId } from '../lib/long-history-store'
  import { t, i18n } from '../lib/i18n.svelte'
  import { bytes } from '../lib/format'
  import Button from './Button.svelte'

  let days = $state(7)
  let dimension = $state<'devices' | 'domains' | 'hours'>('devices')
  let page = $state(0)
  let now = $state(Date.now())
  let persisted = $state(false)
  let persistBusy = $state(false)
  let collector = $state(longHistory.collector)
  let label = $state('')
  let remote = $state.raw<HistoryShare | null>(null)
  let readCode = $state('')
  let busy = $state(false)
  let message = $state('')
  let failure = $state(false)
  let abort: AbortController | null = null
  let active = true
  const backend = { ...core.backend }
  const current = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret
  const available = $derived(core.status === 'ok' || core.status === 'lost')
  const buckets = $derived(longHistory.backendUrl === core.backend.url ? longHistory.buckets.filter(row => row.hour >= now - days * HISTORY_DAY) : [])
  const summary = $derived(buckets.reduce((all, row) => ({ down: all.down + row.down, up: all.up + row.up, observedMs: all.observedMs + row.observedMs, gaps: all.gaps + row.gaps }), { down: 0, up: 0, observedMs: 0, gaps: 0 }))
  const rows = $derived(dimension === 'hours' ? [...buckets].reverse().map(row => ({ name: new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(row.hour), down: row.down, up: row.up, observedMs: row.observedMs })) : aggregateHistory(buckets, dimension).map(row => ({ ...row, observedMs: null })))
  const pages = $derived(Math.max(1, Math.ceil(rows.length / 50)))
  const currentPage = $derived(Math.min(page, pages - 1))
  const shown = $derived(rows.slice(currentPage * 50, (currentPage + 1) * 50))
  const input = 'min-h-11 w-full min-w-0 rounded-control border border-line bg-base px-3 text-sm text-fg outline-none focus-visible:border-accent'
  const minutes = (ms: number) => t('history.minutes', { minutes: new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 1 }).format(ms / 60_000) })
  onMount(() => {
    const timer = setInterval(() => { now = Date.now() }, 60_000)
    void navigator.storage?.persisted?.().then(value => { if (active) persisted = value }).catch(() => {})
    return () => clearInterval(timer)
  })
  onDestroy(() => { active = false; abort?.abort() })
  async function requestPersistence() {
    persistBusy = true
    try { persisted = await navigator.storage?.persist?.() ?? false } catch { persisted = false }
    finally { if (active) persistBusy = false }
  }
  function report(error: unknown) {
    failure = true
    message = error instanceof ApiError && [404, 405].includes(error.status) ? t('history.unsupported')
      : error instanceof HistoryShareError ? t(`history.${error.code}`) : errorMessage(error)
  }
  async function readSnapshot() {
    if (busy || !current()) return
    const code = collector.trim()
    if (!validHistoryCollector(code)) { report(new HistoryShareError('invalid')); return }
    busy = true; message = ''; readCode = ''; abort = new AbortController()
    try {
      const loaded = parseHistoryShare(await api.getStorage(historyShareKey(code), backend, abort.signal))
      if (!current()) return
      if (loaded && loaded.collector !== code) throw new HistoryShareError('invalid')
      remote = loaded; readCode = code; failure = false
      if (!loaded) message = t('history.remoteEmpty')
    } catch (error) { if (current()) report(error) }
    finally { if (active) busy = false }
  }
  async function publish() {
    if (busy || !current() || readCode !== longHistory.collector || collector.trim() !== readCode || longHistory.backendUrl !== backend.url) return
    busy = true; message = ''; abort = new AbortController()
    const signal = abort.signal
    try {
      const next = createHistoryShare(longHistory.buckets, longHistory.collector, label || t('history.browser'), historyRandomId())
      await writeHistoryShare(remote, next,
        () => api.getStorage(historyShareKey(next.collector), backend, signal),
        value => { if (!current()) throw new DOMException('Aborted', 'AbortError'); return api.putStorage(historyShareKey(next.collector), value, backend, signal) })
      if (current()) { remote = next; failure = false; message = t('history.saved') }
    } catch (error) { if (current()) { readCode = ''; report(error) } }
    finally { if (active) busy = false }
  }
</script>

<section class="min-w-0 space-y-5" data-testid="long-history">
  <div>
    <h2 class="text-base font-medium">{t('history.title')}</h2>
    <p class="mt-2 max-w-4xl text-[13px] leading-6 text-fg-3">{t('history.hint')}</p>
    <p class="mt-2 text-xs text-fg-2" role="status">{t(`history.${longHistory.recording}`)}</p>
  </div>
  {#if longHistory.storageState === 'memory'}<p class="rounded-card border border-line p-4 text-[13px] text-warning" role="status">{t('history.memory')}</p>{/if}
  <div class="flex flex-wrap items-end gap-4">
    <label class="min-w-40 flex-1 space-y-1 text-xs text-fg-3">{t('history.range')}<select class={input} bind:value={days} onchange={() => { page = 0 }}><option value={1}>{t('history.day')}</option><option value={7}>{t('history.week')}</option><option value={30}>{t('history.month')}</option></select></label>
    <label class="min-w-48 flex-1 space-y-1 text-xs text-fg-3">{t('history.dimension')}<select class={input} bind:value={dimension} onchange={() => { page = 0 }}><option value="devices">{t('history.devices')}</option><option value="domains">{t('history.domains')}</option><option value="hours">{t('history.hours')}</option></select></label>
  </div>
  <dl class="grid grid-cols-2 gap-4 rounded-panel border border-line bg-card p-4 sm:grid-cols-4 sm:p-5">
    <div><dt class="text-xs text-fg-3">{t('history.down')}</dt><dd class="num mt-1 font-mono text-sm">{bytes(summary.down)}</dd></div>
    <div><dt class="text-xs text-fg-3">{t('history.up')}</dt><dd class="num mt-1 font-mono text-sm">{bytes(summary.up)}</dd></div>
    <div><dt class="text-xs text-fg-3">{t('history.observed')}</dt><dd class="num mt-1 text-sm">{minutes(summary.observedMs)}</dd></div>
    <div><dt class="text-xs text-fg-3">{t('history.gaps')}</dt><dd class="num mt-1 text-sm">{summary.gaps}</dd></div>
  </dl>
  {#if longHistory.loading}<p class="text-sm text-fg-3" role="status">{t('history.loading')}</p>
  {:else if !rows.length}<p class="rounded-panel border border-line p-5 text-sm text-fg-3">{t('history.empty')}</p>
  {:else}
    <div class="overflow-x-auto rounded-panel border border-line">
      <table class="w-full text-left text-[13px]">
        <thead class="bg-card text-xs text-fg-3"><tr><th class="min-w-48 px-4 py-3 font-medium">{t(dimension === 'hours' ? 'history.hour' : 'history.name')}</th><th class="px-4 py-3 text-right font-medium">{t('history.down')}</th><th class="px-4 py-3 text-right font-medium">{t('history.up')}</th>{#if dimension === 'hours'}<th class="px-4 py-3 text-right font-medium">{t('history.observed')}</th>{/if}</tr></thead>
        <tbody>{#each shown as row}<tr class="border-t border-line"><td class="min-w-48 max-w-64 break-words px-4 py-3 [overflow-wrap:anywhere]">{row.name || t('history.other')}</td><td class="num whitespace-nowrap px-4 py-3 text-right font-mono">{bytes(row.down)}</td><td class="num whitespace-nowrap px-4 py-3 text-right font-mono">{bytes(row.up)}</td>{#if row.observedMs !== null}<td class="num whitespace-nowrap px-4 py-3 text-right">{minutes(row.observedMs)}</td>{/if}</tr>{/each}</tbody>
      </table>
    </div>
    {#if pages > 1}<div class="flex flex-wrap items-center justify-between gap-3"><Button size="sm" disabled={currentPage === 0} onclick={() => { page = currentPage - 1 }}>{t('history.previous')}</Button><span class="text-xs text-fg-3">{t('history.page', { page: currentPage + 1, pages })}</span><Button size="sm" disabled={currentPage >= pages - 1} onclick={() => { page = currentPage + 1 }}>{t('history.next')}</Button></div>{/if}
  {/if}
  <p class="text-xs leading-5 text-fg-3">{t('history.bounded')}</p>
  <div class="flex flex-wrap items-center gap-3"><p class="flex-1 text-xs leading-5 text-fg-3">{t(persisted ? 'history.persisted' : 'history.bestEffort')}</p>{#if !persisted && typeof navigator.storage?.persist === 'function'}<Button size="sm" disabled={persistBusy} onclick={requestPersistence}>{t('history.persist')}</Button>{/if}</div>

  <section class="min-w-0 space-y-4 rounded-panel border border-line bg-card p-4 sm:p-5" data-testid="history-share">
    <div><h3 class="text-sm font-medium">{t('history.shareTitle')}</h3><p class="mt-2 text-xs leading-5 text-fg-3">{t('history.shareHint')}</p></div>
    <p class="break-all font-mono text-xs text-fg-2">{t('history.localCode', { code: longHistory.collector })}</p>
    <div class="grid gap-4 sm:grid-cols-2"><label class="space-y-1 text-xs text-fg-3">{t('history.collector')}<input class={input} bind:value={collector} maxlength={HISTORY_COLLECTOR_MAX} spellcheck="false" /></label><label class="space-y-1 text-xs text-fg-3">{t('history.shareName')}<input class={input} bind:value={label} maxlength={80} placeholder={t('history.browser')} /></label></div>
    <div class="flex flex-wrap gap-3"><Button size="sm" disabled={busy || !available} onclick={readSnapshot}>{t(busy ? 'history.pending' : 'history.read')}</Button><Button size="sm" disabled={busy || !available || readCode !== longHistory.collector || collector.trim() !== readCode || !longHistory.buckets.length} onclick={publish}>{t('history.publish')}</Button></div>
    {#if message}<p class="text-xs leading-5" class:text-warning={failure} class:text-fg-2={!failure} role="status">{message}</p>{/if}
    {#if remote && readCode === collector.trim()}
      <p class="break-words text-sm font-medium [overflow-wrap:anywhere]">{t('history.preview', { name: remote.label || remote.collector })}</p>
      <div class="overflow-x-auto"><table class="w-full text-left text-xs"><thead class="text-fg-3"><tr><th class="py-3 font-medium">UTC</th><th class="px-3 py-3 text-right font-medium">{t('history.down')}</th><th class="px-3 py-3 text-right font-medium">{t('history.up')}</th><th class="py-3 text-right font-medium">{t('history.observed')}</th></tr></thead><tbody>{#each [...remote.days].reverse() as day}<tr class="border-t border-line"><td class="whitespace-nowrap py-3">{new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeZone: 'UTC' }).format(day.day)}</td><td class="num whitespace-nowrap px-3 py-3 text-right font-mono">{bytes(day.down)}</td><td class="num whitespace-nowrap px-3 py-3 text-right font-mono">{bytes(day.up)}</td><td class="num whitespace-nowrap py-3 text-right">{minutes(day.observedMs)}</td></tr>{/each}</tbody></table></div>
    {/if}
  </section>
</section>
