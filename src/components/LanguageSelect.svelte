<script lang="ts">
  import { i18n, supportedLocales, t } from '../lib/i18n.svelte'

  let { full = false }: { full?: boolean } = $props()
</script>

<label class="flex items-center gap-3 text-[13px] text-fg-2 {full ? 'w-full justify-between' : ''}">
  <span>{t('common.language')}</span>
  <select
    value={i18n.locale}
    onchange={(event) => i18n.set(event.currentTarget.value)}
    class="h-9 rounded-lg border border-field-border bg-field px-3 text-fg transition-colors focus-visible:border-accent-ink"
  >
    {#each supportedLocales as language (language.value)}
      <option value={language.value} lang={language.value}>{language.label}</option>
    {/each}
  </select>
</label>
