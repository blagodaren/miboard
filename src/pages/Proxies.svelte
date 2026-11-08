<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errorMessage, type Proxy } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { count, delayBand } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { readProxySort, saveProxySort, saveProxySortForGroups, sortProxyNames, type ProxySort, type ProxySortKey } from '../lib/proxy-sort'
  import { createDelayTester, delayTestUrl, delayHistorySample, delayMeasurementName, resolveProxyLeaf, IPV6_TEST_URL, type DelaySettings, type DelayTarget } from '../lib/latency'
  import { delaySettings } from '../lib/latency.svelte'
  import { runProxyGroupBatch } from '../lib/proxy-batch'
  import { IconCheck, IconClose, IconChevron, IconZap } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import ProxySortControls from '../components/ProxySortControls.svelte'
  import ProxyGroupIcon from '../components/ProxyGroupIcon.svelte'
  import LatencyProgress from '../components/LatencyProgress.svelte'

  const SELECTABLE = new Set(['Selector', 'Fallback'])
  const backend = { ...core.backend }
  let active = true
  const batchController = new AbortController()
  const tester = createDelayTester({
    groupDelay: (group, url, timeout, signal) => api.groupDelay(group, url, timeout, backend, signal),
    proxyDelay: (target, url, timeout, signal) => target.provider
      ? api.providerProxyDelay(target.provider, target.name, url, timeout, backend, signal)
      : api.proxyDelay(target.name, url, timeout, backend, signal),
  })

  let proxies = $state<Record<string, Proxy>>({})
  let providerNodes = $state<Record<string, Proxy>>({})
  let nodeProviders = $state<Record<string, string>>({})
  let measurements = $state<Record<string, { delay: number; history: string }>>({})
  let ipv6Results = $state<Record<string, boolean>>({})
  let loading = $state(true)
  let metadataLoading = $state(true)
  let loadSequence = 0
  let pendingLoads = 0
  let error = $state.raw<Error | null>(null)
  let failedSelection = $state('')
  const errorText = $derived(error ? (failedSelection ? t('proxies.selectError', { name: failedSelection, message: errorMessage(error) }) : errorMessage(error)) : '')
  let query = $state('')
  let testing = $state<Record<string, { done: number; total: number; ipv6: boolean }>>({})
  const progressFor = (group: string) => testing[JSON.stringify(group)]
  let nodeTesting = $state<Record<string, boolean>>({})
  let batch = $state<{ running: boolean; done: number; total: number; failed: number } | null>(null)
  const groupsTesting = $derived(Object.keys(testing).length > 0)
  const nodesTesting = $derived(Object.keys(nodeTesting).length > 0)
  let testError = $state.raw<{ name: string; error: unknown } | null>(null)
  let open = $state<Record<string, boolean>>(loadOpen())
  let sorting = $state<Record<string, ProxySort>>({})
  let appliedGroup = $state('')

  const sortingId = (group: string) => JSON.stringify([core.backend.url, group])
  const sortingFor = (group: string) => sorting[sortingId(group)] ?? readProxySort(core.backend.url, group)

  function changeSorting(group: string, key: ProxySortKey) {
    appliedGroup = ''
    const next: ProxySort = { key, direction: 'asc' }
    sorting[sortingId(group)] = next
    saveProxySort(core.backend.url, group, next)
  }

  function toggleDirection(group: string) {
    appliedGroup = ''
    const previous = sortingFor(group)
    const next: ProxySort = { ...previous, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
    sorting[sortingId(group)] = next
    saveProxySort(core.backend.url, group, next)
  }

  function applySortingToAll(group: string) {
    const settings = { ...sortingFor(group) }
    // Включаем свёрнутые, скрытые поиском группы и GLOBAL для глобального режима.
    const names = Object.values(proxies).filter((proxy) => Array.isArray(proxy.all)).map((proxy) => proxy.name)
    const next = { ...sorting }
    for (const name of names) next[sortingId(name)] = { ...settings }
    sorting = next
    saveProxySortForGroups(core.backend.url, names, settings)
    appliedGroup = group
  }

  function loadOpen(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem('miboard.groups') ?? '{}')
    } catch {
      return {}
    }
  }
  function toggle(name: string, isOpen: boolean) {
    open[name] = !isOpen
    try {
      localStorage.setItem('miboard.groups', JSON.stringify(open))
    } catch {
      /* ок */
    }
  }

  async function load() {
    const sequence = ++loadSequence
    pendingLoads++
    metadataLoading = true
    // Узлы из proxy-providers не входят в /proxies, там остаются ссылки из групп.
    const providers = api.proxyProviders(backend).then((data) => {
      if (!active || sequence !== loadSequence) return
      const nodes: Record<string, Proxy> = Object.create(null)
      const owners: Record<string, string> = Object.create(null)
      for (const [name, provider] of Object.entries(data.providers)) {
        for (const node of provider.proxies ?? []) {
          nodes[node.name] ??= node
          owners[node.name] ??= name
        }
      }
      providerNodes = nodes
      nodeProviders = owners
    }).catch(() => {
      // Старые ядра могут не поддерживать этот эндпоинт; обычные прокси доступны.
    })
    try {
      const data = await api.proxies(backend)
      if (active && sequence === loadSequence) {
        proxies = data.proxies
        error = null
        failedSelection = ''
      }
    } catch (e) {
      if (active && sequence === loadSequence) {
        error = e instanceof Error ? e : new Error(String(e))
        failedSelection = ''
      }
    } finally {
      if (active && sequence === loadSequence) loading = false
    }
    await providers
    pendingLoads--
    if (active) metadataLoading = pendingLoads > 0
  }
  onMount(() => {
    void load()
    void core.refreshConfigs()
    return () => {
      active = false
      batchController.abort()
      tester.dispose()
    }
  })

  // Порядок групп — как в GLOBAL, то есть как в конфиге
  const groups = $derived.by(() => {
    const all = Object.values(proxies).filter((p) => p.all && !p.hidden)
    const order = proxies.GLOBAL?.all ?? []
    const idx = (n: string) => {
      const i = order.indexOf(n)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    }
    const list = all.filter((g) => g.name !== 'GLOBAL').sort((a, b) => idx(a.name) - idx(b.name))
    if (core.configs?.mode === 'global' && proxies.GLOBAL) list.unshift(proxies.GLOBAL)
    return list
  })

  const nodeMetadata = (name: string) => proxies[name] ?? providerNodes[name]
  const protocol = (name: string) => nodeMetadata(name)?.type || t('proxies.protocolUnknown')

  const measurementKey = (name: string, settings: Readonly<DelaySettings>) => JSON.stringify([
    delayMeasurementName(name, settings.independent, nodeMetadata), settings.url, settings.independent,
  ])
  const historyKey = (name: string, settings: Readonly<DelaySettings>) => JSON.stringify(delayHistorySample(name, settings.url, settings.independent, nodeMetadata) ?? null)
  const lastDelay = (name: string, group: Proxy) => {
    const settings = { ...delaySettings.value, url: delayTestUrl(group, delaySettings.value) }
    const measured = measurements[measurementKey(name, settings)]
    const delay = measured && measured.history === historyKey(name, settings)
      ? measured.delay : delayHistorySample(name, settings.url, settings.independent, nodeMetadata)?.delay
    return typeof delay === 'number' && Number.isFinite(delay) ? delay : undefined
  }
  const ipv6For = (name: string) => {
    const leaf = resolveProxyLeaf(name, nodeMetadata)
    if (!leaf) return undefined
    const measured = ipv6Results[JSON.stringify(leaf)]
    if (measured !== undefined) return measured
    const history = nodeMetadata(leaf)?.extra?.[IPV6_TEST_URL]?.history
    const sample = history?.[history.length - 1]
    return sample && Number.isFinite(sample.delay) ? sample.delay > 0 : undefined
  }
  const ipv6Label = (supported: boolean | undefined) => t(supported === true ? 'latency.ipv6Available' : supported === false ? 'latency.ipv6Unavailable' : 'latency.ipv6Untested')
  const requestTarget = (name: string): DelayTarget => ({ name, ...(!Object.hasOwn(proxies, name) && Object.hasOwn(nodeProviders, name) ? { provider: nodeProviders[name] } : {}) })
  const effectiveSettings = (group: Proxy) => ({ ...delaySettings.value, url: delayTestUrl(group, delaySettings.value) })
  const nodeBusy = (name: string, group: Proxy) => !!nodeTesting[measurementKey(name, effectiveSettings(group))]

  const q = $derived(query.trim().toLowerCase())
  const visible = (g: Proxy) => sortProxyNames(
    (g.all ?? []).filter((n) => !q || n.toLowerCase().includes(q)),
    sortingFor(g.name), nodeMetadata, i18n.intlLocale, (name) => lastDelay(name, g),
    // Compatible-провайдеры тоже содержат ручные ноды: корневой /proxies важнее.
    (name) => !Object.hasOwn(proxies, name) && Object.hasOwn(providerNodes, name),
  )

  async function select(g: Proxy, name: string) {
    if (!SELECTABLE.has(g.type) || g.now === name) return
    const prev = g.now
    proxies[g.name].now = name
    try {
      await api.select(g.name, name)
    } catch (e) {
      proxies[g.name].now = prev
      error = e instanceof Error ? e : new Error(String(e))
      failedSelection = name
    }
  }

  async function test(g: Proxy, inBatch = false) {
    if (progressFor(g.name) || (!inBatch && (loading || metadataLoading))) return
    const testKey = JSON.stringify(g.name)
    const settings = { ...delaySettings.value, url: delayTestUrl(g, delaySettings.value) }
    const members = [...new Set(g.all ?? [])]
      .filter((name) => nodeMetadata(name)?.type !== 'Reject' && nodeMetadata(name)?.type !== 'RejectDrop')
    const entries = members.map((name) => {
      const historyName = delayMeasurementName(name, settings.independent, nodeMetadata)
      return { name, historyName, key: measurementKey(name, settings), target: requestTarget(settings.mode === 'core' ? name : historyName) }
    })
    const targets = entries.map((entry) => entry.target)
    testing[testKey] = { done: 0, total: new Set(targets.map((target) => target.name)).size, ipv6: false }
    for (const name of members) delete measurements[measurementKey(name, settings)]
    if (!inBatch) {
      testError = null
      batch = null
    }
    let mainFailed = false
    try {
      if (settings.ipv6) {
        // Automatic groups may ignore a supplied URL, so IPv6 must test actual leaves.
        const leaves = [...new Set(members.map((name) => resolveProxyLeaf(name, nodeMetadata)).filter((name): name is string => !!name))]
        for (const leaf of leaves) delete ipv6Results[JSON.stringify(leaf)]
        testing[testKey] = { done: 0, total: leaves.length, ipv6: true }
        await tester.testIPv6(leaves.map(requestTarget), settings.timeout, (name, supported) => {
          if (!active) return
          ipv6Results[JSON.stringify(name)] = supported
          testing[testKey].done++
        })
        if (!active) return
        testing[testKey] = { done: 0, total: new Set(targets.map((target) => target.name)).size, ipv6: false }
      }
      await tester.testGroup(g.name, targets, settings, (name, delay) => {
        if (!active) return
        for (const entry of entries) {
          if (entry.target.name !== name) continue
          if (settings.mode === 'core' && delayMeasurementName(entry.name, settings.independent, nodeMetadata) !== entry.historyName) continue
          measurements[entry.key] = { delay, history: historyKey(entry.historyName, settings) }
        }
        testing[testKey].done++
      })
    } catch (error) {
      mainFailed = true
      if (active) testError = { name: g.name, error }
      if (inBatch) throw error
    } finally {
      if (active) {
        await load()
        if (mainFailed && settings.ipv6) {
          for (const entry of entries) {
            const leaf = resolveProxyLeaf(entry.historyName, nodeMetadata)
            // Legacy cores have no URL buckets to distinguish the optional probe.
            if (leaf && !nodeMetadata(leaf)?.extra) measurements[entry.key] = { delay: 0, history: historyKey(entry.historyName, settings) }
          }
        }
        delete testing[testKey]
      }
    }
  }

  async function testAll() {
    if (batch?.running || groupsTesting || nodesTesting || loading || metadataLoading) return
    const targets = groups.filter((group) => (group.all?.length ?? 0) > 0)
    if (!targets.length) return
    testError = null
    batch = { running: true, done: 0, total: targets.length, failed: 0 }
    const release = tester.beginBatch()
    try {
      const result = await runProxyGroupBatch(targets, (group) => test(group, true), (done, total) => {
        if (active && batch) batch = { ...batch, done, total }
      }, { concurrency: 2, signal: batchController.signal })
      if (active) batch = { running: false, done: result.completed, total: targets.length, failed: result.failed }
    } finally {
      release()
    }
  }

  async function retestNode(group: Proxy, name: string) {
    const settings = effectiveSettings(group)
    const key = measurementKey(name, settings)
    if (nodeTesting[key] || progressFor(group.name) || batch?.running || metadataLoading) return
    const target = requestTarget(delayMeasurementName(name, settings.independent, nodeMetadata))
    nodeTesting[key] = true
    batch = null
    delete measurements[key]
    testError = null
    let failed = false
    try {
      const leaf = settings.ipv6 ? resolveProxyLeaf(name, nodeMetadata) : undefined
      if (leaf) {
        delete ipv6Results[JSON.stringify(leaf)]
        await tester.testIPv6([requestTarget(leaf)], settings.timeout, (node, supported) => {
          if (active) ipv6Results[JSON.stringify(node)] = supported
        })
      }
      const result = await tester.testNode(target, settings)
      if (active) measurements[key] = { delay: result.delay, history: historyKey(target.name, settings) }
    } catch (error) {
      failed = true
      if (active) testError = { name, error }
    } finally {
      if (active) {
        await load()
        if (failed) measurements[key] = { delay: 0, history: historyKey(target.name, settings) }
        delete nodeTesting[key]
      }
    }
  }

  const bandClass = { fast: 'text-good', ok: 'text-accent-ink', slow: 'text-bad', dead: 'text-bad', none: 'text-fg-3' }
  const delayText = (d: number | undefined) => (d === undefined ? '—' : d <= 0 ? t('proxies.noResponse') : t('proxies.delay', { delay: d }))
</script>

<PageHeader title={t('proxies.title')} meta={groups.length ? t('proxies.groups', { count: groups.length }) : undefined}>
  {#snippet actions()}
    <Button size="sm" onclick={testAll} disabled={loading || metadataLoading || !groups.length || groupsTesting || nodesTesting || !!batch?.running} aria-label={t('proxies.testAll')}><IconZap strokeWidth={1.5} />{t(batch?.running ? 'proxies.testingAll' : 'proxies.testAll')}</Button>
    <SearchInput bind:value={query} placeholder={t('proxies.search')} />
  {/snippet}
</PageHeader>

<p class="mb-3 text-xs text-fg-3" title={t('proxies.sortProviderHint')}>
  {t(delaySettings.value.mode === 'core' ? 'latency.modeCore' : 'latency.modePanel')}
  · {t(core.configs?.['unified-delay'] === true ? 'latency.unifiedOn' : core.configs?.['unified-delay'] === false ? 'latency.unifiedOff' : 'latency.unifiedUnknownShort')}
</p>

{#if batch}
  <div class="mb-4 rounded-xl border border-line bg-card px-4 py-3" role="status">
    <div class="mb-2 flex items-center justify-between gap-3 text-[13px]">
      <span>{t(batch.running ? 'proxies.batchProgress' : batch.failed ? 'proxies.batchFailed' : 'proxies.batchDone', { done: batch.done, total: batch.total, failed: batch.failed })}</span>
      {#if !batch.running}<button class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg" aria-label={t('proxies.dismissTestSummary')} onclick={() => (batch = null)}><IconClose class="size-4" strokeWidth={1.5} /></button>{/if}
    </div>
    <LatencyProgress label={t('proxies.testAll')} done={batch.done} total={batch.total} />
  </div>
{/if}

{#if testError}
  <p class="mb-4 rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-bad" role="alert">{t('latency.testError', { name: testError.name, message: errorMessage(testError.error) })}</p>
{/if}

{#if errorText}
  <p class="mb-4 rounded-xl border border-line bg-card px-4 py-3 text-[13px] text-bad" role="alert">{errorText}</p>
{/if}

{#if loading}
  <p class="text-fg-3">{t('proxies.loading')}</p>
{:else}
  <div class="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
    {#each groups as g, i (g.name)}
      {@const nodes = visible(g)}
      {@const isOpen = q ? nodes.length > 0 : (open[g.name] ?? i < 2)}
      {@const selectable = SELECTABLE.has(g.type)}
      {@const order = sortingFor(g.name)}
      {#if !q || nodes.length}
        <section class="min-w-0 overflow-hidden rounded-2xl border border-line bg-card shadow-[var(--shadow-panel)]">
          <div class="flex items-center gap-3 py-2 pl-2 pr-3">
            <button
              class="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover"
              aria-expanded={isOpen}
              onclick={() => toggle(g.name, isOpen)}
            >
              <IconChevron
                class="size-4 shrink-0 text-fg-3 transition-transform duration-150 {isOpen ? '' : '-rotate-90'}"
                strokeWidth={1.5}
              />
              <ProxyGroupIcon icon={g.icon} name={g.name} backendUrl={backend.url} />
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline gap-2"><span class="truncate font-medium">{g.name}</span><span class="hidden shrink-0 font-mono text-xs text-fg-3 sm:inline">{g.type}</span></span>
                {#if g.now}<span class="mt-0.5 block truncate text-xs text-fg-2" title={g.now}>{g.now}</span>{/if}
              </span>
              <span class="num hidden shrink-0 font-mono text-xs text-fg-3 sm:inline">{count(g.all?.length ?? 0)}</span>
            </button>
            <Button size="sm" variant="ghost" onclick={() => test(g)} disabled={!!progressFor(g.name) || nodesTesting || metadataLoading || !!batch?.running} aria-label={t('proxies.testGroup', { name: g.name })}>
              <IconZap strokeWidth={1.5} />
              <span class="hidden sm:inline" role="status">{progressFor(g.name) ? `${progressFor(g.name).ipv6 ? 'IPv6 · ' : ''}${t('latency.testProgress', { done: progressFor(g.name).done, total: progressFor(g.name).total })}` : t('proxies.latency')}</span>
            </Button>
          </div>

          {#if progressFor(g.name)}
            {@const progress = progressFor(g.name)}
            <div class="border-t border-line px-3 py-2">
              <LatencyProgress label={t('proxies.testGroup', { name: g.name })} done={progress.done} total={progress.total} indeterminate={progress.done === 0 && progress.total > 0} />
            </div>
          {/if}

          {#if isOpen}
            <ProxySortControls group={g.name} {order} applied={appliedGroup === g.name} onchange={(key) => changeSorting(g.name, key)} onreverse={() => toggleDirection(g.name)} onapply={() => applySortingToAll(g.name)} />
            <div class="grid grid-cols-2 gap-2 bg-raised px-3 pb-3 pt-1 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] xl:max-h-[min(560px,65dvh)] xl:overflow-y-auto xl:overscroll-contain">
              {#each nodes as name (name)}
                {@const d = lastDelay(name, g)}
                {@const sel = g.now === name}
                {@const busy = nodeBusy(name, g)}
                <div class="relative min-w-0 {delaySettings.value.ipv6 ? 'h-[96px] sm:h-[80px]' : 'h-[72px] sm:h-16'}" data-proxy-node={name}>
                <button
                  disabled={!selectable}
                  aria-pressed={sel}
                  onclick={() => select(g, name)}
                  class="absolute inset-0 flex w-full min-w-0 flex-col justify-between rounded-[10px] border px-3 py-2.5 text-left transition-colors duration-150
                    {sel
                    ? 'border-selected-border bg-selected text-selected-text shadow-[inset_3px_0_0_var(--selected-border)]'
                    : 'border-line bg-card enabled:hover:border-line-strong enabled:hover:bg-hover'}
                    disabled:cursor-default"
                >
                  <span class="flex w-full min-w-0 items-center gap-2 text-[13px]">
                    <span class="min-w-0 flex-1 truncate {sel ? 'font-medium' : ''}" title={name}>{name}</span>
                    {#if sel}<IconCheck class="size-4 shrink-0 text-selected-text" strokeWidth={2} aria-hidden="true" />{/if}
                  </span>
                  <span class="flex w-full min-w-0 items-center gap-2 pr-[64px] font-mono text-xs">
                    <span class="truncate text-fg-2" title={t('proxies.protocol')}>{protocol(name)}</span>
                  </span>
                  {#if delaySettings.value.ipv6}
                    {@const supported = ipv6For(name)}
                    <span role="img" aria-label={ipv6Label(supported)} title={ipv6Label(supported)} data-ipv6-state={supported === true ? 'available' : supported === false ? 'unavailable' : 'untested'} class="inline-flex items-center gap-1 text-[10px] leading-3 {supported === true ? 'text-good' : supported === false ? 'text-bad' : 'text-fg-3'}">
                      IPv6
                      {#if supported === true}<IconCheck class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else if supported === false}<IconClose class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else}<span aria-hidden="true">—</span>{/if}
                    </span>
                  {/if}
                </button>
                <button class="num absolute right-1 top-[28px] inline-flex h-[44px] min-w-[48px] items-center justify-end rounded-md px-2 font-mono text-xs transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60 sm:h-[26px] {bandClass[delayBand(d, delaySettings.value.yellow, delaySettings.value.red)]}" aria-label={t(busy ? 'proxies.testingNode' : 'proxies.retestNode', { name })} title={t('proxies.retestNode', { name })} aria-busy={busy} disabled={busy || metadataLoading || !!progressFor(g.name) || !!batch?.running} onclick={() => retestNode(g, name)}>
                  {busy ? '…' : delayText(d)}
                </button>
                </div>
              {/each}
            </div>
            {#if !selectable}
              <p class="bg-raised px-5 pb-4 text-xs text-fg-3">{t('proxies.automaticSelection', { type: g.type })}</p>
            {/if}
          {/if}
        </section>
      {/if}
    {:else}
      <p class="text-fg-3">{t('proxies.noGroups')}</p>
    {/each}
  </div>
{/if}
