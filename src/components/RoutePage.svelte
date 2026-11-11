<script lang="ts">
  import type { Route } from '../lib/core.svelte'
  import { pages } from '../lib/pages'
  import { t } from '../lib/i18n.svelte'
  import ErrorBoundary from './ErrorBoundary.svelte'
  import RecoveryPanel from './RecoveryPanel.svelte'

  let { route }: { route: Route } = $props()
  const page = $derived(pages[route]())
</script>

{#await page}
  <div class="min-h-48 px-6 py-8 text-sm text-fg-2" role="status" aria-live="polite">{t('common.loadingPage')}</div>
{:then module}
  {@const Page = module.default}
  <ErrorBoundary><Page /></ErrorBoundary>
{:catch}
  <RecoveryPanel loading />
{/await}
