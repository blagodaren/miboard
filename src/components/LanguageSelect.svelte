<script lang="ts">
  import { i18n, supportedLocales, t } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'

  let { full = false }: { full?: boolean } = $props()

  async function change(value: string) {
    notifications.dismiss('locale-load')
    try {
      await i18n.set(value)
    } catch {
      notifications.show({ id: 'locale-load', tone: 'error', testId: 'locale-load-error', message: () => t('error.localeLoad') })
    }
  }
</script>

<label class="flex items-center gap-3 text-[13px] text-fg-2 {full ? 'w-full justify-between' : ''}">
  <span>{t('common.language')}</span>
  <select
    value={i18n.selectedLocale}
    aria-busy={i18n.loading}
    onchange={(event) => change(event.currentTarget.value)}
    class="h-11 rounded-control border border-field-border bg-field px-3 text-fg transition-colors hover:border-fg-3 focus-visible:border-accent-ink sm:h-9"
  >
    {#each supportedLocales as language (language.value)}
      <option value={language.value} lang={language.value}>{language.label}</option>
    {/each}
  </select>
</label>
{#if i18n.loading}<span class="sr-only" role="status">{t('common.loadingLanguage')}</span>{/if}
