<script lang="ts">
  import { t } from '../lib/i18n.svelte'
  import Button from './Button.svelte'

  let { retry, loading = false }: { retry?: () => void; loading?: boolean } = $props()
</script>

<section class="mx-auto my-6 max-w-xl rounded-panel border border-line bg-card p-6 sm:p-8" data-testid="page-recovery">
  <div role="alert">
    <h1 class="text-xl font-semibold text-fg">{t(loading ? 'error.pageLoadTitle' : 'error.pageRenderTitle')}</h1>
    <p class="mt-3 text-sm leading-relaxed text-fg-2">{t(loading ? 'error.pageLoadHint' : 'error.pageRenderHint')}</p>
  </div>
  <div class="mt-6 flex flex-wrap gap-3">
    {#if retry}<Button variant="primary" onclick={retry}>{t('error.retryPage')}</Button>{/if}
    <Button variant={retry ? 'secondary' : 'primary'} onclick={() => window.location.reload()}>{t('error.reloadApp')}</Button>
  </div>
</section>
