<script lang="ts">
  import { t } from '../lib/i18n.svelte'
  import { customCss, MAX_CUSTOM_CSS } from '../lib/custom-css.svelte'
  import Button from './Button.svelte'

  let draft = $state(customCss.value)
  let status = $state<'' | 'saved' | 'memory' | 'size'>('')
  const placeholder = ':root {\n  --accent: light-dark(royalblue, cornflowerblue);\n  --accent-ink: light-dark(mediumblue, lightskyblue);\n  --page: light-dark(ghostwhite, midnightblue);\n}'
  function save(css: string) { status = customCss.save(css); if (status !== 'size') draft = customCss.value }
</script>

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
