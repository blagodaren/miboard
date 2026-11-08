<script lang="ts">
  import { stream, type LogLine } from '../lib/api'
  import { t, i18n } from '../lib/i18n.svelte'
  import { count } from '../lib/format'
  import { IconPause, IconPlay } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Segmented from '../components/Segmented.svelte'

  type Level = 'debug' | 'info' | 'warning' | 'error'
  type Row = LogLine & { id: number; time: number }
  const CAP = 1000

  let level = $state<Level>('info')
  let lines = $state.raw<Row[]>([])
  let paused = $state(false)
  let query = $state('')
  let seq = 0

  $effect(() => {
    const lvl = level
    return stream<LogLine>(
      '/logs',
      (l) => {
        if (paused) return
        const row = { ...l, id: seq++, time: Date.now() }
        lines = [row, ...lines].slice(0, CAP)
      },
      { query: { level: lvl } },
    )
  })

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return q ? lines.filter((l) => l.payload.toLowerCase().includes(q)) : lines
  })

  const levelClass: Record<string, string> = { error: 'text-bad', warning: 'text-fg', info: 'text-fg-3', debug: 'text-fg-3' }
  const levelLabels = $derived({
    debug: t('logs.levelDebug'),
    info: t('logs.levelInfo'),
    warning: t('logs.levelWarning'),
    error: t('logs.levelError'),
  })
  const levels = $derived((Object.keys(levelLabels) as Level[]).map((value) => ({ value, label: levelLabels[value] })))
  const timeFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
</script>

<PageHeader title={t('logs.title')} meta={t('logs.lines', { count: shown.length, total: count(shown.length) }) + (paused ? t('logs.paused') : '')}>
  {#snippet actions()}
    <SearchInput bind:value={query} placeholder={t('logs.search')} />
    <Segmented label={t('logs.level')} value={level} options={levels} onchange={(v) => ((level = v), (lines = []))} />
    <Button size="sm" onclick={() => (paused = !paused)} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('logs.resume')}{:else}<IconPause strokeWidth={1.5} />{t('logs.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => (lines = [])}>{t('logs.clear')}</Button>
  {/snippet}
</PageHeader>

<div class="rounded-2xl border border-line bg-card font-mono text-xs leading-5">
  {#each shown as l (l.id)}
    <div class="flex gap-4 border-t border-line px-4 py-1.5 first:border-t-0">
      <span class="num shrink-0 text-fg-3">{timeFormat.format(l.time)}</span>
      <span class="w-20 shrink-0 {levelClass[l.type] ?? 'text-fg-3'}">{levelLabels[l.type as Level] ?? l.type}</span>
      <span class="min-w-0 break-all text-fg-2">{l.payload}</span>
    </div>
  {:else}
    <p class="px-4 py-8 text-center font-sans text-[13px] text-fg-3">{t('logs.waiting', { level: levelLabels[level] })}</p>
  {/each}
</div>
