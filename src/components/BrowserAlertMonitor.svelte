<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { request, type Backend, type Proxy, type ProxyProvider } from '../lib/api'
  import { t } from '../lib/i18n.svelte'
  import { BROWSER_ALERTS_KEY, loadBrowserAlertPreferences, subscribeBrowserAlertPreferences, sameBrowserAlertPreferences, NodeFailureTracker, showBrowserNotification } from '../lib/browser-alerts'
  import { evaluateProviderAlerts, readProviderAlertState } from '../lib/provider-alerts'
  let { backend }: { backend: Backend } = $props()
  let preferences = $state(loadBrowserAlertPreferences())
  onMount(() => subscribeBrowserAlertPreferences(next => { if (!sameBrowserAlertPreferences(preferences, next)) preferences = next }))
  $effect(() => {
    const settings = { ...preferences }, session = { ...backend }
    if (!settings.enabled || !session.url) return
    const abort = new AbortController(), tracker = new NodeFailureTracker()
    const stateKey = BROWSER_ALERTS_KEY + ':seen:' + encodeURIComponent(session.url)
    let seen = readProviderAlertState(null)
    try { seen = readProviderAlertState(JSON.parse(localStorage.getItem(stateKey) ?? 'null')) } catch { /* Tab-only deduplication. */ }
    let wasOnline = false, lostAt = 0, notified = false, coreSending = false, busy = false, nextHealth = 0
    const pendingNodes = new Set<string>()
    const emit = (title: string, body: string, suffix: string, route?: string) => {
      return showBrowserNotification(title, body, `miboard:${session.url}:${suffix}`, route, abort.signal, session.url)
    }
    const poll = async () => {
      if (abort.signal.aborted) return
      const live = core.status === 'ok' && (
        (core.trafficReady && !core.staleStreams.includes('/traffic')) ||
        (core.memoryReady && !core.staleStreams.includes('/memory')) ||
        (core.connectionsFresh && !core.staleStreams.includes('/connections'))
      )
      if (core.updatesPaused) lostAt = 0
      else if (live) { wasOnline = true; lostAt = 0; notified = false }
      else if (settings.core && wasOnline && (core.status === 'lost' || core.status === 'ok')) {
        if (!lostAt) lostAt = Date.now()
        if (!notified && !coreSending && Date.now() - lostAt >= 15000) {
          coreSending = true
          try { notified = await emit(t('panelTools.coreDown'), t('panelTools.coreDownBody'), 'core', '#/settings?category=core') }
          finally { coreSending = false }
        }
      }
      if (busy || core.status !== 'ok' || core.updatesPaused || Date.now() < nextHealth) return
      busy = true; nextHealth = Date.now() + 60000
      try {
        const outcomes = await Promise.allSettled([
          settings.nodes ? request<{ proxies: Record<string, Proxy> }>('/proxies', { signal: abort.signal }, session) : Promise.resolve(null),
          settings.subscriptions ? request<{ providers: Record<string, ProxyProvider> }>('/providers/proxies', { signal: abort.signal }, session) : Promise.resolve(null),
        ])
        if (abort.signal.aborted) return
        const nodes = outcomes[0], providers = outcomes[1]
        if (nodes.status === 'fulfilled' && nodes.value?.proxies) {
          tracker.inspect(nodes.value.proxies).forEach(name => pendingNodes.add(name))
          for (const name of pendingNodes) {
            const sample = nodes.value.proxies[name]?.history?.at(-1)
            if (!sample || sample.delay > 0 || Date.now() - Date.parse(sample.time) > 300000) pendingNodes.delete(name)
          }
          if (pendingNodes.size) {
            const names = [...pendingNodes]
            if (await emit(t('panelTools.nodesDown', { count: names.length }), t('panelTools.nodesDownBody', { names: names.slice(0, 5).join(', '), count: names.length }), 'nodes')) names.forEach(name => pendingNodes.delete(name))
          }
        }
        if (providers.status === 'fulfilled' && providers.value?.providers) {
          const evaluated = evaluateProviderAlerts(providers.value.providers, seen)
          const names = [...new Set(evaluated.alerts.map(alert => alert.provider))]
          if (!names.length || await emit(t('panelTools.subscriptionsAlert', { count: names.length }), t('panelTools.subscriptionsBody', { names: names.slice(0, 5).join(', '), count: names.length }), 'subscriptions', '#/proxies?tab=providers')) {
            if (abort.signal.aborted) return
            seen = evaluated.state
            try { localStorage.setItem(stateKey, JSON.stringify(seen)) } catch { /* Keep in memory. */ }
          }
        }
      } finally { busy = false }
    }
    untrack(() => { void poll() })
    const timer = setInterval(() => void poll(), 5000)
    return () => { abort.abort(); clearInterval(timer) }
  })
</script>
