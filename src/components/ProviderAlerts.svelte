<script lang="ts">
  import { untrack } from 'svelte'
  import { request, type Backend, type ProxyProvider } from '../lib/api'
  import { providerAlertPreferences } from '../lib/provider-alerts.svelte'
  import { PROVIDER_ALERT_INTERVAL } from '../lib/provider-alerts'
  import { notifications } from '../lib/notifications.svelte'
  import { bytes } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'

  let { backend }: { backend: Backend } = $props()
  const enabled = $derived(providerAlertPreferences.enabled(backend.url))
  $effect(() => {
    const session = { ...backend }
    if (!session.url || !enabled) return
    let active = true
    let controller: AbortController | null = null
    let nextCheck = 0
    const noticeIds = new Set<string>()
    const inspect = async () => {
      if (!active || document.hidden || controller || Date.now() < nextCheck) return
      nextCheck = Date.now() + PROVIDER_ALERT_INTERVAL
      const abort = new AbortController()
      controller = abort
      try {
        const data = await request<{ providers: Record<string, ProxyProvider> }>('/providers/proxies', { signal: abort.signal, timeout: 10000 }, session)
        if (!active || abort.signal.aborted || document.hidden || !data?.providers || typeof data.providers !== 'object' || Array.isArray(data.providers)) return
        const alerts = providerAlertPreferences.inspect(session.url, data.providers)
        const providers = [...new Set(alerts.map(alert => alert.provider))]
        if (providers.length) {
          const id = `provider-alert:${session.url}`
          noticeIds.add(id)
          notifications.show({ id, tone: 'warning', title: () => t('providerAlerts.title'), scope: session.url, testId: 'provider-subscription-alert',
            message: () => t('providerAlerts.summary', { count: providers.length }) + (providers.length > 50 ? ` ${t('providerAlerts.limited', { count: 50 })}` : ''),
            sections: [{ title: () => t('providerAlerts.title'), tone: 'warning', items: providers.slice(0, 50).map(name => ({ label: name,
              description: () => alerts.filter(alert => alert.provider === name).map(alert => t(`providerAlerts.${alert.kind}`, {
                remaining: bytes(alert.remaining ?? 0), total: bytes(alert.total ?? 0),
                date: alert.expiresAt ? new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium' }).format(alert.expiresAt) : '',
              })).join(' '),
            })) }], action: { label: () => t('providerAlerts.open'), href: '#/proxies?tab=providers' } })
        }
      } catch { /* Optional metadata alerts must not create network-error notification loops. */ }
      finally { if (controller === abort) controller = null }
    }
    const visibility = () => { if (document.hidden) controller?.abort(); else void inspect() }
    untrack(() => { void inspect() })
    const interval = setInterval(inspect, PROVIDER_ALERT_INTERVAL)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      active = false
      controller?.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visibility)
      for (const id of noticeIds) notifications.dismiss(id)
    }
  })
</script>
