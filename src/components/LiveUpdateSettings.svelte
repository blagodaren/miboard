<script lang="ts">
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import Segmented from './Segmented.svelte'

  const options = $derived([
    { value: 'realtime' as const, label: t('liveUpdates.realtime') },
    { value: 'eco' as const, label: t('liveUpdates.eco') },
  ])
</script>

<section aria-labelledby="live-update-settings-title" data-testid="live-update-settings">
  <h2 id="live-update-settings-title" class="mb-3 px-1 text-[13px] text-fg-2">{t('liveUpdates.title')}</h2>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="min-w-0 flex-1 basis-44"><p class="text-sm">{t('liveUpdates.mode')}</p><p class="mt-1 text-[13px] leading-5 text-fg-3">{t('liveUpdates.hint')}</p></div>
      <div class="max-w-full" data-testid="live-update-mode"><Segmented label={t('liveUpdates.mode')} value={core.liveUpdateMode} {options} onchange={value => core.setLiveUpdateMode(value)} /></div>
    </div>
    <p class="mt-3 text-xs leading-5 text-fg-3">{t(core.liveUpdateMode === 'eco' ? 'liveUpdates.ecoHint' : 'liveUpdates.realtimeHint')}</p>
    {#if !core.liveUpdateSaved}<p class="mt-3 text-xs leading-5 text-warning" role="status">{t('liveUpdates.memory')}</p>{/if}
  </div>
</section>
