<script lang="ts">
  import { onMount } from 'svelte'
  import { Tabs } from 'bits-ui'
  import { api, request as apiRequest, errorMessage, type Proxy, type ProxyProvider } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { count, delayBand } from '../lib/format'
  import { t, i18n, type MessageKey } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { readProxySort, saveProxySort, sortableProviderNames, sortProxyNames, type ProxySort, type ProxySortKey } from '../lib/proxy-sort'
  import { planProxySelection, SELECTABLE_PROXY_TYPES } from '../lib/proxy-selection'
  import { createDelayTester, delayTestUrl, delayGroupSettings, delayHistorySample, delayMeasurementName, isLatencyTestable, resolveProxyLeaf, IPV6_TEST_URL, type DelaySettings, type DelayTarget } from '../lib/latency'
  import { proxyCatalog, proxyEndpointKey, readProxyTestSelection, saveProxyTestSelection, type ProxyTestSelection } from '../lib/proxy-test-selection'
  import { delaySettings } from '../lib/latency.svelte'
  import { appearance } from '../lib/appearance.svelte'
  import { runProxyGroupBatch } from '../lib/proxy-batch'
  import { visibleProxyProviders } from '../lib/provider-tools'
  import { IconCheck, IconClose, IconChevron, IconZap, IconCopy } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import ProxySortControls from '../components/ProxySortControls.svelte'
  import ProxyGroupIcon from '../components/ProxyGroupIcon.svelte'
  import LatencyProgress from '../components/LatencyProgress.svelte'
  import LatencyDistribution from '../components/LatencyDistribution.svelte'
  import SmartGroupDetails from '../components/SmartGroupDetails.svelte'
  import ProxyStability from '../components/ProxyStability.svelte'
  import ProxyProviders from '../components/ProxyProviders.svelte'
  import NodeDiagnostics from '../components/NodeDiagnostics.svelte'
  import Segmented from '../components/Segmented.svelte'
  import IconInfo from '@lucide/svelte/icons/info'

  const SELECTABLE = SELECTABLE_PROXY_TYPES
  type ProxyTab = 'groups' | 'providers'
  const tabFromHash = (): ProxyTab => new URLSearchParams(location.hash.split('?')[1] ?? '').get('tab') === 'providers' ? 'providers' : 'groups'
  let tab = $state<ProxyTab>(tabFromHash())
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
  let proxyProviders = $state.raw<Record<string, ProxyProvider>>({})
  const catalog = $derived(proxyCatalog(proxies, proxyProviders))
  let diagnosticOpen = $state(false)
  let diagnosticNode = $state.raw<Proxy | null>(null)
  let diagnosticProvider = $state.raw<ProxyProvider | undefined>(undefined)
  let diagnosticProviderName = $state('')
  function inspectNode(node: Proxy, provider?: ProxyProvider, providerName = '') {
    diagnosticNode = node
    diagnosticProvider = provider
    diagnosticProviderName = providerName
    diagnosticOpen = true
  }
  function inspectGroupNode(name: string) {
    const node = nodeMetadata(name)
    if (!node) return
    const providerName = catalog.resolve(name)?.target.provider || ''
    inspectNode(node, proxyProviders[providerName], providerName)
  }
  const providerCount = $derived(visibleProxyProviders(proxyProviders).length)
  let providerError = $state<string | null>(null)
  let stabilityBusy = $state(false)
  let providersBusy = $state(false)
  const toolsBusy = $derived(stabilityBusy || providersBusy)
  type MeasurementScope = { group?: string; provider?: string }
  type Measurement = { delay: number; history: string; request: number; name: string; settings: DelaySettings; scope: MeasurementScope }
  let measurements = $state<Record<string, Measurement>>({})
  const measurementRequests = new Map<string, number>()
  let measurementSequence = 0
  let ipv6Results = $state<Record<string, boolean>>({})
  const ipv6Requests = new Map<string, number>()
  let loading = $state(true)
  let metadataLoading = $state(true)
  let loadSequence = 0
  let pendingLoads = 0
  let error = $state.raw<Error | null>(null)
  const errorText = $derived(error ? errorMessage(error) : '')
  let query = $state('')
  let testSelection = $state<ProxyTestSelection>(readProxyTestSelection(backend.url))
  let testSelectionSaved = $state(true)
  const testSelectionOptions = $derived([
    { value: 'all' as const, label: t('proxyTest.all') },
    { value: 'selected' as const, label: t('proxyTest.selected') },
  ])
  function changeTestSelection(value: ProxyTestSelection) {
    testSelection = value
    testSelectionSaved = saveProxyTestSelection(backend.url, value)
  }
  function changeTestMode(mode: ProxyTestSelection['mode']) {
    changeTestSelection({ mode, groups: testSelection.mode === 'all' && !testSelection.groups.length ? allTestGroups.map((group) => group.name) : testSelection.groups })
  }
  function chooseTestGroup(name: string, checked: boolean) {
    changeTestSelection({ mode: 'selected', groups: checked ? [...new Set([...testSelection.groups, name])] : testSelection.groups.filter((value) => value !== name) })
  }
  let testing = $state<Record<string, { done: number; total: number; ipv6: boolean }>>({})
  const progressFor = (group: string) => testing[JSON.stringify(group)]
  let nodeTesting = $state<Record<string, boolean>>({})
  let batch = $state<{ kind: 'groups' | 'nodes'; running: boolean; done: number; total: number; failed: number } | null>(null)
  const groupsTesting = $derived(Object.keys(testing).length > 0)
  const nodesTesting = $derived(Object.keys(nodeTesting).length > 0)
  let open = $state<Record<string, boolean>>(loadOpen())
  let sorting = $state<Record<string, ProxySort>>({})
  let selecting = $state<Record<string, boolean>>({})
  const nodesSelecting = $derived(Object.keys(selecting).length > 0)
  let selectionBusy = $state(false)
  let selectionSource = $state('')
  let selectionController: AbortController | null = null
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

  const selectionNoticeId = `proxy-selection:${backend.url}`
  const latencyNoticeId = (name: string) => `proxy-latency:${JSON.stringify([backend.url, name])}`
  function notifyTestError(name: string, cause: unknown) {
    if (!currentBackend()) return
    notifications.show({
      id: latencyNoticeId(name), tone: 'error', scope: backend.url,
      message: () => t('latency.testError', { name, message: errorMessage(cause) }),
      testId: 'proxy-latency-notice',
    })
  }

  function selectionSection(id: string, key: MessageKey, names: string[], tone: 'neutral' | 'warning' = 'neutral') {
    return { id, title: () => t(key, { count: names.length }), tone, items: names.map((label) => ({ label })) }
  }

  async function applySelectionToAll(group: string) {
    if (!currentBackend() || toolsBusy || selectionBusy || nodesSelecting || metadataLoading || groupsTesting || nodesTesting || batch?.running) return
    const plan = planProxySelection(proxies, group)
    if (!plan.node) return
    notifications.dismiss(selectionNoticeId)
    selectionBusy = true
    selectionSource = group
    const controller = new AbortController()
    selectionController = controller
    const applied = new Set<string>()
    const failed = new Map<string, unknown>()
    try {
      await runProxyGroupBatch(plan.targets, async (name) => {
        if (!currentBackend()) { controller.abort(); return }
        try {
          await api.select(name, plan.node, backend, controller.signal)
          if (!currentBackend() || controller.signal.aborted) return
          if (proxies[name]) proxies[name].now = plan.node
          applied.add(name)
        } catch (error) {
          if (!controller.signal.aborted) failed.set(name, error)
        }
      }, () => {}, { concurrency: 2, signal: controller.signal })
      if (!currentBackend() || controller.signal.aborted) return
      const appliedNames = plan.targets.filter((name) => applied.has(name))
      const skipped = plan.missing.length + plan.unsupported.length + plan.unsafe.length
      notifications.show({
        id: selectionNoticeId, tone: failed.size ? 'error' : skipped ? 'warning' : 'success', scope: backend.url,
        title: () => t('proxies.selectionNoticeTitle', { node: plan.node, count: appliedNames.length }),
        testId: 'proxy-selection-notice', closeLabel: () => t('proxies.selectionNoticeClose'),
        sections: [
          { id: 'selection-failed', title: () => t('proxies.selectionFailed', { count: failed.size }), tone: 'error' as const,
            items: plan.targets.filter((name) => failed.has(name)).map((name) => ({ label: name, description: () => errorMessage(failed.get(name)) })) },
          selectionSection('selection-missing', 'proxies.selectionMissing', plan.missing, 'warning'),
          selectionSection('selection-unsupported', 'proxies.selectionUnsupported', plan.unsupported, 'warning'),
          selectionSection('selection-unsafe', 'proxies.selectionUnsafe', plan.unsafe, 'warning'),
          selectionSection('selection-applied', 'proxies.selectionApplied', appliedNames),
          selectionSection('selection-already', 'proxies.selectionAlready', plan.unchanged),
        ].filter((section) => section.items.length > 0),
      })
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

  async function load(signal?: AbortSignal): Promise<boolean> {
    const sequence = ++loadSequence
    pendingLoads++
    metadataLoading = true
    // Провайдеры дополняют /proxies; старые ядра могут дублировать их узлы.
    const providers = apiRequest<{ providers: Record<string, ProxyProvider> }>('/providers/proxies', { signal }, backend).then((data) => {
      if (!active || signal?.aborted || sequence !== loadSequence) return false
      proxyProviders = data.providers
      providerError = null
      return true
    }).catch((error) => {
      // Старые ядра могут не поддерживать этот эндпоинт; обычные прокси доступны.
      if (active && !signal?.aborted && sequence === loadSequence) providerError = errorMessage(error)
      return false
    })
    try {
      const data = await apiRequest<{ proxies: Record<string, Proxy> }>('/proxies', { signal }, backend)
      if (active && !signal?.aborted && sequence === loadSequence) {
        proxies = data.proxies
        error = null
      }
    } catch (e) {
      if (active && !signal?.aborted && sequence === loadSequence) {
        error = e instanceof Error ? e : new Error(String(e))
      }
    } finally {
      if (active && sequence === loadSequence) loading = false
    }
    const providersLoaded = await providers
    pendingLoads--
    if (active) metadataLoading = pendingLoads > 0
    return providersLoaded
  }

  function setTab(next: ProxyTab) {
    if (tab === next) return
    tab = next
    // An update cancelled by leaving Providers may still have reached the controller.
    // Re-read metadata on return, without racing an ongoing group operation.
    if (next === 'providers' && currentBackend() && !toolsBusy && !selectionBusy && !nodesSelecting && !groupsTesting && !nodesTesting && !batch?.running && !metadataLoading) void load()
  }

  function changeTab(next: string) {
    if (next !== 'groups' && next !== 'providers') return
    setTab(next)
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
    if (next === 'providers') params.set('tab', 'providers')
    else params.delete('tab')
    const query = params.toString()
    const hash = `#/proxies${query ? `?${query}` : ''}`
    if (location.hash !== hash) location.hash = hash
  }

  onMount(() => {
    void load()
    void core.refreshConfigs()
    const refreshVisible = () => {
      if (document.visibilityState === 'visible' && currentBackend() && !toolsBusy) void load()
    }
    document.addEventListener('visibilitychange', refreshVisible)
    const syncTab = () => { if (location.hash.split('?')[0].replace(/^#\/?/, '') === 'proxies') setTab(tabFromHash()) }
    window.addEventListener('hashchange', syncTab)
    return () => {
      active = false
      document.removeEventListener('visibilitychange', refreshVisible)
      window.removeEventListener('hashchange', syncTab)
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

  const nodeMetadata = (name: string) => catalog.lookup(name)
  const protocol = (name: string) => catalog.ambiguous(name) ? t('proxyTest.ambiguousShort') : nodeMetadata(name)?.type || t('proxies.protocolUnknown')
  const metadataFor = (scope: MeasurementScope) => (name: string) => scope.provider ? catalog.providerNode(scope.provider, name) ?? nodeMetadata(name) : nodeMetadata(name)
  const endpointKey = (name: string, scope: MeasurementScope = {}) => {
    const target = scope.provider ? { name, provider: scope.provider } : catalog.resolve(name)?.target
    return target ? proxyEndpointKey(target) : JSON.stringify(['group', scope.group ?? null, name])
  }

  const measurementKey = (name: string, settings: Readonly<DelaySettings>, scope: MeasurementScope = {}) => JSON.stringify([
    endpointKey(delayMeasurementName(name, settings.independent, metadataFor(scope)), scope), settings.url, settings.independent,
  ])
  const historyKey = (name: string, settings: Readonly<DelaySettings>, scope: MeasurementScope = {}) => JSON.stringify(delayHistorySample(name, settings.url, settings.independent, metadataFor(scope)) ?? null)

  function beginMeasurements(keys: string[]): number {
    const request = ++measurementSequence
    for (const key of new Set(keys)) {
      measurementRequests.set(key, request)
      delete measurements[key]
    }
    return request
  }

  function recordMeasurement(key: string, name: string, settings: DelaySettings, delay: number, request: number, scope: MeasurementScope = {}) {
    if (!active || measurementRequests.get(key) !== request) return
    measurements[key] = { delay, history: historyKey(name, settings, scope), request, name, settings, scope }
  }

  async function refreshMeasurements(request: number) {
    // Refreshes initiated by an older group must also preserve a newer single-node result.
    const preserved = Object.entries(measurements).filter(([, result]) => result.request >= request)
    await load()
    if (!active) return
    for (const [key, result] of preserved) {
      if (measurements[key]?.request !== result.request || measurementRequests.get(key) !== result.request) continue
      measurements[key].history = historyKey(result.name, result.settings, result.scope)
    }
  }

  const lastDelay = (name: string, group: Proxy) => {
    const settings = { ...delaySettings.value, url: delayTestUrl(group, delaySettings.value) }
    const scope = { group: group.name }
    const measured = measurements[measurementKey(name, settings, scope)]
    const delay = measured && measured.history === historyKey(name, settings, scope)
      ? measured.delay : delayHistorySample(name, settings.url, settings.independent, nodeMetadata)?.delay
    return typeof delay === 'number' && Number.isFinite(delay) ? delay : undefined
  }
  const ipv6For = (name: string, group: Proxy) => {
    const leaf = resolveProxyLeaf(name, nodeMetadata) ?? (catalog.ambiguous(name) ? name : undefined)
    if (!leaf) return undefined
    const measured = ipv6Results[JSON.stringify(endpointKey(leaf, { group: group.name }))]
    if (measured !== undefined) return measured
    const history = nodeMetadata(leaf)?.extra?.[IPV6_TEST_URL]?.history
    const sample = history?.[history.length - 1]
    return sample && Number.isFinite(sample.delay) ? sample.delay > 0 : undefined
  }
  const ipv6Label = (supported: boolean | undefined) => t(supported === true ? 'latency.ipv6Available' : supported === false ? 'latency.ipv6Unavailable' : 'latency.ipv6Untested')
  const requestTarget = (name: string): DelayTarget | undefined => catalog.resolve(name)?.target
  const effectiveSettings = (group: Proxy) => ({ ...delaySettings.value, url: delayTestUrl(group, delaySettings.value) })
  const nodeBusy = (name: string, group: Proxy) => !!nodeTesting[measurementKey(name, effectiveSettings(group), { group: group.name })]

  function beginIPv6(leaves: string[], request: number) {
    for (const leaf of new Set(leaves)) {
      ipv6Requests.set(leaf, request)
      delete ipv6Results[JSON.stringify(leaf)]
    }
  }

  function recordIPv6(leaf: string, supported: boolean, request: number) {
    if (currentBackend() && ipv6Requests.get(leaf) === request) ipv6Results[JSON.stringify(leaf)] = supported
  }

  const allTestGroups = $derived(Object.values(proxies).filter((group) => group.name !== 'GLOBAL' && !!group.all?.length))
  const selectedTestGroups = $derived(testSelection.mode === 'all' ? allTestGroups : allTestGroups.filter((group) => testSelection.groups.includes(group.name)))
  const selectedMembers = $derived(catalog.members(selectedTestGroups.map((group) => group.name)))
  const testGroupsInBatch = $derived(delaySettings.value.independent || (testSelection.mode === 'selected' && selectedMembers.ambiguousNames.length > 0))
  const allTestNodes = $derived(testSelection.mode === 'all' ? catalog.all : selectedMembers.entries)
  const stabilityTargets = $derived(catalog.all.map((entry) => entry.target))
  const hasAllTestTargets = $derived(testGroupsInBatch ? selectedTestGroups.length > 0 : allTestNodes.length > 0)

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
    if (!currentBackend() || toolsBusy || selectionBusy || selecting[key] || !SELECTABLE.has(g.type) || g.now === name) return
    const prev = g.now
    selecting[key] = true
    proxies[g.name].now = name
    try {
      await api.select(g.name, name, backend, batchController.signal)
    } catch (e) {
      if (!currentBackend()) return
      proxies[g.name].now = prev
      notifications.show({
        id: `proxy-select:${JSON.stringify([backend.url, g.name])}`, tone: 'error', scope: backend.url,
        message: () => t('proxies.selectError', { name, message: errorMessage(e) }),
        testId: 'proxy-select-notice',
      })
    } finally {
      if (active) delete selecting[key]
    }
  }

  async function test(g: Proxy, inBatch = false) {
    if (!currentBackend() || toolsBusy || selectionBusy || progressFor(g.name) || (!inBatch && (loading || metadataLoading))) return
    const testKey = JSON.stringify(g.name)
    const preferredSettings = delayGroupSettings(g, effectiveSettings(g))
    // Name-only group membership cannot identify a provider when names collide.
    // The group endpoint resolves that membership inside the core.
    const settings = catalog.members([g.name]).ambiguousNames.length
      ? { ...preferredSettings, mode: 'core' as const, timeout: Math.max(5000, preferredSettings.timeout) }
      : preferredSettings
    const scope = { group: g.name }
    const members = [...new Set(g.all ?? [])].filter((name) => isLatencyTestable(nodeMetadata(name)))
    const entries = members.map((name) => {
      const historyName = delayMeasurementName(name, settings.independent, nodeMetadata)
      const leaf = resolveProxyLeaf(name, nodeMetadata) ?? (catalog.ambiguous(name) ? name : undefined)
      const target = requestTarget(settings.mode === 'core' ? name : historyName) ?? { name }
      if (leaf) target.ipv6Target = requestTarget(leaf)
      return { name, historyName, leaf, key: measurementKey(name, settings, scope), target }
    })
    const targets = entries.map((entry) => entry.target)
    const total = new Set(targets.map((target) => target.name)).size
    const request = beginMeasurements(entries.map((entry) => entry.key))
    if (settings.ipv6) beginIPv6(entries.flatMap((entry) => entry.leaf ? [endpointKey(entry.leaf, scope)] : []), request)
    testing[testKey] = { done: 0, total, ipv6: settings.ipv6 && settings.mode === 'core' }
    if (!inBatch) {
      notifications.dismiss(latencyNoticeId(g.name))
      batch = null
    }
    let mainFailed = false
    let ipv6Done = 0
    try {
      if (settings.mode === 'panel' && g.fixed) {
        // A fixed automatic selection must be released before checking its candidates.
        await api.clearFixedProxy(g.name, backend, batchController.signal).catch(() => {})
      }
      if (!currentBackend()) return
      await tester.testGroup(g.name, targets, settings, (name, delay, measuredTarget) => {
        if (!currentBackend()) return
        for (const entry of entries) {
          if (entry.target.name !== name) continue
          if (settings.mode !== 'core' && proxyEndpointKey(entry.target) !== proxyEndpointKey(measuredTarget)) continue
          if (settings.mode === 'core' && delayMeasurementName(entry.name, settings.independent, nodeMetadata) !== entry.historyName) continue
          // An automatic group's result may use its own URL. Read the refreshed
          // leaf history for aliases instead of attributing that result to the leaf.
          if (settings.mode === 'core' && !settings.independent && entry.name !== entry.historyName) continue
          recordMeasurement(entry.key, entry.historyName, settings, delay, request, scope)
        }
        testing[testKey].ipv6 = false
        testing[testKey].done++
      }, (name, supported, measuredTarget) => {
        if (!currentBackend()) return
        if (settings.mode === 'core') {
          const leaf = entries.find((entry) => entry.name === name)?.leaf
          if (leaf) recordIPv6(endpointKey(leaf, scope), supported, request)
          ipv6Done++
          testing[testKey] = ipv6Done < total
            ? { done: ipv6Done, total, ipv6: true }
            : { done: 0, total, ipv6: false }
        } else {
          recordIPv6(proxyEndpointKey(measuredTarget), supported, request)
        }
      })
    } catch (error) {
      mainFailed = true
      if (!inBatch) notifyTestError(g.name, error)
      if (inBatch) throw error
    } finally {
      if (active) {
        await refreshMeasurements(request)
        if (mainFailed) {
          for (const entry of entries) {
            recordMeasurement(entry.key, entry.historyName, settings, 0, request, scope)
          }
        }
        delete testing[testKey]
      }
    }
  }

  async function testAll() {
    if (!currentBackend() || toolsBusy || selectionBusy || batch?.running || groupsTesting || nodesTesting || loading || metadataLoading || !hasAllTestTargets) return
    const noticeId = `proxy-latency-all:${backend.url}`
    notifications.dismiss(noticeId)
    let batchError: unknown
    const groupErrors = new Map<string, unknown>()
    const release = tester.beginBatch()
    try {
      if (testGroupsInBatch) {
        const targets = [...selectedTestGroups]
        batch = { kind: 'groups', running: true, done: 0, total: targets.length, failed: 0 }
        const result = await runProxyGroupBatch(targets, async (group) => {
          try { await test(group, true) }
          catch (cause) { groupErrors.set(group.name, cause); throw cause }
        }, (done, total) => {
          if (active && batch) batch = { ...batch, done, total }
        }, { concurrency: 3, signal: batchController.signal })
        if (active) batch = { kind: 'groups', running: false, done: result.completed, total: targets.length, failed: result.failed }
      } else {
        const settings = { ...delaySettings.value, mode: 'panel' as const, timeout: Math.min(2000, delaySettings.value.timeout) }
        const targets = allTestNodes.map((entry) => entry.target)
        const request = beginMeasurements(targets.map((target) => measurementKey(target.name, settings, target)))
        if (settings.ipv6) beginIPv6(targets.map(proxyEndpointKey), request)
        batch = { kind: 'nodes', running: true, done: 0, total: targets.length, failed: 0 }
        try {
          await tester.testNodes(targets, settings, (name, delay, target) => {
            if (!currentBackend() || !batch) return
            recordMeasurement(measurementKey(name, settings, target), name, settings, delay, request, target)
            batch = { ...batch, done: batch.done + 1, failed: batch.failed + (delay > 0 ? 0 : 1) }
          }, (_name, supported, target) => recordIPv6(proxyEndpointKey(target), supported, request))
        } catch (error) {
          batchError = error
        } finally {
          if (active) {
            await refreshMeasurements(request)
            if (batch) batch = { ...batch, running: false }
          }
        }
      }
    } finally {
      release()
      if (currentBackend() && batch) {
        const summary = { ...batch }
        notifications.show({
          id: noticeId, tone: batchError ? 'error' : summary.failed ? 'warning' : 'success', scope: backend.url,
          title: () => t('proxies.testAll'),
          message: () => batchError
            ? t('latency.testError', { name: t('proxies.testAll'), message: errorMessage(batchError) })
            : t(summary.kind === 'nodes'
              ? summary.failed ? 'proxies.batchNodesFailed' : 'proxies.batchNodesDone'
              : summary.failed ? 'proxies.batchFailed' : 'proxies.batchDone', { done: summary.done, total: summary.total, failed: summary.failed }),
          testId: 'proxy-latency-summary', closeLabel: () => t('proxies.dismissTestSummary'),
          ...(groupErrors.size ? { sections: [{
            title: () => t('proxies.testAll'), tone: 'error' as const,
            items: [...groupErrors].map(([label, cause]) => ({ label, description: () => errorMessage(cause) })),
          }] } : {}),
        })
        batch = null
      }
    }
  }

  async function retestNode(group: Proxy, name: string) {
    const settings = effectiveSettings(group)
    const scope = { group: group.name }
    const key = measurementKey(name, settings, scope)
    if (!currentBackend() || toolsBusy || !isLatencyTestable(nodeMetadata(name)) || selectionBusy || nodeTesting[key] || progressFor(group.name) || batch?.running || metadataLoading) return
    const target = requestTarget(delayMeasurementName(name, settings.independent, nodeMetadata))
    if (!target) return
    nodeTesting[key] = true
    batch = null
    const request = beginMeasurements([key])
    notifications.dismiss(latencyNoticeId(name))
    let failed = false
    try {
      const leaf = settings.ipv6 ? resolveProxyLeaf(name, nodeMetadata) : undefined
      if (leaf) beginIPv6([endpointKey(leaf, scope)], request)
      const result = await tester.testNode(target, { ...settings, ipv6: !!leaf },
        (_node, supported, probeTarget) => recordIPv6(proxyEndpointKey(probeTarget), supported, request), leaf ? requestTarget(leaf) : undefined)
      recordMeasurement(key, target.name, settings, result.delay, request, scope)
    } catch (error) {
      failed = true
      notifyTestError(name, error)
    } finally {
      if (active) {
        await refreshMeasurements(request)
        if (failed) recordMeasurement(key, target.name, settings, 0, request, scope)
        delete nodeTesting[key]
      }
    }
  }

  const bandClass = { fast: 'text-good', ok: 'text-warning', slow: 'text-bad', dead: 'text-fg-3', none: 'text-fg-3' }
  const delayText = (d: number | undefined) => (d === undefined || !Number.isFinite(d) || d <= 0 ? '—' : t('proxies.delay', { delay: d }))
  const delayStatusId = (group: string, name: string) => `proxy-delay-status-${encodeURIComponent(JSON.stringify([group, name]))}`
</script>

<PageHeader title={t('proxies.title')} meta={tab === 'groups' ? t('proxies.groups', { count: groups.length }) : t('providers.count', { count: providerCount })} />

<Tabs.Root value={tab} onValueChange={changeTab} loop>
  <Tabs.List aria-label={t('providers.navLabel')} class="mb-5 flex gap-1 border-b border-line">
    <Tabs.Trigger value="groups" class="flex min-h-11 items-center gap-2 border-b-2 border-transparent px-4 text-[13px] text-fg-2 transition-colors hover:text-fg data-[state=active]:border-accent-ink data-[state=active]:font-medium data-[state=active]:text-fg">
      {t('providers.tabGroups')}<span class="num font-mono text-xs text-fg-3" aria-hidden="true">{count(groups.length)}</span>
    </Tabs.Trigger>
    <Tabs.Trigger value="providers" class="flex min-h-11 items-center gap-2 border-b-2 border-transparent px-4 text-[13px] text-fg-2 transition-colors hover:text-fg data-[state=active]:border-accent-ink data-[state=active]:font-medium data-[state=active]:text-fg">
      {t('providers.tabProviders')}<span class="num font-mono text-xs text-fg-3" aria-hidden="true">{metadataLoading && !providerCount ? '…' : count(providerCount)}</span>
    </Tabs.Trigger>
  </Tabs.List>
  <Tabs.Content value="groups">

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
<p class="text-xs text-fg-3" title={t('proxies.sortProviderHint')}>
  {t(delaySettings.value.mode === 'core' ? 'latency.modeCore' : 'latency.modePanel')}
  · {t(core.configs?.['unified-delay'] === true ? 'latency.unifiedOn' : core.configs?.['unified-delay'] === false ? 'latency.unifiedOff' : 'latency.unifiedUnknownShort')}
</p>
  <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
    <Button size="sm" onclick={testAll} disabled={toolsBusy || selectionBusy || loading || metadataLoading || !hasAllTestTargets || groupsTesting || nodesTesting || !!batch?.running} aria-label={t('proxies.testAll')}><IconZap strokeWidth={1.5} />{t(batch?.running ? 'proxies.testingAll' : 'proxies.testAll')}</Button>
    <SearchInput bind:value={query} placeholder={t('proxies.search')} />
  </div>
</div>

<details class="group mb-4 rounded-panel border border-line bg-card" data-testid="proxy-test-selection">
  <summary class="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 rounded-panel px-4 py-3 text-[13px] marker:content-none">
    <span class="flex min-w-0 items-center gap-2"><IconChevron class="size-4 shrink-0 -rotate-90 text-fg-3 transition-transform group-open:rotate-0" strokeWidth={1.5} aria-hidden="true" />{t('proxyTest.title')}</span>
    <span class="ml-auto text-xs text-fg-3">{t(testSelection.mode === 'all' ? 'proxyTest.summaryAll' : 'proxyTest.summarySelected', { count: selectedTestGroups.length })}</span>
  </summary>
  <fieldset class="min-w-0 border-t border-line px-4 py-4" disabled={toolsBusy || selectionBusy || loading || metadataLoading || groupsTesting || nodesTesting || !!batch?.running}>
    <legend class="sr-only">{t('proxyTest.title')}</legend>
    <Segmented label={t('proxyTest.title')} value={testSelection.mode} options={testSelectionOptions} onchange={changeTestMode} />
    <p class="mt-3 text-xs leading-5 text-fg-3">{t('proxyTest.hint')}</p>
    {#if testSelection.mode === 'selected'}
      <div class="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onclick={() => changeTestSelection({ mode: 'selected', groups: allTestGroups.map((group) => group.name) })}>{t('proxyTest.selectAll')}</Button>
        <Button size="sm" variant="ghost" onclick={() => changeTestSelection({ mode: 'selected', groups: [] })}>{t('proxyTest.selectNone')}</Button>
      </div>
      <div class="mt-2 grid max-h-64 grid-cols-1 gap-x-4 overflow-y-auto overscroll-contain sm:grid-cols-2 xl:grid-cols-3">
        {#each allTestGroups as group (group.name)}
          <label class="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 py-2 text-[13px]">
            <input type="checkbox" class="size-4 shrink-0 accent-[var(--accent-ink)]" data-test-group={group.name} checked={testSelection.groups.includes(group.name)} onchange={(event) => chooseTestGroup(group.name, event.currentTarget.checked)} />
            <span class="min-w-0 break-words">{group.name}{#if group.hidden}<span class="ml-2 text-xs text-fg-3">{t('proxyTest.hidden')}</span>{/if}</span>
          </label>
        {/each}
      </div>
      {#if !selectedTestGroups.length}<p class="mt-2 text-xs text-warning" role="status">{t('proxyTest.none')}</p>{/if}
    {/if}
    {#if !testSelectionSaved}<p class="mt-3 text-xs text-warning" role="status">{t('proxyTest.memory')}</p>{/if}
  </fieldset>
</details>

<div class="mb-4">
  <ProxyStability {backend} targets={stabilityTargets} settings={delaySettings.value}
    disabled={providersBusy || selectionBusy || nodesSelecting || loading || metadataLoading || groupsTesting || nodesTesting || !!batch?.running}
    onrunning={(running) => { stabilityBusy = running }} oncomplete={() => { if (currentBackend()) void load() }} />
</div>

{#if batch?.running}
  <div class="mb-4 rounded-xl border border-line bg-card px-4 py-3" role="status">
    <div class="mb-2 flex items-center justify-between gap-3 text-[13px]">
      <span>{t(batch.kind === 'nodes' ? 'proxies.batchNodesProgress' : 'proxies.batchProgress', { done: batch.done, total: batch.total, failed: batch.failed })}</span>
    </div>
    <LatencyProgress label={t('proxies.testAll')} done={batch.done} total={batch.total} />
  </div>
{/if}

{#if errorText}
  <p class="mb-4 rounded-[var(--radius-card)] border border-bad-border bg-bad-surface px-4 py-3 text-[13px] text-bad" role="alert">{errorText}</p>
{/if}

{#if loading}
  <p class="text-fg-3">{t('proxies.loading')}</p>
{:else}
  <div class="proxy-groups grid items-start gap-3" data-testid="proxy-groups-grid">
    {#each groups as g, i (g.name)}
      {@const nodes = visible(g)}
      {@const isOpen = q ? nodes.length > 0 : (open[g.name] ?? i < 2)}
      {@const selectable = SELECTABLE.has(g.type)}
      {@const order = sortingFor(g.name)}
      {#if !q || nodes.length}
        <section class="proxy-group min-w-0 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-card shadow-[var(--shadow-panel)]">
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
                <span class="flex items-baseline gap-2"><span class="truncate font-medium" title={g.name}>{g.name}</span><span class="proxy-group-kind shrink-0 font-mono text-xs text-fg-3">{g.type}</span></span>
                {#if g.now}<span class="mt-0.5 block truncate text-xs text-fg-2" title={g.now}>{g.now}</span>{/if}
              </span>
              <span class="proxy-group-count num shrink-0 font-mono text-xs text-fg-3">{count(g.all?.length ?? 0)}</span>
            </button>
            <Button size="sm" variant="ghost" onclick={() => test(g)} disabled={toolsBusy || selectionBusy || !!progressFor(g.name) || nodesTesting || metadataLoading || !!batch?.running} aria-label={t('proxies.testGroup', { name: g.name })}>
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
                  disabled={!g.now || !g.all?.includes(g.now) || toolsBusy || selectionBusy || nodesSelecting || metadataLoading || groupsTesting || nodesTesting || !!batch?.running}
                  onclick={() => applySelectionToAll(g.name)}
                >
                  <IconCopy strokeWidth={1.5} aria-hidden="true" />
                  <span class="text-xs leading-4">{t(selectionBusy && selectionSource === g.name ? 'proxies.selectionApplyingShort' : 'proxies.selectionApplyShort')}</span>
                </Button>
              {/snippet}
            </ProxySortControls>
            <div class="proxy-node-grid grid grid-cols-1 gap-2 bg-raised px-3 pb-3 pt-1 min-[360px]:grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]" class:compact={appearance.proxyCardSize === 'compact'} data-card-size={appearance.proxyCardSize} data-group-height={appearance.proxyGroupHeight}>
              {#each nodes as name (name)}
                {@const d = lastDelay(name, g)}
                {@const sel = g.now === name}
                {@const busy = nodeBusy(name, g)}
                <div class="proxy-node relative min-w-0 {delaySettings.value.ipv6 ? 'h-[104px] sm:h-[88px]' : 'h-[88px] sm:h-[72px]'}" class:with-ipv6={delaySettings.value.ipv6} data-proxy-node={name}>
                <button
                  disabled={!selectable || toolsBusy || selectionBusy || !!selecting[JSON.stringify(g.name)]}
                  aria-pressed={sel}
                  onclick={() => select(g, name)}
                  class="proxy-node-button absolute inset-0 flex w-full min-w-0 flex-col justify-between rounded-[var(--radius-control)] border px-3 py-3 text-left transition-colors duration-150
                    {sel
                    ? 'border-selected-border bg-selected text-selected-text shadow-[inset_3px_0_0_var(--selected-border)]'
                    : 'border-line bg-card enabled:hover:border-line-strong enabled:hover:bg-hover'}
                    disabled:cursor-default"
                >
                  <span class="proxy-node-name flex w-full min-w-0 items-center gap-2 text-[13px]">
                    <span class="min-w-0 flex-1 truncate {sel ? 'font-medium' : ''}" title={name}>{name}</span>
                    {#if sel}<IconCheck class="size-4 shrink-0 text-selected-text" strokeWidth={1.5} aria-hidden="true" />{/if}
                  </span>
                  <span class="flex w-full min-w-0 items-center gap-2 pr-20 font-mono text-xs">
                    <span class="sr-only">{protocol(name)}</span>
                  </span>
                  {#if delaySettings.value.ipv6}
                    {@const supported = ipv6For(name, g)}
                    <span role="img" aria-label={ipv6Label(supported)} title={ipv6Label(supported)} data-ipv6-state={supported === true ? 'available' : supported === false ? 'unavailable' : 'untested'} class="inline-flex self-start items-center gap-1 text-xs leading-4 {supported === true ? 'text-good' : supported === false ? 'text-bad' : 'text-fg-3'}">
                      IPv6
                      {#if supported === true}<IconCheck class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else if supported === false}<IconClose class="size-3" strokeWidth={1.5} aria-hidden="true" />
                      {:else}<span aria-hidden="true">—</span>{/if}
                    </span>
                  {/if}
                </button>
                <button type="button" class="absolute left-1 inline-flex h-11 max-w-[calc(100%_-_100px)] items-center gap-1 rounded-md px-2 font-mono text-xs text-fg-2 hover:bg-hover sm:h-7 {delaySettings.value.ipv6 ? 'bottom-5 sm:bottom-5' : 'bottom-1'}" data-testid="node-diagnostics-open" data-node={name} disabled={!nodeMetadata(name) && !catalog.ambiguous(name)} aria-label={t('nodeDiagnostics.open', { name })} title={catalog.ambiguous(name) ? t('proxyTest.ambiguous') : t('nodeDiagnostics.open', { name })} onclick={() => catalog.ambiguous(name) ? changeTab('providers') : inspectGroupNode(name)}>
                  <span class="truncate">{protocol(name)}</span><IconInfo class="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                </button>
                <button class="num absolute bottom-1 right-1 inline-flex h-11 min-w-12 items-center justify-end rounded-md px-2 font-mono text-xs transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-60 sm:h-7 {bandClass[delayBand(d, delaySettings.value.yellow, delaySettings.value.red)]}" aria-label={t(busy ? 'proxies.testingNode' : 'proxies.retestNode', { name })} aria-describedby={!busy && d !== undefined && d <= 0 ? delayStatusId(g.name, name) : undefined} title={catalog.ambiguous(name) ? t('proxyTest.ambiguous') : `${t('proxies.retestNode', { name })}${!busy && d !== undefined && d <= 0 ? ` · ${t('proxies.noResponse')}` : ''}`} aria-busy={busy} disabled={catalog.ambiguous(name) || !isLatencyTestable(nodeMetadata(name)) || toolsBusy || selectionBusy || busy || metadataLoading || !!progressFor(g.name) || !!batch?.running} onclick={() => retestNode(g, name)}>
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
  </Tabs.Content>
  <Tabs.Content value="providers">
    {#if tab === 'providers'}
      <ProxyProviders {backend} providers={proxyProviders} loadError={providerError} loading={metadataLoading}
        disabled={stabilityBusy || selectionBusy || nodesSelecting || loading || metadataLoading || groupsTesting || nodesTesting || !!batch?.running}
        onreload={load} onbusy={(busy) => { providersBusy = busy }} oninspect={inspectNode} />
    {/if}
  </Tabs.Content>
</Tabs.Root>

<NodeDiagnostics bind:open={diagnosticOpen} node={diagnosticNode} provider={diagnosticProvider} providerName={diagnosticProviderName} />

<style>
  .compact .proxy-node { height: 72px; }
  .compact .proxy-node.with-ipv6 { height: 88px; }
  .compact .proxy-node-button { padding: 6px 8px; }
  .compact .proxy-node-name { font-size: 12px; line-height: 16px; }
  @media (min-width: 640px) {
    .proxy-node-grid.compact { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
    .compact .proxy-node { height: 56px; }
    .compact .proxy-node.with-ipv6 { height: 72px; }
  }
  @media (min-width: 1280px) {
    .proxy-node-grid[data-group-height='compact'] { max-height: min(320px, 45dvh); overflow-y: auto; overscroll-behavior: contain; }
    .proxy-node-grid[data-group-height='large'] { max-height: min(560px, 65dvh); overflow-y: auto; overscroll-behavior: contain; }
  }
  .proxy-groups { grid-template-columns: repeat(auto-fit, minmax(min(100%, max(460px, calc((100% - 1.5rem) / 3))), 1fr)); }
  .proxy-group { container-type: inline-size; }
  .proxy-group-kind, .proxy-group-count { display: none; }
  @container (min-width: 440px) {
    .proxy-group-kind, .proxy-group-count { display: inline; }
  }
</style>
