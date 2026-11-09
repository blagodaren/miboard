<script lang="ts">
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import IconClose from '@lucide/svelte/icons/x'

  let dismissed = $state(0)
  let backend = $state('')
  $effect(() => {
    if (backend !== core.backend.url || core.observationGapVersion < dismissed) {
      backend = core.backend.url
      dismissed = 0
    }
  })
  const restoring = $derived(core.updatesResuming || core.staleStreams.length > 0)
</script>

{#if core.updatesPaused || restoring || core.observationGapVersion > dismissed}
  <div class="mb-5 flex items-start gap-3 rounded-control border border-line bg-card px-4 py-3 text-xs leading-5 text-fg-2" data-testid="live-update-notice">
    <p class="min-w-0 flex-1" role="status">{t(core.updatesPaused ? 'liveUpdates.paused' : restoring ? 'liveUpdates.reconnecting' : 'liveUpdates.gap')}</p>
    {#if !core.updatesPaused && !restoring}
      <button type="button" class="-my-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-control text-fg-3 hover:bg-hover hover:text-fg" aria-label={t('liveUpdates.dismiss')} onclick={() => { dismissed = core.observationGapVersion }}><IconClose class="size-4" strokeWidth={1.5} aria-hidden="true" /></button>
    {/if}
  </div>
{/if}
