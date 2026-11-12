<script lang="ts">
  import { stream } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { t, i18n } from '../lib/i18n.svelte'
  import { count } from '../lib/format'
  import { LogBuffer, matchesLog, subscribeLogs, type LogLevel, type NormalizedLog } from '../lib/logs'
  import { IconChevron, IconPause, IconPlay } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Segmented from '../components/Segmented.svelte'
  import { csvDocument, downloadText } from '../lib/table-tools'

  type Row = NormalizedLog & { id: number }
  const CAP = 1000
  let level = $state<LogLevel>('info')
  let lines = $state.raw<Row[]>([])
  let paused = $state(false)
  let query = $state('')
  let field = $state('')
  let online = $state(false)
  let format = $state<NormalizedLog['format'] | null>(null)
  let seq = 0
  const buffer = new LogBuffer<Row>(CAP)
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function flushLines() {
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    flushTimer = undefined
    lines = buffer.snapshot()
  }

  function clearLines() {
    if (flushTimer !== undefined) clearTimeout(flushTimer)
    flushTimer = undefined
    buffer.clear()
    lines = []
    field = ''
  }

  function togglePaused() {
    if (!paused) flushLines()
    paused = !paused
  }

  $effect(() => {
    // A controller switch must dispose its subscription and discard its rows.
    const controller = core.backend.url + core.backend.secret
    const lvl = level
    if (!controller) return
    clearLines(); format = null; online = false
    const stop = subscribeLogs(stream, lvl, line => {
      format = line.format
      if (paused) return
      buffer.push({ ...line, id: seq++ })
      if (flushTimer === undefined) flushTimer = setTimeout(flushLines, 100)
    }, state => { online = state })
    return () => {
      stop()
      if (flushTimer !== undefined) clearTimeout(flushTimer)
      flushTimer = undefined
      buffer.clear()
    }
  })

  const shown = $derived(lines.filter(line => matchesLog(line, query, field)))
  const fields = $derived([...new Set([...lines.flatMap(line => line.fields.map(item => item.key)), ...(field ? [field] : [])])].sort())
  const levelClass: Record<string, string> = { error: 'text-bad', warning: 'text-warning', info: 'text-fg-2', debug: 'text-fg-3' }
  const levelLabels = $derived({
    debug: t('logs.levelDebug'), info: t('logs.levelInfo'), warning: t('logs.levelWarning'), error: t('logs.levelError'),
  })
  const levels = $derived((Object.keys(levelLabels) as LogLevel[]).map(value => ({ value, label: levelLabels[value] })))
  const timeFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
  const receivedFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }))
</script>

<PageHeader title={t('logs.title')} meta={t('logs.lines', { count: shown.length, total: count(shown.length) }) + (paused ? t('logs.paused') : '')}>
  {#snippet actions()}
    <SearchInput bind:value={query} placeholder={t('logDetails.search')} />
    <div class="w-full min-w-0 sm:w-auto" title={t('logDetails.levelHint')}>
      <Segmented full label={t('logs.level')} value={level} options={levels} onchange={v => level = v} />
    </div>
    <Button size="sm" onclick={togglePaused} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('logs.resume')}{:else}<IconPause strokeWidth={1.5} />{t('logs.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={clearLines}>{t('logs.clear')}</Button>
    <Button size="sm" disabled={!shown.length} title={t('panelTools.exportHint')} onclick={() => downloadText('miboard-logs.txt', shown.map(line => `${new Date(line.receivedAt).toISOString()} [${line.level}] ${line.message}${line.fields.length ? ' ' + JSON.stringify(line.fields) : ''}`).join('\n'))}>{t('panelTools.logText')}</Button>
    <Button size="sm" disabled={!shown.length} title={t('panelTools.exportHint')} onclick={() => downloadText('miboard-logs.csv', csvDocument(['received_at', 'core_time', 'level', 'message', 'fields'], shown.map(line => [new Date(line.receivedAt).toISOString(), line.coreTime, line.level, line.message, JSON.stringify(line.fields)])), 'text/csv;charset=utf-8')}>{t('panelTools.csv')}</Button>
  {/snippet}
</PageHeader>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-fg-3">
  <div class="min-w-0 space-y-1">
    <p role="status" data-testid="logs-format">{t(!online ? (format ? 'logDetails.offline' : 'logDetails.connecting') : format === 'structured' ? 'logDetails.structured' : format === 'legacy' ? 'logDetails.legacy' : 'logs.waiting', { level: levelLabels[level] })}</p>
    <p>{t('logDetails.timeHint')}</p>
  </div>
  {#if fields.length}
    <label class="flex min-w-0 max-w-full items-center gap-2">
      <span class="shrink-0">{t('logDetails.searchIn')}</span>
      <select bind:value={field} data-testid="logs-field-filter" class="min-h-11 min-w-0 max-w-72 rounded-control border border-field-border bg-field px-3 text-[13px] text-fg">
        <option value="">{t('logDetails.allFields')}</option>
        {#each fields as key}<option value={key}>{key}</option>{/each}
      </select>
    </label>
  {/if}
</div>

<div class="rounded-panel border border-line bg-card font-mono text-xs leading-5" data-testid="log-list">
  {#each shown as line (line.id)}
    <details class="log-event group border-t border-line first:border-t-0" data-testid="log-event">
      <summary class="log-summary" title={t('logDetails.details')}>
        <span class="num min-w-0 text-fg-3 [overflow-wrap:anywhere]" title={t(line.coreTime ? 'logDetails.coreTime' : 'logDetails.receivedAt')}>{line.coreTime ?? timeFormat.format(line.receivedAt)}</span>
        <span class="justify-self-end sm:justify-self-start {levelClass[line.level] ?? 'text-fg-3'}">{levelLabels[line.level as LogLevel] ?? line.level}</span>
        <span class="log-message min-w-0 whitespace-pre-wrap break-words text-fg-2 [overflow-wrap:anywhere]">{line.message}</span>
        <span class="log-disclosure"><IconChevron class="size-4 -rotate-90 text-fg-3 group-open:rotate-0" strokeWidth={1.5} aria-hidden="true" /></span>
      </summary>
      <div class="border-t border-line bg-raised px-4 py-3 font-sans text-[13px]">
        <dl class="event-fields">
          {#if line.coreTime}<div><dt>{t('logDetails.coreTime')}</dt><dd class="font-mono">{line.coreTime}</dd></div>{/if}
          <div><dt>{t('logDetails.receivedAt')}</dt><dd>{receivedFormat.format(line.receivedAt)}</dd></div>
        </dl>
        {#if line.fields.length}
          <p class="mb-2 mt-4 text-xs text-fg-3">{t('logDetails.fields')}</p>
          <dl class="event-fields">
            {#each line.fields as item}<div><dt class="font-mono">{item.key}</dt><dd class="whitespace-pre-wrap font-mono">{item.value}</dd></div>{/each}
          </dl>
        {:else}<p class="mt-3 text-xs text-fg-3">{t('logDetails.noFields')}</p>{/if}
      </div>
    </details>
  {:else}
    <p class="px-4 py-8 text-center font-sans text-[13px] text-fg-3">{t(query.trim() || field ? 'logDetails.noMatches' : 'logs.waiting', { level: levelLabels[level] })}</p>
  {/each}
</div>

<style>
  .log-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; gap: 4px 16px; min-height: 44px; padding: 12px 16px; cursor: pointer; }
  .log-message { grid-column: 1 / -1; }
  .log-disclosure { grid-column: 3; grid-row: 1; align-self: center; }
  .log-summary::marker, .log-summary::-webkit-details-marker { display: none; content: ''; }
  .log-summary:hover { background: var(--hover); }
  .log-event[open] > summary { background: var(--hover); }
  .event-fields { display: grid; gap: 10px; }
  .event-fields > div { display: grid; grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .event-fields dt { color: var(--text-3); overflow-wrap: anywhere; }
  .event-fields dd { min-width: 0; overflow-wrap: anywhere; }
  @media (min-width: 640px) {
    .log-summary { grid-template-columns: minmax(72px, 140px) 80px minmax(0, 1fr) 16px; padding-block: 10px; }
    .log-message { grid-column: 3; }
    .log-disclosure { grid-column: 4; }
    .event-fields > div { grid-template-columns: minmax(120px, 200px) minmax(0, 1fr); gap: 16px; }
  }
</style>
