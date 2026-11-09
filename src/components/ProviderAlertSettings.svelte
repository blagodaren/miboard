<script lang="ts">
  import { core } from '../lib/core.svelte'
  import { providerAlertPreferences } from '../lib/provider-alerts.svelte'
  import { t } from '../lib/i18n.svelte'
  import Toggle from './Toggle.svelte'
  const enabled = $derived(providerAlertPreferences.enabled(core.backend.url))
  const memoryOnly = $derived(providerAlertPreferences.memoryOnly(core.backend.url))
</script>

<section aria-labelledby="provider-alert-settings-title">
  <h2 id="provider-alert-settings-title" class="mb-3 px-1 text-[13px] text-fg-2">{t('providerAlerts.title')}</h2>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <div class="flex items-start justify-between gap-4"><div class="min-w-0"><p class="text-sm">{t('providerAlerts.enabled')}</p><p class="mt-1 text-[13px] leading-5 text-fg-3">{t('providerAlerts.hint')}</p></div>
      <div data-testid="provider-alert-toggle"><Toggle label={t('providerAlerts.enabled')} checked={enabled} onchange={value => providerAlertPreferences.setEnabled(core.backend.url, value)} /></div>
    </div>
    <p class="mt-3 text-xs leading-5 text-fg-3">{t('providerAlerts.localHint')}</p>
    {#if memoryOnly}<p class="mt-3 text-xs leading-5 text-warning" role="status">{t('providerAlerts.memory')}</p>{/if}
  </div>
</section>
