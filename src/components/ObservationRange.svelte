<script lang="ts">
  import { connectionJournal } from '../lib/connection-journal.svelte'
  import { t } from '../lib/i18n.svelte'
  import type { ObservationRange } from '../lib/observations'
  let { value = $bindable<ObservationRange>('active'), onchange }: { value?: ObservationRange; onchange?: () => void } = $props()
</script>

<div class="mb-4 rounded-panel border border-line bg-card p-4 sm:p-5" data-testid="observation-scope">
  <label class="flex flex-wrap items-center gap-3 text-[13px] text-fg-2">
    <span>{t('observations.range')}</span>
    <select class="min-h-11 max-w-full rounded-control border border-field-border bg-field px-3 text-fg sm:min-h-8" bind:value onchange={() => onchange?.()} data-testid="observation-range">
      {#each ['active', '1h', '24h', '7d'] as range}<option value={range}>{t(`observations.${range as ObservationRange}`)}</option>{/each}
    </select>
  </label>
  {#if value !== 'active'}
    <p class="mt-3 max-w-4xl text-xs leading-5 text-fg-2">{t('observations.shortHint')}</p>
    <details class="mt-1 max-w-4xl text-xs leading-5 text-fg-3">
      <summary class="min-h-11 cursor-pointer content-center text-fg-2">{t('observations.about')}</summary>
      <p>{t('observations.hint')}</p><p class="mt-1">{t('observations.retention')}</p>
    </details>
    {#if connectionJournal.loading || connectionJournal.retention === 'off'}<p class="mt-1 max-w-4xl text-xs leading-5 text-fg-3" role="status">{t(connectionJournal.loading ? 'observations.loading' : 'observations.off')}</p>{/if}
    {#if connectionJournal.retention === 'off'}<a class="mt-2 inline-flex min-h-11 items-center text-[13px] underline underline-offset-4" href="#/settings?category=data">{t('observations.settings')}</a>{/if}
  {/if}
</div>
