<script lang="ts">
  import { core } from '../lib/core.svelte'
  import { summarizeDevices, normalizeDeviceIP, UNKNOWN_DEVICE, type DeviceConnection, type DeviceStat } from '../lib/devices'
  import { bytes, count, speed } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import { IconDevices, IconPause, IconPlay, IconConnections } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Button from '../components/Button.svelte'
  import DeviceFlow from '../components/DeviceFlow.svelte'

  let metric = $state<'traffic' | 'connections'>('traffic')
  let query = $state('')
  let selected = $state<string | null>(null)
  let paused = $state(false)
  let frozen = $state.raw<DeviceConnection[]>([])
  let names = $state.raw<Record<string, string>>({})
  let aliasDraft = $state('')
  let aliasStatus = $state<'saved' | 'error' | null>(null)
  let listLimit = $state(50)
  const storageKey = $derived('miboard.device-names.' + encodeURIComponent(core.backend.url))
  const source = $derived(paused ? frozen : core.conns)
  const snapshot = $derived(summarizeDevices(source))
  const devices = $derived.by(() => {
    const q = query.trim().toLocaleLowerCase(i18n.intlLocale)
    return snapshot.devices.filter((device) => !q || [device.sourceIP, deviceName(device), ...device.domains, ...device.processes]
      .join(' ').toLocaleLowerCase(i18n.intlLocale).includes(q))
      .sort((a, b) => (metric === 'traffic' ? b.total - a.total : b.connections - a.connections) || a.id.localeCompare(b.id))
  })
  const visibleIDs = $derived(new Set(devices.map((device) => device.id)))
  const effectiveSelected = $derived(selected && visibleIDs.has(selected) ? selected : null)
  const selectedDevice = $derived(snapshot.devices.find((device) => device.id === effectiveSelected))
  const filteredConnections = $derived(source.filter((connection) => visibleIDs.has(deviceId(connection))))
  const detailConnections = $derived(effectiveSelected ? filteredConnections.filter((connection) => deviceId(connection) === effectiveSelected) : filteredConnections)
  const detail = $derived(summarizeDevices(detailConnections))
  const total = $derived(detail.totals)
  const destinations = $derived.by(() => {
    const seen = new Set<string>()
    const rows = new Map<string, { name: string; download: number; upload: number; connections: number }>()
    for (const connection of detailConnections) {
      if (!connection.id || seen.has(connection.id)) continue
      seen.add(connection.id)
      const name = connection.metadata.host?.trim() || connection.metadata.sniffHost?.trim() || connection.metadata.destinationIP?.trim() || t('devices.unknownDomain')
      const row = rows.get(name) ?? { name, download: 0, upload: 0, connections: 0 }
      row.download += counter(connection.download)
      row.upload += counter(connection.upload)
      row.connections++
      rows.set(name, row)
    }
    return [...rows.values()].sort((a, b) => (metric === 'traffic' ? b.download + b.upload - a.download - a.upload : b.connections - a.connections) || a.name.localeCompare(b.name, i18n.intlLocale)).slice(0, 8)
  })
  const destinationValue = (row: { download: number; upload: number; connections: number }) => metric === 'traffic' ? row.download + row.upload : row.connections
  const maxDestination = $derived(Math.max(1, ...destinations.map(destinationValue)))
  const protocols = $derived(`TCP ${count(total.tcp)} · UDP ${count(total.udp)}`)
  const firstSeen = $derived.by(() => {
    const times = detail.devices.map((device) => device.firstSeen).filter((time): time is number => time !== null)
    return times.length ? Math.min(...times) : null
  })
  const summary = $derived([
    { label: t('devices.deviceCount'), value: count(snapshot.devices.length), caption: t('devices.meta') },
    { label: t('devices.connections'), value: count(snapshot.totals.connections), caption: `TCP ${count(snapshot.totals.tcp)} · UDP ${count(snapshot.totals.udp)}` },
    { label: t('devices.traffic'), value: bytes(snapshot.totals.total), caption: `↓ ${bytes(snapshot.totals.download)} · ↑ ${bytes(snapshot.totals.upload)}` },
    { label: t('devices.speed'), value: speed(snapshot.totals.dl + snapshot.totals.ul), caption: `↓ ${speed(snapshot.totals.dl)} · ↑ ${speed(snapshot.totals.ul)}` },
  ])

  function counter(value: number) { return Number.isFinite(value) ? Math.max(0, value) : 0 }
  function deviceId(connection: DeviceConnection) { return normalizeDeviceIP(connection.metadata.sourceIP) || UNKNOWN_DEVICE }
  function deviceName(device: DeviceStat) { return names[device.id] || device.sourceIP || t('devices.unknownDevice') }
  function combined(field: 'domains' | 'destinationIPs' | 'proxies' | 'rules' | 'processes' | 'inbounds') {
    return [...new Set(detail.devices.flatMap((device) => device[field]))].sort((a, b) => a.localeCompare(b, i18n.intlLocale))
  }
  function selectDevice(id: string | null) {
    selected = id
    aliasDraft = id ? names[id] ?? '' : ''
    aliasStatus = null
  }
  function togglePause() {
    if (!paused) frozen = core.conns
    paused = !paused
  }
  function saveName(event: SubmitEvent) {
    event.preventDefault()
    if (!selectedDevice?.sourceIP) return
    const next = { ...names }
    const name = aliasDraft.trim().slice(0, 64)
    if (name) next[selectedDevice.id] = name
    else delete next[selectedDevice.id]
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      names = next
      aliasDraft = name
      aliasStatus = 'saved'
    } catch { aliasStatus = 'error' }
  }

  $effect(() => {
    const key = storageKey
    const loaded: Record<string, string> = {}
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, name] of Object.entries(parsed).slice(0, 1000)) {
          if (normalizeDeviceIP(id) === id && typeof name === 'string' && name.trim() && name.length <= 64) loaded[id] = name.trim()
        }
      }
    } catch { /* Device statistics still work without browser storage. */ }
    names = loaded
    selected = null
    aliasDraft = ''
    aliasStatus = null
    paused = false
    frozen = []
    query = ''
  })

  $effect(() => { void query; listLimit = 50 })
</script>

<PageHeader title={t('devices.title')} meta={t('devices.meta')}>
  {#snippet actions()}
    <span class="live-status"><span class="led" data-on={core.connectionsOnline && !paused} data-state={!core.connectionsOnline && !paused ? 'down' : undefined}></span>{paused ? t('devices.paused') : core.connectionsOnline ? t('devices.live') : t('devices.offline')}</span>
    <Button size="sm" data-testid="devices-pause" onclick={togglePause} aria-pressed={paused} disabled={!core.connectionsReady}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('devices.resume')}{:else}<IconPause strokeWidth={1.5} />{t('devices.pause')}{/if}
    </Button>
  {/snippet}
</PageHeader>

<section class="device-summary" aria-label={t('devices.overview')}>
  {#each summary as item (item.label)}
    <div class="summary-item" data-testid="device-summary">
      <div class="summary-label"><h2>{item.label}</h2></div>
      <p class="summary-value num">{core.connectionsReady ? item.value : '—'}</p>
      <p class="summary-caption num" title={item.caption}>{item.caption}</p>
    </div>
  {/each}
</section>

{#if !core.connectionsOnline && core.connectionsReady && !paused}
  <p class="stream-warning" role="status">{t('devices.streamLost')}</p>
{/if}

<div class="devices-toolbar">
  <div class="device-search" data-testid="device-search"><SearchInput bind:value={query} placeholder={t('devices.search')} /></div>
  <div class="toolbar-actions">
    {#if effectiveSelected}<Button size="sm" variant="ghost" data-testid="devices-all" onclick={() => selectDevice(null)}>{t('devices.allDevices')}</Button>{/if}
    <label class="metric-label"><span>{t('devices.metric')}</span><select data-testid="devices-metric" bind:value={metric}><option value="traffic">{t('devices.byTraffic')}</option><option value="connections">{t('devices.byConnections')}</option></select></label>
  </div>
</div>

<DeviceFlow connections={filteredConnections} {metric} selectedDevice={effectiveSelected} onselect={selectDevice} {names} />

<p class="scope-note">{t('devices.activeOnly')}</p>

<div class="devices-layout">
  <section class="device-list-panel" aria-labelledby="device-list-title">
    <header class="panel-heading"><h2 id="device-list-title">{t('devices.listTitle')}</h2><span class="num text-xs text-fg-3">{t('devices.listCount', { shown: Math.min(listLimit, devices.length), total: snapshot.devices.length })}</span></header>
    <div class="device-list">
      {#each devices.slice(0, listLimit) as device (device.id)}
        <button class="device-row" class:chosen={effectiveSelected === device.id} data-testid="device-row" data-device-id={device.id} aria-pressed={effectiveSelected === device.id} aria-label={t('devices.selectDevice', { name: deviceName(device) })} onclick={() => selectDevice(effectiveSelected === device.id ? null : device.id)}>
          <span class="device-row-top"><span class="device-icon"><IconDevices size={18} strokeWidth={1.5} aria-hidden="true" /></span><span class="device-row-name"><strong title={deviceName(device)}>{deviceName(device)}</strong><span class="num">{names[device.id] ? device.sourceIP : device.sourceIP.includes(':') ? 'IPv6' : device.sourceIP ? 'IPv4' : t('devices.unavailable')}</span></span><strong class="num device-volume">{metric === 'traffic' ? bytes(device.total) : count(device.connections)}</strong></span>
          <span class="device-usage" data-metric={metric} aria-hidden="true">{#if metric === 'traffic'}<span style:width="{snapshot.totals.total ? device.download / snapshot.totals.total * 100 : 0}%"></span><span class="upload-bar" style:width="{snapshot.totals.total ? device.upload / snapshot.totals.total * 100 : 0}%"></span>{:else}<span style:width="{snapshot.totals.connections ? device.connections / snapshot.totals.connections * 100 : 0}%"></span>{/if}</span>
          <span class="device-row-bottom num"><span>↓ {speed(device.dl)}</span><span>↑ {speed(device.ul)}</span><span class="connection-count"><IconConnections size={12} strokeWidth={1.5} />{count(device.connections)}</span></span>
        </button>
      {:else}
        <div class="device-empty"><IconDevices size={28} strokeWidth={1} /><p>{!core.connectionsReady ? t('devices.loading') : query.trim() ? t('devices.noResults') : t('devices.empty')}</p>{#if !query.trim()}<span>{t('devices.emptyHint')}</span>{/if}</div>
      {/each}
      {#if listLimit < devices.length}<button class="show-more" onclick={() => { listLimit += 50 }}>{t('devices.showMore')}</button>{/if}
    </div>
  </section>

  <section class="device-detail-panel" data-testid="device-details" data-device-id={effectiveSelected ?? 'all'} aria-labelledby="device-detail-title">
    <header class="panel-heading"><div class="detail-title"><h2 id="device-detail-title">{selectedDevice ? deviceName(selectedDevice) : t('devices.overview')}</h2><p>{selectedDevice?.sourceIP || (selectedDevice ? t('devices.unknownDevice') : t('devices.allDevices'))}</p></div><span class="protocol-badge num">{protocols}</span></header>
    <div class="detail-body">
      {#if selectedDevice?.sourceIP}
        <form class="alias-form" onsubmit={saveName}>
          <label for="device-alias">{t('devices.name')}</label>
          <div class="alias-controls"><input id="device-alias" data-testid="device-alias-input" bind:value={aliasDraft} oninput={() => { aliasStatus = null }} maxlength="64" placeholder={t('devices.namePlaceholder')} /><Button size="sm" type="submit" data-testid="device-alias-save" disabled={aliasDraft.trim() === (names[selectedDevice.id] ?? '')}>{t('devices.saveName')}</Button></div>
          <p class="alias-hint" role="status">{aliasStatus === 'saved' ? t('devices.nameSaved') : aliasStatus === 'error' ? t('devices.nameError') : t('devices.nameHint')}</p>
        </form>
      {/if}
      <dl class="detail-metrics">
        {#each [
          { label: t('devices.download'), value: bytes(total.download) },
          { label: t('devices.upload'), value: bytes(total.upload) },
          { label: t('devices.connections'), value: count(total.connections) },
          { label: t('devices.domains'), value: count(combined('domains').length) },
        ] as item (item.label)}<div><dt>{item.label}</dt><dd class="num">{item.value}</dd></div>{/each}
      </dl>

      <div class="destination-heading"><h3>{t('devices.topDomains')}</h3><span class="text-xs text-fg-3">{t(metric === 'traffic' ? 'devices.byTraffic' : 'devices.byConnections')}</span></div>
      <div class="destinations">
        {#each destinations as destination (destination.name)}
          <div class="destination-row" data-testid="device-detail-domain"><div class="destination-name"><span title={destination.name}>{destination.name}</span><strong class="num">{metric === 'traffic' ? bytes(destination.download + destination.upload) : count(destination.connections)}</strong></div><div class="destination-bar" aria-hidden="true"><span style:width="{destinationValue(destination) / maxDestination * 100}%"></span></div></div>
        {:else}<p class="empty-destinations">{t('devices.noDomains')}</p>{/each}
      </div>

      <dl class="device-metadata">
        {#each [
          { label: t('devices.proxies'), values: combined('proxies') },
          { label: t('devices.rules'), values: combined('rules') },
          { label: t('devices.processes'), values: combined('processes') },
          { label: t('devices.inbounds'), values: combined('inbounds') },
          { label: t('devices.destinationIPs'), values: combined('destinationIPs') },
        ] as item (item.label)}
          <div><dt>{item.label}</dt><dd>{#if item.values.length}<details><summary><span class="metadata-preview" title={item.values.join(', ')}>{item.values.slice(0, 3).join(', ')}{item.values.length > 3 ? ` +${count(item.values.length - 3)}` : ''}</span><span class="metadata-count num">{count(item.values.length)}</span></summary><ul>{#each item.values as value (value)}<li>{value}</li>{/each}</ul></details>{:else}<span class="text-fg-3">{t('devices.unavailable')}</span>{/if}</dd></div>
        {/each}
        <div><dt>{t('devices.oldestConnection')}</dt><dd class="num">{firstSeen === null ? t('devices.unavailable') : new Date(firstSeen).toLocaleString(i18n.intlLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
      </dl>
    </div>
  </section>
</div>
<div class="device-notes"><p>{t('devices.ipIdentity')}</p><p>{t('devices.noHardware')}</p></div>

<style>
  .live-status { display: inline-flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
  .device-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .summary-item { min-width: 0; padding: 20px; }
  .summary-item + .summary-item { border-left: 1px solid var(--line); }
  .summary-label { display: flex; align-items: center; gap: 8px; color: var(--text-2); }
  .summary-label h2 { font-size: 12px; font-weight: 400; }
  .summary-value { margin-top: 12px; font-size: 28px; line-height: 32px; font-weight: 500; }
  .summary-caption { margin-top: 8px; overflow: hidden; color: var(--text-3); font-size: 12px; line-height: 20px; text-overflow: ellipsis; white-space: nowrap; }
  .stream-warning { margin-top: 16px; padding: 12px 16px; border: 1px solid var(--warning-border); border-radius: var(--radius-card); background: var(--warning-surface); color: var(--text-2); font-size: 13px; }
  .devices-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin: 24px 0 16px; }
  .device-search { min-width: 0; flex: 1; }
  .device-search :global(label) { width: 100%; max-width: 360px; }
  .toolbar-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .metric-label { display: flex; align-items: center; gap: 12px; color: var(--text-3); font-size: 12px; }
  select { max-width: 100%; min-height: 36px; padding: 0 28px 0 12px; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--field); color: var(--text); font: inherit; cursor: pointer; }
  .scope-note { margin-top: 8px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .devices-layout { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(0, 1.6fr); gap: 24px; margin-top: 24px; align-items: start; }
  .device-list-panel, .device-detail-panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .panel-heading { display: flex; min-height: 64px; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
  .panel-heading h2 { min-width: 0; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; }
  .device-list { display: flex; flex-direction: column; gap: 8px; padding: 8px; max-height: 680px; overflow-y: auto; }
  .device-row { padding: 12px; border: 1px solid transparent; border-radius: var(--radius-card); text-align: left; cursor: pointer; transition: background-color 150ms, border-color 150ms; }
  .device-row:hover { background: var(--hover); }
  .device-row.chosen { background: var(--selected); border-color: var(--selected-border); }
  .device-row:active { transform: translateY(1px); }
  .device-row-top { display: flex; align-items: center; min-width: 0; gap: 12px; }
  .device-icon { display: flex; flex-shrink: 0; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--text-2); }
  .device-row-name { display: block; min-width: 0; flex: 1; }
  .device-row-name strong { display: block; overflow: hidden; font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .device-row-name > span { display: block; overflow: hidden; color: var(--text-3); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .device-volume { flex-shrink: 0; font-size: 12px; font-weight: 500; }
  .device-usage { display: flex; height: 4px; margin: 12px 0 8px 44px; overflow: hidden; border-radius: 2px; background: var(--raised); }
  .device-usage > span { background: var(--traffic-down); }
  .device-usage > .upload-bar { background: var(--traffic-up); }
  .device-row-bottom { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: 44px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .device-row-bottom > span { white-space: nowrap; }
  .device-row-bottom > span:first-child { color: var(--traffic-down-ink); }
  .connection-count { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
  .device-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 20px; color: var(--text-3); text-align: center; }
  .device-empty p { color: var(--text-2); font-size: 13px; }
  .device-empty > span { font-size: 12px; line-height: 20px; }
  .show-more { min-height: 40px; border-radius: var(--radius-control); color: var(--text-2); font-size: 12px; cursor: pointer; }
  .show-more:hover { background: var(--hover); }
  .detail-title { min-width: 0; flex: 1; }
  .detail-title > p { overflow-wrap: anywhere; margin-top: 4px; color: var(--text-3); font-family: var(--font-mono); font-size: 12px; line-height: 20px; }
  .protocol-badge { padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; color: var(--text-2); font-family: var(--font-mono); font-size: 12px; }
  .detail-body { padding: 20px; }
  .alias-form { margin-bottom: 20px; }
  .alias-form label { display: block; margin-bottom: 8px; color: var(--text-2); font-size: 12px; }
  .alias-controls { display: flex; align-items: center; gap: 8px; }
  .alias-controls input { flex: 1; min-width: 0; min-height: 36px; padding: 8px 12px; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--field); color: var(--text); font-size: 13px; }
  .alias-controls input::placeholder { color: var(--text-3); }
  .alias-hint { margin-top: 8px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .detail-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
  .detail-metrics dt { color: var(--text-3); font-size: 12px; line-height: 20px; }
  .detail-metrics dd { margin-top: 4px; font-size: 18px; font-weight: 500; white-space: nowrap; }
  .destination-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 24px 0 12px; }
  h3 { font-size: 14px; font-weight: 500; }
  .destinations { display: flex; flex-direction: column; gap: 12px; }
  .destination-name { display: flex; justify-content: space-between; gap: 12px; color: var(--text-2); font-size: 12px; line-height: 20px; }
  .destination-name > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .destination-name > strong { flex-shrink: 0; font-size: 12px; font-weight: 500; }
  .destination-bar { height: 4px; margin-top: 8px; overflow: hidden; border-radius: 2px; background: var(--raised); }
  .destination-bar > span { display: block; height: 100%; background: var(--accent); }
  .empty-destinations { padding: 16px 0; color: var(--text-3); font-size: 12px; }
  .device-metadata { display: grid; gap: 16px; margin-top: 24px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 12px; }
  .device-metadata > div { display: grid; grid-template-columns: minmax(100px, .7fr) minmax(0, 1.5fr); gap: 12px; }
  .device-metadata dt { color: var(--text-3); }
  .device-metadata dd { min-width: 0; color: var(--text-2); overflow-wrap: anywhere; }
  .device-metadata summary { display: flex; align-items: baseline; gap: 8px; cursor: pointer; }
  .device-metadata summary:hover { color: var(--text); }
  .metadata-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .metadata-count { color: var(--text-3); font-family: var(--font-mono); font-size: 12px; }
  .device-metadata ul { display: grid; gap: 4px; max-height: 180px; overflow-y: auto; margin-top: 8px; padding: 8px 12px; border-radius: 6px; background: var(--raised); }
  .device-notes { display: grid; gap: 4px; margin-top: 16px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  @media (max-width: 1099px) { .devices-layout { grid-template-columns: minmax(0, 1fr); } .device-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 360px; } }
  @media (max-width: 767px) {
    .device-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .summary-item { padding: 16px; }
    .summary-item:nth-child(3) { border-left: 0; }
    .summary-item:nth-child(n+3) { border-top: 1px solid var(--line); }
    .summary-value { font-size: 24px; }
    .devices-toolbar { align-items: stretch; }
    .device-search { flex-basis: 100%; }
    .device-search :global(label) { max-width: none; }
    .toolbar-actions { justify-content: space-between; width: 100%; }
    .metric-label { flex-wrap: wrap; }
    select { min-height: 44px; }
    .device-list { grid-template-columns: 1fr; }
    .device-metadata > div { grid-template-columns: 100px minmax(0, 1fr); gap: 8px; }
    .detail-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .alias-controls { align-items: stretch; flex-direction: column; }
    .alias-controls input { min-height: 44px; }
    .detail-body, .panel-heading { padding-left: 16px; padding-right: 16px; }
  }
  @media (prefers-reduced-motion: reduce) { .device-row { transition: none; } }
  .device-usage[data-metric='connections'] > span { background: var(--text-3); }
  .detail-metrics > div { min-width: 0; }
  .detail-metrics dd { overflow-wrap: anywhere; white-space: normal; }
</style>
