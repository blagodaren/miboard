<script lang="ts">
  import { onMount } from 'svelte'
  import type { ProxyProvider } from '../lib/api'
  import type { ForecastResult } from '../lib/subscription-forecast'
  import { bytes } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { subscriptionForecasts } from '../lib/subscription-forecast-service'
  let { backendUrl, name, provider }: { backendUrl: string; name: string; provider: ProxyProvider } = $props()
  let now = $state(Date.now())
  let result = $state<ForecastResult>({ state: 'missing' })
  let memory = $state(false)
  $effect(() => { result = subscriptionForecasts.inspect(backendUrl, name, provider, now); memory = subscriptionForecasts.memoryOnly })
  onMount(() => { const timer = setInterval(() => { now = Date.now() }, 60_000); return () => clearInterval(timer) })
</script>
<div class="mt-4 border-t border-line pt-3 text-xs leading-5" data-testid="subscription-forecast">
  <p class="font-medium text-fg-2">{t('forecast.title')}</p>
  <p class="mt-1 text-fg-2">{result.state === 'ready' ? t('forecast.ready', { days: new Intl.NumberFormat(i18n.intlLocale, { maximumFractionDigits: 1 }).format(result.daysLeft!), rate: bytes(result.bytesPerDay!) }) : t(`forecast.${result.state}`)}</p>
  {#if result.limitedByExpiry}<p class="text-fg-3">{t('forecast.expiryLimit')}</p>{/if}
  {#if result.state === 'ready'}<p class="mt-1 text-fg-3">{t('forecast.hint')}</p>{/if}
  {#if memory}<p class="mt-1 text-warning">{t('forecast.memory')}</p>{/if}
</div>
