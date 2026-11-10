<script lang="ts">
  import { t } from '../lib/i18n.svelte'

  let { fallback }: { fallback?: string } = $props()
  const name = $derived(typeof fallback === 'string' && fallback.trim() ? fallback : '')
</script>

{#if name}
  <details class="group-fallback border-b border-line bg-raised px-4 text-xs" data-testid="proxy-group-fallback">
    <summary class="min-h-11 cursor-pointer py-3 text-fg-2">
      <span class="ml-1">{t('proxyFallback.label')}</span>
      <span class="ml-2 font-mono text-fg [overflow-wrap:anywhere]" data-testid="proxy-group-fallback-name">{name}</span>
    </summary>
    <p class="pb-3 leading-relaxed text-fg-3">{t('proxyFallback.hint')}</p>
  </details>
{/if}

<style>
  summary { overflow-wrap: anywhere; }
  summary::marker { color: var(--text-3); }
</style>
