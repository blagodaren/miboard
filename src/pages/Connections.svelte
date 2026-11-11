<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, ApiError, errorMessage } from '../lib/api'
  import { notifications } from '../lib/notifications.svelte'
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
  import { connectionEndpoint, connectionSearchText } from '../lib/connection-details'
  import ConnectionDetails from '../components/ConnectionDetails.svelte'
  import Info from '@lucide/svelte/icons/info'
  import Columns from '@lucide/svelte/icons/columns-3'
  import { CONNECTION_COLUMNS_KEY, CONNECTION_COLUMN_OPTIONS as columnOptions, DEFAULT_CONNECTION_COLUMNS as defaultColumns, readConnectionColumns, type ConnectionColumn as ColumnKey } from '../lib/connection-columns'

  type SortKey = 'rate' | 'total' | 'start' | 'host'
  const LIMIT = 300
  const JOURNAL_PAGE_SIZE = 100
  let page = $state(1)
  type DisplayRow = ConnRow & { journal?: JournalEntry }
  let view = $state<'active' | 'closed'>('active')
  let selected = $state('')
  let detailsOpen = $state(false)
  let selectedSnapshot = $state.raw<DisplayRow | null>(null)
  let visibleColumns = $state<ColumnKey[]>(readConnectionColumns())
  let columnsOpen = $state(false)
  const columnCount = $derived(8 + visibleColumns.length)
  const visible = (column: ColumnKey) => visibleColumns.includes(column)
  const columnLabel = (column: ColumnKey) => t(column === 'destination' ? 'journal.destination' : `connectionDetails.${column}`)
  let deviceNames = $state<Record<string, string>>({})
  const archived = $derived(connectionJournal.backendUrl === core.backend.url ? connectionJournal.entries : [])
  const viewTotal = $derived(view === 'active' ? core.conns.length : archived.length)
  const views = $derived([{ value: 'active' as const, label: t('journal.active') }, { value: 'closed' as const, label: t('journal.closed') }])
  const dateFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'medium' }))
  const stamp = (value: number) => Number.isFinite(value) && value > 0 ? dateFormat.format(value) : '—'
  const rowKey = (row: DisplayRow) => row.journal ? JSON.stringify([row.id, row.start, row.journal.firstSeenAt]) : row.id
  const deviceName = (row: DisplayRow) => deviceNames[normalizeDeviceIP(row.metadata.sourceIP)] ?? ''
  function changeView(value: 'active' | 'closed') { view = value; selected = ''; detailsOpen = false; selectedSnapshot = null; paused = false; sort = value === 'closed' ? 'start' : 'rate'; sortDirection = 'desc' }

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

  onDestroy(() => { active = false })

  $effect(() => {
    try {
      const names: unknown = JSON.parse(localStorage.getItem('miboard.device-names.' + encodeURIComponent(backend.url)) ?? '{}')
      if (names && typeof names === 'object' && !Array.isArray(names)) deviceNames = Object.fromEntries(Object.entries(names).filter(([, name]) => typeof name === 'string' && name.length <= 128))
    } catch { /* Device labels are optional local metadata. */ }
  })

  function saveColumns(columns: ColumnKey[]) {
    visibleColumns = columns
    try { localStorage.setItem(CONNECTION_COLUMNS_KEY, JSON.stringify(columns)) } catch { /* Keep this session's selection. */ }
  }

  function toggleColumn(column: ColumnKey, enabled: boolean) {
    saveColumns(enabled ? [...visibleColumns, column] : visibleColumns.filter(key => key !== column))
  }

  function showDetails(connection: DisplayRow) {
    selected = rowKey(connection)
    selectedSnapshot = connection
    detailsOpen = true
  }

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
    const name = host(c)
    try {
      await api.closeSmartConnection(c.id, backend)
      if (currentBackend()) notifications.show({ id: `connection-switch-${c.id}`, tone: 'success', scope: backend.url, message: () => t('prizrak.switchDone', { host: name }) })
    } catch (error) {
      if (currentBackend()) notifications.show({ id: `connection-switch-${c.id}`, tone: 'error', scope: backend.url, message: () => t('prizrak.switchError', { host: name, message: errorMessage(error) }) })
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

  const host = (c: ConnRow) => c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP || '—'
  const chain = (c: ConnRow) => [...c.chains].reverse().join(' / ')
  const optionalRate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? speed(value) : '—'
  const sourceRows: DisplayRow[] = $derived(view === 'closed'
    ? archived.map(journal => ({ ...journal.connection, dl: 0, ul: 0, journal }))
    : paused ? frozen : core.conns)
  const selectedCurrent = $derived(sourceRows.find(row => rowKey(row) === selected && row.start === selectedSnapshot?.start))
  const detailConnection = $derived(selectedCurrent ?? selectedSnapshot)
  const detailStatus = $derived(detailConnection?.journal ? 'closed' : !selectedCurrent ? 'snapshot' : paused ? 'paused' : core.connectionsOnline ? 'live' : 'offline')

  $effect(() => {
    if (detailsOpen && selectedCurrent && selectedCurrent !== selectedSnapshot) selectedSnapshot = selectedCurrent
  })

  function changeSort(key: SortKey) {
    if (sort === key) {
      sortDirection = sortDirection === 'desc' ? 'asc' : 'desc'
    } else {
      sort = key
      sortDirection = key === 'host' ? 'asc' : 'desc'
    }
  }

  const rows = $derived.by(() => {
    const src = sourceRows
    const q = query.trim().toLowerCase()
    const list = q
      ? src.filter((c) => connectionSearchText(c, deviceName(c)).includes(q))
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
    const name = host(core.conns.find(row => row.id === id)!)
    try {
      await api.closeConnection(id)
      if (currentBackend()) notifications.show({ id: `connection-close-${id}`, tone: 'success', scope: backend.url, message: () => t('connections.closeDone', { host: name }) })
    } catch (error) {
      if (!currentBackend()) return
      const alreadyClosed = error instanceof ApiError && error.status === 404
      notifications.show({ id: `connection-close-${id}`, tone: alreadyClosed ? 'info' : 'error', scope: backend.url, message: () => t(alreadyClosed ? 'connections.alreadyClosed' : 'connections.closeError', { host: name, message: errorMessage(error) }) })
    }
  }
  async function closeAll() {
    if (view !== 'active' || !currentBackend()) return
    try {
      await api.closeAll()
      if (currentBackend()) notifications.show({ id: 'connections-close-all', tone: 'success', scope: backend.url, message: () => t('connections.closeAllDone') })
    } catch (error) {
      if (currentBackend()) notifications.show({ id: 'connections-close-all', tone: 'error', scope: backend.url, message: () => t('connections.closeAllError', { message: errorMessage(error) }) })
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
    <SearchInput bind:value={query} placeholder={t('connectionDetails.search')} />
    {#if view === 'active'}
    <Button size="sm" onclick={togglePause} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('connections.resume')}{:else}<IconPause strokeWidth={1.5} />{t('connections.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => (confirmAll = true)} disabled={!core.conns.length}>{t('connections.closeAll')}</Button>
    {/if}
  {/snippet}
</PageHeader>

<div class="connections-toolbar">
  <Segmented value={view} options={views} onchange={changeView} label={t('journal.view')} />
  <Button size="sm" data-testid="connection-columns-toggle" aria-expanded={columnsOpen} aria-controls="connection-columns" onclick={() => columnsOpen = !columnsOpen}><Columns strokeWidth={1.5} aria-hidden="true" />{t('connectionDetails.columns')}<span class="num text-fg-3">{visibleColumns.length}</span></Button>
</div>
{#if columnsOpen}
  <section id="connection-columns" class="column-options" data-testid="connection-columns" aria-label={t('connectionDetails.columns')}>
    <div class="column-options-grid">
      {#each columnOptions as column (column)}
        <label><input type="checkbox" data-column={column} checked={visible(column)} onchange={event => toggleColumn(column, event.currentTarget.checked)} />{columnLabel(column)}</label>
      {/each}
    </div>
    <Button size="sm" variant="ghost" data-testid="connection-columns-reset" onclick={() => saveColumns([...defaultColumns])}>{t('connectionDetails.resetColumns')}</Button>
  </section>
{/if}
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

<div class="connections-table relative overflow-x-auto rounded-panel border border-line bg-card" data-testid="connections-table">
  <table class="w-full min-w-[960px] text-[13px]">
    <thead>
      <tr>
        <th class="w-12 px-3"><span class="sr-only">{t('connectionDetails.details')}</span></th>
        {#if visible('type')}<th class="{th} text-left">{t('connectionDetails.type')}</th>{/if}
        {#if visible('process')}<th class="{th} text-left">{t('connectionDetails.process')}</th>{/if}
        {@render sortHead('host', t('connections.host'))}
        {#if visible('sniffHost')}<th class="{th} text-left">{t('connectionDetails.sniffHost')}</th>{/if}
        {#if visible('source')}<th class="{th} text-left">{t('connectionDetails.source')}</th>{/if}
        {#if visible('destination')}<th class="{th} text-left">{columnLabel('destination')}</th>{/if}
        {#if visible('inbound')}<th class="{th} text-left">{t('connectionDetails.inbound')}</th>{/if}
        {#if visible('dnsMode')}<th class="{th} text-left">{t('connectionDetails.dnsMode')}</th>{/if}
        <th class="{th} text-left">{t('connections.rule')}</th>
        <th class="{th} text-left">{t('connections.chain')}</th>
        {#if visible('provider')}<th class="{th} text-left">{t('connectionDetails.provider')}</th>{/if}
        {@render sortHead('rate', t(view === 'closed' ? 'journal.lastSeen' : 'connections.speed'), true)}
        {#if visible('peakSpeed')}<th class="{th} text-right">{t('connectionDetails.peakSpeed')}</th>{/if}
        {@render sortHead('total', t('connections.total'), true)}
        {@render sortHead('start', t(view === 'closed' ? 'journal.observedEnd' : 'connections.time'), true)}
        <th class={core.prizrak ? 'w-24' : 'w-12'}><span class="sr-only">{t('connections.close')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each displayedRows as c (rowKey(c))}
        <tr class="group border-t border-line transition-colors {detailsOpen && selected === rowKey(c) ? 'bg-selected' : 'hover:bg-hover'}" data-testid={c.journal ? 'journal-row' : 'active-connection-row'}>
          <td class="px-2"><Button size="sm" variant="ghost" class="w-11 !px-0 sm:w-8" aria-label={t('journal.details', { host: host(c) })} aria-haspopup="dialog" onclick={() => showDetails(c)}><Info strokeWidth={1.5} class={c.dl + c.ul > 0 ? 'text-traffic-down-ink' : 'text-fg-3'} aria-hidden="true" /></Button></td>
          {#if visible('type')}<td class="px-3 py-2 whitespace-nowrap"><span>{c.metadata.type || '—'}</span><div class="mt-0.5 font-mono text-xs text-fg-3">{c.metadata.network?.toUpperCase() || '—'}</div></td>{/if}
          {#if visible('process')}<td class="max-w-[200px] truncate px-3 py-2" title={c.metadata.processPath || c.metadata.process}>{c.metadata.process || c.metadata.processPath || '—'}</td>{/if}
          <td class="min-w-[190px] max-w-[300px] px-3 py-2">
            <button class="block max-w-full truncate text-left hover:text-accent-ink" aria-haspopup="dialog" aria-label={t('journal.details', { host: host(c) })} onclick={() => showDetails(c)} title={connectionEndpoint(host(c), c.metadata.destinationPort)}>{connectionEndpoint(host(c), c.metadata.destinationPort)}</button>
            <div class="mt-0.5 truncate font-mono text-xs text-fg-3">
              {c.metadata.network} · {deviceName(c) || c.metadata.process || c.metadata.sourceIP}
            </div>
          </td>
          {#if visible('sniffHost')}<td class="max-w-[240px] truncate px-3 py-2 font-mono text-xs text-fg-2" title={c.metadata.sniffHost}>{c.metadata.sniffHost || '—'}</td>{/if}
          {#if visible('source')}<td class="px-3 py-2 whitespace-nowrap font-mono text-xs"><div>{connectionEndpoint(c.metadata.sourceIP, c.metadata.sourcePort)}</div>{#if deviceName(c)}<div class="mt-0.5 text-fg-3">{deviceName(c)}</div>{/if}</td>{/if}
          {#if visible('destination')}<td class="max-w-[240px] px-3 py-2 font-mono text-xs text-fg-2"><div class="truncate" title={c.metadata.remoteDestination || connectionEndpoint(c.metadata.destinationIP, c.metadata.destinationPort)}>{c.metadata.remoteDestination || connectionEndpoint(c.metadata.destinationIP, c.metadata.destinationPort)}</div>{#if c.metadata.destinationIP && c.metadata.remoteDestination}<div class="mt-0.5 truncate text-fg-3" title={connectionEndpoint(c.metadata.destinationIP, c.metadata.destinationPort)}>{connectionEndpoint(c.metadata.destinationIP, c.metadata.destinationPort)}</div>{/if}</td>{/if}
          {#if visible('inbound')}<td class="max-w-[210px] px-3 py-2"><div class="truncate" title={c.metadata.inboundName}>{c.metadata.inboundName || '—'}</div><div class="mt-0.5 truncate font-mono text-xs text-fg-3" title={c.metadata.inboundUser || connectionEndpoint(c.metadata.inboundIP, c.metadata.inboundPort)}>{c.metadata.inboundUser || connectionEndpoint(c.metadata.inboundIP, c.metadata.inboundPort)}</div></td>{/if}
          {#if visible('dnsMode')}<td class="px-3 py-2 whitespace-nowrap font-mono text-xs text-fg-2">{c.metadata.dnsMode || '—'}</td>{/if}
          <td class="max-w-[220px] px-3 py-2">
            <div class="truncate">{c.rule || '—'}</div>
            {#if c.rulePayload}<div class="mt-0.5 truncate font-mono text-xs text-fg-3" title={c.rulePayload}>{c.rulePayload}</div>{/if}
          </td>
          <td class="max-w-[240px] truncate px-3 py-2 text-fg-2" title={chain(c)}>{chain(c) || '—'}</td>
          {#if visible('provider')}<td class="max-w-[200px] truncate px-3 py-2 text-fg-2" title={c.providerChains?.filter(Boolean).join(' / ')}>{c.providerChains?.filter(Boolean).join(' / ') || '—'}</td>{/if}
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
            {#if c.journal}
              <span class="text-fg-2">{stamp(c.journal.lastSeenAt)}</span>
            {:else}
            <div class={c.dl ? 'text-traffic-down-ink' : 'text-fg-3'}>↓ {speed(c.dl)}</div>
            <div class="mt-0.5 {c.ul ? 'text-traffic-up-ink' : 'text-fg-3'}">↑ {speed(c.ul)}</div>
            {/if}
          </td>
          {#if visible('peakSpeed')}<td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-fg-2"><div>↓ {optionalRate(c.maxDownloadRate)}</div><div class="mt-0.5">↑ {optionalRate(c.maxUploadRate)}</div></td>{/if}
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
              <Button size="sm" variant="ghost" class="w-11 !px-0 sm:w-8" aria-label={t('journal.details', { host: host(c) })} aria-haspopup="dialog" onclick={() => showDetails(c)}><Info class="size-4" strokeWidth={1.5} /></Button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr class="border-t border-line">
          <td colspan={columnCount} class="px-4 py-8 text-center text-fg-3">{query ? t('connections.noResults') : view === 'closed' ? t('journal.empty') : t('connections.noConnections')}</td>
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

<ConnectionDetails bind:open={detailsOpen} connection={detailConnection} deviceName={detailConnection ? deviceName(detailConnection) : ''} status={detailStatus} />

<Confirm
  bind:open={confirmAll}
  title={t('connections.confirmTitle')}
  description={t('connections.confirmDescription', { count: core.conns.length, total: count(core.conns.length) })}
  action={t('connections.closeAll')}
  onconfirm={closeAll}
/>

<style>
  .connections-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
  .column-options { margin-bottom: 16px; padding: 12px 16px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); }
  .column-options-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px 16px; margin-bottom: 8px; }
  .column-options label { display: flex; align-items: center; gap: 9px; min-height: 36px; color: var(--text-2); font-size: 13px; cursor: pointer; }
  .column-options input { width: 16px; height: 16px; flex-shrink: 0; accent-color: var(--accent); }
  .connections-table { max-width: 100%; }
  @media (max-width: 639px) {
    .connections-toolbar { flex-wrap: wrap; gap: 8px; }
    .column-options-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 10px; }
    .column-options { padding: 10px 12px; }
    .column-options label { min-height: 44px; font-size: 12px; }
  }
</style>
