<script lang="ts">
  import { onMount } from 'svelte'
  import { api, errorMessage, type Proxy, type ProxyProvider } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { count, delayBand } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { readProxySort, saveProxySort, sortableProviderNames, sortProxyNames, type ProxySort, type ProxySortKey } from '../lib/proxy-sort'
  import { planProxySelection, SELECTABLE_PROXY_TYPES } from '../lib/proxy-selection'
  import { createDelayTester, delayTestUrl, delayHistorySample, delayMeasurementName, resolveProxyLeaf, IPV6_TEST_URL, type DelaySettings, type DelayTarget } from '../lib/latency'
  import { delaySettings } from '../lib/latency.svelte'
  import { runProxyGroupBatch } from '../lib/proxy-batch'
  import { IconCheck, IconClose, IconChevron, IconZap, IconCopy } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import ProxySortControls from '../components/ProxySortControls.svelte'
  import ProxyGroupIcon from '../components/ProxyGroupIcon.svelte'
  import LatencyProgress from '../components/LatencyProgress.svelte'
  import LatencyDistribution from '../components/LatencyDistribution.svelte'
  import SmartGroupDetails from '../components/SmartGroupDetails.svelte'
  import ProxySelectionNotice, { type ProxySelectionNoticeData } from '../components/ProxySelectionNotice.svelte'

  const SELECTABLE = SELECTABLE_PROXY_TYPES
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
  let proxyProviders = $state.raw<Record<string, ProxyProvider>>({})
  let nodeProviders = $state<Record<string, string>>({})
  type Measurement = { delay: number; history: string; request: number; name: string; settings: DelaySettings }
  let measurements = $state<Record<string, Measurement>>({})
  const measurementRequests = new Map<string, number>()
  let measurementSequence = 0
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
  let selecting = $state<Record<string, boolean>>({})
  const nodesSelecting = $derived(Object.keys(selecting).length > 0)
  let selectionBusy = $state(false)
  let selectionSource = $state('')
  let selectionController: AbortController | null = null
  let selectionNotice = $state.raw<ProxySelectionNoticeData | null>(null)
  let appliedGroup = $state('')
  let appliedTimer: ReturnType<typeof setTimeout> | undefined

  function clearAppliedFeedback() {
    clearTimeout(appliedTimer)
    appliedTimer = undefined
    appliedGroup = ''
  }

  const sortingId = (group: string) => JSON.stringify([core.backend.url, group])
  const sortingFor = (group: string) => sorting[sortingId(group)] ?? readProxySort(core.backend.url, group)

  function changeSorting(group: string, key: ProxySortKey) {
    const next: ProxySort = { key, direction: 'asc' }
    sorting[sortingId(group)] = next
    saveProxySort(core.backend.url, group, next)
  }

  function toggleDirection(group: string) {
    const previous = sortingFor(group)
    const next: ProxySort = { ...previous, direction: previous.direction === 'asc' ? 'desc' : 'asc' }
    sorting[sortingId(group)] = next
    saveProxySort(core.backend.url, group, next)
  }

  const currentBackend = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret

  async function applySelectionToAll(group: string) {
    if (!currentBackend() || selectionBusy || nodesSelecting || metadataLoading || groupsTesting || nodesTesting || batch?.running) return
    const plan = planProxySelection(proxies, group)
    if (!plan.node) return
    clearAppliedFeedback()
    selectionNotice = null
    selectionBusy = true
    selectionSource = group
    const controller = new AbortController()
    selectionController = controller
    const applied = new Set<string>()
    const failed = new Map<string, string>()
    try {
      await runProxyGroupBatch(plan.targets, async (name) => {
        if (!currentBackend()) { controller.abort(); return }
        try {
          await api.select(name, plan.node, backend, controller.signal)
          if (!currentBackend() || controller.signal.aborted) return
          if (proxies[name]) proxies[name].now = plan.node
          applied.add(name)
        } catch (error) {
          if (!controller.signal.aborted) failed.set(name, errorMessage(error))
        }
      }, () => {}, { concurrency: 2, signal: controller.signal })
      if (!currentBackend() || controller.signal.aborted) return
      selectionNotice = {
        node: plan.node,
        applied: plan.targets.filter((name) => applied.has(name)),
        unchanged: plan.unchanged,
        missing: plan.missing,
        unsupported: plan.unsupported,
        unsafe: plan.unsafe,
        failed: plan.targets.filter((name) => failed.has(name)).map((group) => ({ group, message: failed.get(group)! })),
      }
      if (!failed.size) {
        appliedGroup = group
        appliedTimer = setTimeout(clearAppliedFeedback, 2000)
      }
    } finally {
      if (selectionController === controller) selectionController = null
      if (active) { selectionBusy = false; selectionSource = '' }
    }
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
    // Провайдеры дополняют /proxies; старые ядра могут дублировать их узлы.
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
      proxyProviders = data.providers
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
      clearAppliedFeedback()
      selectionController?.abort()
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

  function beginMeasurements(keys: string[]): number {
    const request = ++measurementSequence
    for (const key of new Set(keys)) {
      measurementRequests.set(key, request)
      delete measurements[key]
    }
    return request
  }

  function recordMeasurement(key: string, name: string, settings: DelaySettings, delay: number, request: number) {
    if (!active || measurementRequests.get(key) !== request) return
    measurements[key] = { delay, history: historyKey(name, settings), request, name, settings }
  }

  async function refreshMeasurements(request: number) {
    // Refreshes initiated by an older group must also preserve a newer single-node result.
    const preserved = Object.entries(measurements).filter(([, result]) => result.request >= request)
    await load()
    if (!active) return
    for (const [key, result] of preserved) {
      if (measurements[key]?.request !== result.request || measurementRequests.get(key) !== result.request) continue
      measurements[key].history = historyKey(result.name, result.settings)
    }
  }

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
  const sortableNodes = $derived(sortableProviderNames(proxies, proxyProviders))
  const visible = (g: Proxy) => sortProxyNames(
    (g.all ?? []).filter((n) => !q || n.toLowerCase().includes(q)),
    sortingFor(g.name), nodeMetadata, i18n.intlLocale, (name) => lastDelay(name, g),
    (name) => sortableNodes.has(name),
  )
  const groupDelays = (g: Proxy) => [...new Set(g.all ?? [])].map((name) => lastDelay(name, g))

  async function select(g: Proxy, name: string) {
    const key = JSON.stringify(g.name)
    if (!currentBackend() || selectionBusy || selecting[key] || !SELECTABLE.has(g.type) || g.now === name) return
    clearAppliedFeedback()
    const prev = g.now
    selecting[key] = true
    proxies[g.name].now = name
    try {
      await api.select(g.name, name, backend, batchController.signal)
    } catch (e) {
      if (!currentBackend()) return
      proxies[g.name].now = prev
      error = e instanceof Error ? e : new Error(String(e))
      failedSelection = name
    } finally {
      if (active) delete selecting[key]
    }
  }

  async function test(g: Proxy, inBatch = false) {
    if (selectionBusy || progressFor(g.name) || (!inBatch && (loading || metadataLoading))) return
    const testKey = JSON.stringify(g.name)
    const settings = { ...delaySettings.value, url: delayTestUrl(g, delaySettings.value) }
    const members = [...new Set(g.all ?? [])]
      .filter((name) => nodeMetadata(name)?.type !== 'Reject' && nodeMetadata(name)?.type !== 'RejectDrop')
    const entries = members.map((name) => {
      const historyName = delayMeasurementName(name, settings.independent, nodeMetadata)
      return { name, historyName, key: measurementKey(name, settings), target: requestTarget(settings.mode === 'core' ? name : historyName) }
    })
    const targets = entries.map((entry) => entry.target)
    const directKeys = new Set(entries.filter((entry) => entry.name === entry.historyName).map((entry) => entry.key))
    // Strategy groups can use a different URL; their raw delays do not describe the shared leaf.
    const fallback = settings.mode === 'core' && !settings.independent
      ? [...new Map(entries.filter((entry) => !directKeys.has(entry.key)).map((entry) => [entry.key, entry])).values()]
      : []
    const total = new Set(targets.map((target) => target.name)).size + fallback.length
    const request = beginMeasurements(entries.map((entry) => entry.key))
    testing[testKey] = { done: 0, total, ipv6: false }
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
        testing[testKey] = { done: 0, total, ipv6: false }
      }
      await tester.testGroup(g.name, targets, settings, (name, delay) => {
        if (!active) return
        for (const entry of entries) {
          if (entry.target.name !== name) continue
          if (settings.mode === 'core' && delayMeasurementName(entry.name, settings.independent, nodeMetadata) !== entry.historyName) continue
          if (settings.mode === 'core' && !settings.independent && entry.name !== entry.historyName) continue
          recordMeasurement(entry.key, entry.historyName, settings, delay, request)
        }
        testing[testKey].done++
      })
      await Promise.all(fallback.map(async (entry) => {
        if (!active || measurementRequests.get(entry.key) !== request
          || delayMeasurementName(entry.name, settings.independent, nodeMetadata) !== entry.historyName) {
          if (active) testing[testKey].done++
          return
        }
        try {
          const result = await tester.testNode(requestTarget(entry.historyName), settings)
          recordMeasurement(entry.key, entry.historyName, settings, result.delay, request)
        } catch (error) {
          recordMeasurement(entry.key, entry.historyName, settings, 0, request)
          if (active) testError = { name: entry.historyName, error }
        } finally {
          if (active) testing[testKey].done++
        }
      }))
    } catch (error) {
      mainFailed = true
      if (active) testError = { name: g.name, error }
      if (inBatch) throw error
    } finally {
      if (active) {
        await refreshMeasurements(request)
        if (mainFailed && settings.ipv6) {
          for (const entry of entries) {
            const leaf = resolveProxyLeaf(entry.historyName, nodeMetadata)
            // Legacy cores have no URL buckets to distinguish the optional probe.
            if (leaf && !nodeMetadata(leaf)?.extra) recordMeasurement(entry.key, entry.historyName, settings, 0, request)
          }
        }
        delete testing[testKey]
      }
    }
  }

  async function testAll() {
    if (selectionBusy || batch?.running || groupsTesting || nodesTesting || loading || metadataLoading) return
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
    if (selectionBusy || nodeTesting[key] || progressFor(group.name) || batch?.running || metadataLoading) return
    const target = requestTarget(delayMeasurementName(name, settings.independent, nodeMetadata))
    nodeTesting[key] = true
    batch = null
    const request = beginMeasurements([key])
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
      recordMeasurement(key, target.name, settings, result.delay, request)
    } catch (error) {
      failed = true
      if (active) testError = { name, error }
    } finally {
      if (active) {
        await refreshMeasurements(request)
        if (failed) recordMeasurement(key, target.name, settings, 0, request)
        delete nodeTesting[key]
      }
    }
  }

  const bandClass = { fast: 'text-good', ok: 'text-warning', slow: 'text-bad', dead: 'text-fg-3', none: 'text-fg-3' }
  const delayText = (d: number | undefined) => (d === undefined || !Number.isFinite(d) || d <= 0 ? '—' : t('proxies.delay', { delay: d }))
  const delayStatusId = (group: string, name: string) => `proxy-delay-status-${encodeURIComponent(JSON.stringify([group, name]))}`
</script>

<PageHeader title={t('proxies.title')} meta={groups.length ? t('proxies.groups', { count: groups.length }) : undefined}>
  {#snippet actions()}
    <Button size="sm" onclick={testAll} disabled={selectionBusy || loading || metadataLoading || !groups.length || groupsTesting || nodesTesting || !!batch?.running} aria-label={t('proxies.testAll')}><IconZap strokeWidth={1.5} />{t(batch?.running ? 'proxies.testingAll' : 'proxies.testAll')}</Button>
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
  <p class="mb-4 rounded-[var(--radius-card)] border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{t('latency.testError', { name: testError.name, message: errorMessage(testError.error) })}</p>
{/if}

{#if errorText}
  <p class="mb-4 rounded-[var(--radius-card)] border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{errorText}</p>
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
        <section class="min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-card shadow-[var(--shadow-panel)]">
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
            <Button size="sm" variant="ghost" onclick={() => test(g)} disabled={selectionBusy || !!progressFor(g.name) || nodesTesting || metadataLoading || !!batch?.running} aria-label={t('proxies.testGroup', { name: g.name })}>
              <IconZap strokeWidth={1.5} />
              <span class="hidden sm:inline" role="status">{progressFor(g.name) ? `${progressFor(g.name).ipv6 ? 'IPv6 · ' : ''}${t('latency.testProgress', { done: progressFor(g.name).done, total: progressFor(g.name).total })}` : t('proxies.latency')}</span>
            </Button>
          </div>

          <div class="h-1" data-testid="proxy-latency-strip" data-group={g.name}>
            {#if progressFor(g.name)}
              {@const progress = progressFor(g.name)}
              <LatencyProgress label={t('proxies.testGroup', { name: g.name })} done={progress.done} total={progress.total} indeterminate={progress.done === 0 && progress.total > 0} />
            {:else}
              <LatencyDistribution values={groupDelays(g)} yellow={delaySettings.value.yellow} red={delaySettings.value.red} label={t('latency.distributionLabel', { name: g.name })} />
            {/if}
          </div>

          {#if isOpen}
            {#if g.type === 'Smart'}<SmartGroupDetails group={g} {backend} />{/if}
            <ProxySortControls group={g.name} {order} onchange={(key) => changeSorting(g.name, key)} onreverse={() => toggleDirection(g.name)}>
              {#snippet actions()}
                <Button
                  size="sm"
                  variant="ghost"
                  class="ml-auto shrink-0 px-2 text-xs"
                  data-testid="proxy-selection-apply"
                  data-group={g.name}
                  aria-label={t('proxies.selectionApplyAllLabel', { node: g.now ?? '', group: g.name })}
                  title={g.now && g.all?.includes(g.now) ? t('proxies.selectionApplyAllLabel', { node: g.now, group: g.name }) : t('proxies.selectionNothingToApply')}
                  aria-busy={selectionBusy && selectionSource === g.name}
                  disabled={!g.now || !g.all?.includes(g.now) || selectionBusy || nodesSelecting || metadataLoading || groupsTesting || nodesTesting || !!batch?.running}
                  onclick={() => applySelectionToAll(g.name)}
                >
                  {#if appliedGroup === g.name}<IconCheck strokeWidth={1.5} aria-hidden="true" />{:else}<IconCopy strokeWidth={1.5} aria-hidden="true" />{/if}
                  <span class="text-xs leading-4">{t(selectionBusy && selectionSource === g.name ? 'proxies.selectionApplyingShort' : appliedGroup === g.name ? 'proxies.selectionAppliedShort' : 'proxies.selectionApplyShort')}</span>
                </Button>
              {/snippet}
            </ProxySortControls>
            <div class="grid grid-cols-1 gap-2 bg-raised px-3 pb-3 pt-1 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] xl:max-h-[min(560px,65dvh)] xl:overflow-y-auto xl:overscroll-contain">
              {#each nodes as name (name)}
                {@const d = lastDelay(name, g)}
                {@const sel = g.now === name}
                {@const busy = nodeBusy(name, g)}
                <div class="relative min-w-0 {delaySettings.value.ipv6 ? 'h-[104px] sm:h-[88px]' : 'h-[88px] sm:h-[72px]'}" data-proxy-node={name}>
                <button
                  disabled={!selectable || selectionBusy || !!selecting[JSON.stringify(g.name)]}
                  aria-pressed={sel}
                  onclick={() => select(g, name)}
                  class="absolute inset-0 flex w-full min-w-0 flex-col justify-between rounded-[var(--radius-control)] border px-3 py-3 text-left transition-colors duration-150
                    {sel
                    ? 'border-selected-border bg-selected text-selected-text shadow-[inset_3px_0_0_var(--selected-border)]'
                    : 'border-line bg-card enabled:hover:border-line-strong enabled:hover:bg-hover'}
                    disabled:cursor-default"
                >
                  <span class="flex w-full min-w-0 items-center gap-2 text-[13px]">
                    <span class="min-w-0 flex-1 truncate {sel ? 'font-medium' : ''}" title={name}>{name}</span>
                    {#if sel}<IconCheck class="size-4 shrink-0 text-selected-text" strokeWidth={1.5} aria-hidden="true" />{/if}
                  </span>
                  <span class="flex w-full min-w-0 items-center gap-2 pr-20 font-mono text-xs">
                    <span class="truncate text-fg-2" title={t('proxies.protocol')}>{protocol(name)}</span>
                  </span>
                  {#if delaySettings.value.ipv6}
                    {@const supported = ipv6For(name)}
                    <span role="img" aria-label={ipv6Label(supported)} title={ipv6Label(supported)} data-ipv6-state={supported === true ? 'available' : supported === false ? 'unavailable' : 'untested'} class="inline-flex self-start items-center gap-1 text-xs leading-4 {supported === true ? 'text-good' : supported === false ? 'text-bad' : 'text-fg-3'}">
                      IPv6
                      {#if supported === true}<IconCheck class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else if supported === false}<IconClose class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else}<span aria-hidden="true">—</span>{/if}
                    </span>
                  {/if}
                </button>
                <button class="num absolute bottom-1 right-1 inline-flex h-11 min-w-12 items-center justify-end rounded-md px-2 font-mono text-xs transition-colors hover:bg-hover disabled:cursor-wait disabled:opacity-60 sm:h-7 {bandClass[delayBand(d, delaySettings.value.yellow, delaySettings.value.red)]}" aria-label={t(busy ? 'proxies.testingNode' : 'proxies.retestNode', { name })} aria-describedby={!busy && d !== undefined && d <= 0 ? delayStatusId(g.name, name) : undefined} title={`${t('proxies.retestNode', { name })}${!busy && d !== undefined && d <= 0 ? ` · ${t('proxies.noResponse')}` : ''}`} aria-busy={busy} disabled={selectionBusy || busy || metadataLoading || !!progressFor(g.name) || !!batch?.running} onclick={() => retestNode(g, name)}>
                  {busy ? '…' : delayText(d)}
                </button>
                {#if !busy && d !== undefined && d <= 0}<span id={delayStatusId(g.name, name)} class="sr-only">{t('proxies.noResponse')}</span>{/if}
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

<ProxySelectionNotice notice={selectionNotice} onclose={() => (selectionNotice = null)} />
