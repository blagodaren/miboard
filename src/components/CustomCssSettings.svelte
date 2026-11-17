<script lang="ts">
  import { t } from '../lib/i18n.svelte'
  import { customCss, MAX_CUSTOM_CSS } from '../lib/custom-css.svelte'
  import Button from './Button.svelte'
  import Toggle from './Toggle.svelte'
  import { themeSource } from '../lib/theme-source.svelte'
  import { i18n } from '../lib/i18n.svelte'

  const updated = $derived(themeSource.source?.updatedAt ? new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'short', timeStyle: 'short' }).format(themeSource.source.updatedAt) : '')

  let draft = $state(customCss.value)
  let status = $state<'' | 'saved' | 'memory' | 'size'>('')
  const placeholder = ':root {\n  --accent: light-dark(royalblue, cornflowerblue);\n  --accent-ink: light-dark(mediumblue, lightskyblue);\n  --page: light-dark(ghostwhite, midnightblue);\n}'
  function save(css: string) { status = customCss.save(css); if (status !== 'size') draft = customCss.value }
</script>

{#if themeSource.source}
  {@const source = themeSource.source}
  <section data-testid="theme-source-settings">
    <h2 class="mb-1 px-1 text-[13px] text-fg-2">{t('settings.themeSource')}</h2>
    <p class="mb-3 px-1 text-[13px] leading-relaxed text-fg-3">{t('settings.themeSourceHint')}</p>
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-panel border border-line bg-card px-4 py-4 sm:px-5">
      <div class="min-w-0 flex-1 basis-56">
        <div class="truncate font-mono text-xs" title={source.url}>{source.url}</div>
        <div class="mt-1 text-xs {themeSource.error ? 'text-warning' : 'text-fg-3'}" role="status">
          {themeSource.error ? t('settings.themeSourceError', { message: themeSource.error }) : themeSource.loading ? t('settings.themeSourceLoading') : updated ? t('settings.themeSourceUpdated', { time: updated }) : t('settings.themeSourceNever')}
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <Toggle label={t('settings.themeSourceEnabled')} checked={source.enabled} onchange={(value) => themeSource.setEnabled(value)} />
        <Button size="sm" disabled={themeSource.loading} onclick={() => themeSource.refresh()}>{t('settings.themeSourceRefresh')}</Button>
        <Button size="sm" variant="ghost" onclick={() => themeSource.remove()}>{t('settings.themeSourceRemove')}</Button>
      </div>
    </div>
  </section>
{/if}

<section data-testid="custom-css-settings">
  <h2 class="mb-1 px-1 text-[13px] text-fg-2">{t('settings.customCss')}</h2>
  <p class="mb-3 px-1 text-[13px] leading-relaxed text-fg-3">{t('settings.customCssHint')}</p>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <label for="custom-css" class="sr-only">{t('settings.customCss')}</label>
    <textarea id="custom-css" bind:value={draft} oninput={() => (status = '')} spellcheck="false" maxlength={MAX_CUSTOM_CSS} {placeholder}
      class="h-56 w-full resize-y rounded-control border border-field-border bg-field p-3 font-mono text-xs leading-5 text-fg placeholder:text-fg-3"></textarea>
    <div class="mt-3 flex flex-wrap items-center gap-3">
      <Button size="sm" variant="primary" disabled={draft === customCss.value} onclick={() => save(draft)}>{t('settings.customCssSave')}</Button>
      <Button size="sm" variant="ghost" disabled={!customCss.value && !draft} onclick={() => save('')}>{t('settings.customCssReset')}</Button>
      {#if status}<span class="text-xs {status === 'saved' ? 'text-fg-3' : 'text-warning'}" role="status">{t(`settings.customCss.${status}`)}</span>{/if}
    </div>
  </div>
</section>
