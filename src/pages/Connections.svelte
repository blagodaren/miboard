<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, errorMessage } from '../lib/api'
  import { core, type ConnRow } from '../lib/core.svelte'
  import { bytes, speed, since, count } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconClose, IconPause, IconPlay, IconRefresh, IconChevron } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Confirm from '../components/Confirm.svelte'
  import Segmented from '../components/Segmented.svelte'
  import { connectionJournal, type JournalEntry } from '../lib/connection-journal.svelte'
  import { normalizeDeviceIP } from '../lib/devices'

  type SortKey = 'rate' | 'total' | 'start' | 'host'
  const LIMIT = 300
  const JOURNAL_PAGE_SIZE = 100
  let page = $state(1)
  type DisplayRow = ConnRow & { journal?: JournalEntry }
  let view = $state<'active' | 'closed'>('active')
  let selected = $state('')
  let deviceNames = $state<Record<string, string>>({})
  const archived = $derived(connectionJournal.backendUrl === core.backend.url ? connectionJournal.entries : [])
  const viewTotal = $derived(view === 'active' ? core.conns.length : archived.length)
  const views = $derived([{ value: 'active' as const, label: t('journal.active') }, { value: 'closed' as const, label: t('journal.closed') }])
  const dateFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }))
  const stamp = (value: number) => Number.isFinite(value) && value > 0 ? dateFormat.format(value) : '—'
  const rowKey = (row: DisplayRow) => row.journal ? JSON.stringify([row.id, row.start, row.journal.firstSeenAt]) : row.id
  const deviceName = (row: DisplayRow) => deviceNames[normalizeDeviceIP(row.metadata.sourceIP)] ?? ''
  function changeView(value: 'active' | 'closed') { view = value; selected = ''; paused = false; sort = value === 'closed' ? 'start' : 'rate'; sortDirection = 'desc' }

  let query = $state('')
  let paused = $state(false)
  let frozen = $state.raw<ConnRow[]>([])
  let sort = $state<SortKey>('rate')
  let sortDirection = $state<'asc' | 'desc'>('desc')
  let confirmAll = $state(false)
  let now = $state(Date.now())
  const backend = { ...core.backend }
  let active = true
  let smartGroups = $state<string[]>([])
  let switching = $state<Record<string, boolean>>({})
  let switchResult = $state.raw<{ host: string; error?: unknown } | null>(null)

  onDestroy(() => { active = false })

  $effect(() => {
    try {
      const names: unknown = JSON.parse(localStorage.getItem('miboard.device-names.' + encodeURIComponent(backend.url)) ?? '{}')
      if (names && typeof names === 'object' && !Array.isArray(names)) deviceNames = Object.fromEntries(Object.entries(names).filter(([, name]) => typeof name === 'string' && name.length <= 128))
    } catch { /* Device labels are optional local metadata. */ }
  })

  $effect(() => {
    if (!core.prizrak) return
    let current = true
    void api.proxies(backend).then(({ proxies }) => {
      if (current && active) smartGroups = Object.values(proxies).filter((p) => p.type === 'Smart').map((p) => p.name)
    }).catch(() => { /* Optional actions stay hidden if group metadata is unavailable. */ })
    return () => { current = false }
  })

  const usesSmart = (c: ConnRow) => core.prizrak && c.chains.some((name) => smartGroups.includes(name))
  const canSwitch = (c: ConnRow) => usesSmart(c) && core.connectionsOnline && core.conns.some((live) => live.id === c.id)
  const currentBackend = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret

  async function switchNode(c: ConnRow) {
    const key = JSON.stringify(c.id)
    if (switching[key] || !currentBackend() || !canSwitch(c)) return
    switching[key] = true
    switchResult = null
    const name = host(c)
    try {
      await api.closeSmartConnection(c.id, backend)
      if (currentBackend()) switchResult = { host: name }
    } catch (error) {
      if (currentBackend()) switchResult = { host: name, error }
    } finally {
      if (active) switching[key] = false
    }
  }

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  function togglePause() {
    paused = !paused
    if (paused) frozen = core.conns
  }

  const host = (c: ConnRow) => c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP
  const chain = (c: ConnRow) => [...c.chains].reverse().join(' / ')

  function changeSort(key: SortKey) {
    if (sort === key) {
      sortDirection = sortDirection === 'desc' ? 'asc' : 'desc'
    } else {
      sort = key
      sortDirection = key === 'host' ? 'asc' : 'desc'
    }
  }

  const rows = $derived.by(() => {
    const src: DisplayRow[] = view === 'closed'
      ? archived.map(journal => ({ ...journal.connection, dl: 0, ul: 0, journal }))
      : paused ? frozen : core.conns
    const q = query.trim().toLowerCase()
    const list = q
      ? src.filter((c) =>
          [host(c), c.metadata.destinationIP, c.metadata.sourceIP, deviceName(c), c.metadata.process ?? '', c.rule, c.rulePayload, ...c.chains]
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      : [...src]
    const by: Record<SortKey, (a: DisplayRow, b: DisplayRow) => number> = {
      rate: (a, b) => view === 'closed' ? a.journal!.lastSeenAt - b.journal!.lastSeenAt : a.dl + a.ul - (b.dl + b.ul) || a.download - b.download,
      total: (a, b) => a.download + a.upload - (b.download + b.upload),
      // Ascending age means newer connections first, independently of ISO offsets.
      start: (a, b) => view === 'closed' ? a.journal!.closedAt - b.journal!.closedAt : Date.parse(b.start) - Date.parse(a.start),
      host: (a, b) => host(a).localeCompare(host(b), i18n.intlLocale),
    }
    return list.sort((a, b) => by[sort](a, b) * (sortDirection === 'desc' ? -1 : 1))
  })
  const pages = $derived(Math.max(1, Math.ceil(rows.length / JOURNAL_PAGE_SIZE)))
  const currentPage = $derived(Math.min(pages, Math.max(1, page)))
  const displayedRows = $derived(view === 'closed' ? rows.slice((currentPage - 1) * JOURNAL_PAGE_SIZE, currentPage * JOURNAL_PAGE_SIZE) : rows.slice(0, LIMIT))
  $effect(() => { query; view; sort; sortDirection; page = 1 })

  async function close(id: string) {
    if (view !== 'active' || !currentBackend() || !core.conns.some(row => row.id === id)) return
    try {
      await api.closeConnection(id)
    } catch {
      /* соединение уже закрылось само */
    }
  }

  const th = 'px-3 py-2 font-normal text-xs text-fg-3 whitespace-nowrap'
</script>

{#snippet sortHead(key: SortKey, label: string, right = false)}
  <th class="{th} {right ? 'text-right' : 'text-left'}" aria-sort={sort === key ? (sortDirection === 'desc' ? 'descending' : 'ascending') : undefined}>
    <button type="button" class="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-fg sm:min-h-6 {sort === key ? 'text-fg' : ''}" onclick={() => changeSort(key)}>
      {label}
      <IconChevron class="size-4 shrink-0 {sort === key ? '' : 'invisible'} {sort === key && sortDirection === 'asc' ? 'rotate-180' : ''}" strokeWidth={1.5} aria-hidden="true" />
    </button>
  </th>
{/snippet}

<PageHeader title={t('connections.title')} meta={t('connections.meta', { shown: count(rows.length), total: count(viewTotal) }) + (paused ? t('connections.paused') : '')}>
  {#snippet actions()}
    <SearchInput bind:value={query} placeholder={t('journal.search')} />
    {#if view === 'active'}
    <Button size="sm" onclick={togglePause} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('connections.resume')}{:else}<IconPause strokeWidth={1.5} />{t('connections.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => (confirmAll = true)} disabled={!core.conns.length}>{t('connections.closeAll')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<div class="mb-4"><Segmented value={view} options={views} onchange={changeView} label={t('journal.view')} /></div>
{#if view === 'closed'}
  <p class="mb-4 max-w-3xl text-xs leading-5 text-fg-3">{t(connectionJournal.retention === 'off' ? 'journal.disabled' : 'journal.hint')}</p>
  {#if connectionJournal.loading}<p class="mb-3 text-xs text-fg-3" role="status">{t('journal.loading')}</p>{/if}
  {#if connectionJournal.storageState === 'memory'}<p class="mb-3 text-xs leading-5 text-warning" role="status">{t('journal.memory')}</p>{/if}
{:else if core.connectionsReady && !core.connectionsOnline}
  <p class="mb-4 text-xs leading-5 text-fg-3" role="status">{t('journal.offline')}</p>
{/if}

{#if view === 'active' && core.prizrak && smartGroups.length}
  <p class="mb-3 text-[13px] text-fg-3">{t('prizrak.switchHint')}</p>
{/if}
{#if switchResult}
  {#if switchResult.error}
    <p class="mb-3 break-words rounded-[var(--radius-card)] border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{t('prizrak.switchError', { host: switchResult.host, message: errorMessage(switchResult.error) })}</p>
  {:else}
    <p class="mb-3 rounded-[var(--radius-card)] border border-line bg-card px-4 py-3 text-[13px] text-good" role="status">{t('prizrak.switchDone', { host: switchResult.host })}</p>
  {/if}
{/if}

<div class="relative overflow-x-auto rounded-panel border border-line bg-card">
  <table class="w-full min-w-[960px] text-[13px]">
    <thead>
      <tr>
        <th class="w-8 pl-4"><span class="sr-only">{t('connections.activity')}</span></th>
        {@render sortHead('host', t('connections.host'))}
        <th class="{th} text-left">{t('connections.rule')}</th>
        <th class="{th} text-left">{t('connections.chain')}</th>
        {@render sortHead('rate', t(view === 'closed' ? 'journal.lastSeen' : 'connections.speed'), true)}
        {@render sortHead('total', t('connections.total'), true)}
        {@render sortHead('start', t(view === 'closed' ? 'journal.observedEnd' : 'connections.time'), true)}
        <th class={core.prizrak ? 'w-24' : 'w-12'}><span class="sr-only">{t('connections.close')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each displayedRows as c (rowKey(c))}
        <tr class="group border-t border-line transition-colors {selected === rowKey(c) ? 'bg-selected' : 'hover:bg-hover'}" data-testid={c.journal ? 'journal-row' : 'active-connection-row'}>
          <td class="pl-4"><span class="led" data-on={c.dl + c.ul > 0} title={c.dl + c.ul > 0 ? t('connections.active') : t('connections.idle')}></span></td>
          <td class="max-w-[320px] px-3 py-2">
            <button class="block max-w-full truncate text-left" aria-expanded={selected === rowKey(c)} aria-label={t('journal.details', { host: host(c) })} onclick={() => selected = selected === rowKey(c) ? '' : rowKey(c)} title={host(c)}>{host(c)}<span class="text-fg-3">:{c.metadata.destinationPort}</span></button>
            <div class="mt-0.5 truncate font-mono text-xs text-fg-3">
              {c.metadata.network} · {deviceName(c) || c.metadata.process || c.metadata.sourceIP}
            </div>
          </td>
          <td class="max-w-[220px] px-3 py-2">
            <div class="truncate">{c.rule}</div>
            {#if c.rulePayload}<div class="mt-0.5 truncate font-mono text-xs text-fg-3" title={c.rulePayload}>{c.rulePayload}</div>{/if}
          </td>
          <td class="max-w-[240px] truncate px-3 py-2 text-fg-2" title={chain(c)}>{chain(c)}</td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
            {#if c.journal}
              <span class="text-fg-2">{stamp(c.journal.lastSeenAt)}</span>
            {:else}
            <div class={c.dl ? 'text-traffic-down-ink' : 'text-fg-3'}>↓ {speed(c.dl)}</div>
            <div class="mt-0.5 {c.ul ? 'text-traffic-up-ink' : 'text-fg-3'}">↑ {speed(c.ul)}</div>
            {/if}
          </td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
            <div class={c.download ? 'text-traffic-down-ink' : 'text-fg-3'}>↓ {bytes(c.download)}</div>
            <div class="mt-0.5 {c.upload ? 'text-traffic-up-ink' : 'text-fg-3'}">↑ {bytes(c.upload)}</div>
          </td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-fg-2">
            {#if c.journal}{stamp(c.journal.closedAt)}{#if c.journal.afterGap}<span class="mt-1 block max-w-52 whitespace-normal font-sans text-fg-3">{t('journal.afterGap')}</span>{/if}
            {:else}{since(c.start, now)}{/if}
          </td>
          <td class="whitespace-nowrap pr-3 text-right">
            {#if !c.journal}
            {#if usesSmart(c)}
              <Button
                size="sm"
                variant="ghost"
                type="button"
                class="w-11 !px-0 sm:w-8"
                aria-label={t('prizrak.switchNode', { host: host(c) })}
                title={t('prizrak.switchNode', { host: host(c) })}
                aria-busy={!!switching[JSON.stringify(c.id)]}
                disabled={!!switching[JSON.stringify(c.id)] || !canSwitch(c)}
                onclick={() => switchNode(c)}
              >
                <IconRefresh class="size-4" strokeWidth={1.5} aria-hidden="true" />
              </Button>
            {/if}
            <Button
              size="sm"
              variant="ghost"
              type="button"
              class="w-11 !px-0 sm:w-8"
              aria-label={t('connections.closeHost', { host: host(c) })}
              onclick={() => close(c.id)}
            >
              <IconClose class="size-4" strokeWidth={1.5} aria-hidden="true" />
            </Button>
            {:else}
              <Button size="sm" variant="ghost" class="w-11 !px-0 sm:w-8" aria-label={t('journal.details', { host: host(c) })} aria-expanded={selected === rowKey(c)} onclick={() => selected = selected === rowKey(c) ? '' : rowKey(c)}><IconChevron class="size-4 {selected === rowKey(c) ? 'rotate-180' : ''}" strokeWidth={1.5} /></Button>
            {/if}
          </td>
        </tr>
        {#if selected === rowKey(c)}
          <tr><td colspan="8" class="border-t border-line bg-raised p-4 sm:p-5">
            <dl class="grid max-w-[calc(100vw-64px)] gap-4 text-xs sm:grid-cols-2 lg:max-w-none lg:grid-cols-3" data-testid="connection-details">
              <div class="min-w-0"><dt class="text-fg-3">{t('journal.source')}</dt><dd class="mt-1 break-all font-mono">{deviceName(c)} {c.metadata.sourceIP}:{c.metadata.sourcePort}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('journal.destination')}</dt><dd class="mt-1 break-all font-mono">{host(c)} · {c.metadata.destinationIP}:{c.metadata.destinationPort}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('connections.chain')}</dt><dd class="mt-1 break-words">{chain(c) || '—'}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('connections.rule')}</dt><dd class="mt-1 break-all font-mono">{c.rule} {c.rulePayload}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('journal.process')}</dt><dd class="mt-1 break-all font-mono">{c.metadata.processPath || c.metadata.process || '—'}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('journal.started')}</dt><dd class="num mt-1 font-mono">{stamp(Date.parse(c.start))}</dd></div>
              {#if c.journal}<div><dt class="text-fg-3">{t('journal.firstSeen')}</dt><dd class="num mt-1 font-mono">{stamp(c.journal.firstSeenAt)}</dd></div>{/if}
            </dl>
          </td></tr>
        {/if}
      {:else}
        <tr class="border-t border-line">
          <td colspan="8" class="px-4 py-8 text-center text-fg-3">{query ? t('connections.noResults') : view === 'closed' ? t('journal.empty') : t('connections.noConnections')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if view === 'closed' && pages > 1}
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3" data-testid="journal-pagination" role="group" aria-label={t('journal.pages')}>
      <span class="num font-mono text-xs text-fg-3">{t('journal.page', { current: count(currentPage), pages: count(pages) })}</span>
      <div class="flex gap-2">
        <Button size="sm" disabled={currentPage === 1} onclick={() => page = currentPage - 1}>{t('journal.previous')}</Button>
        <Button size="sm" disabled={currentPage === pages} onclick={() => page = currentPage + 1}>{t('journal.next')}</Button>
      </div>
    </div>
  {:else if view === 'active' && rows.length > LIMIT}
    <p class="border-t border-line px-4 py-3 font-mono text-xs text-fg-3">{t('connections.limit', { limit: count(LIMIT) })}</p>
  {/if}
</div>

<Confirm
  bind:open={confirmAll}
  title={t('connections.confirmTitle')}
  description={t('connections.confirmDescription', { count: core.conns.length, total: count(core.conns.length) })}
  action={t('connections.closeAll')}
  onconfirm={() => api.closeAll()}
/>
