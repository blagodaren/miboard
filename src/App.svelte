<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { core, router } from './lib/core.svelte'
  import { t } from './lib/i18n.svelte'
  import RoutePage from './components/RoutePage.svelte'
  import ErrorBoundary from './components/ErrorBoundary.svelte'
  import RecoveryPanel from './components/RecoveryPanel.svelte'
  import NotificationViewport from './components/NotificationViewport.svelte'
  import { pwa } from './lib/pwa.svelte'

  onMount(() => core.boot())
  onMount(() => pwa.start())

  $effect(() => {
    if (core.status === 'ok' && pwa.hostedAuto && pwa.hostedAvailable && !pwa.checking && !pwa.hostedUpdating && !pwa.applying) {
      untrack(() => void pwa.updateHosted(false))
    }
  })

  // Hash routes share a document. A new screen starts at its heading instead
  // of inheriting the scroll position of the previous table or settings form.
  let previousRoute: string | null = null
  $effect(() => {
    const route = router.route
    if (previousRoute !== null && previousRoute !== route) window.scrollTo(0, 0)
    previousRoute = route
  })

  $effect(() => {
    document.title = core.status === 'boot' ? 'MIBoard' : `${router.route === 'setup' || core.status === 'setup' || core.status === 'connecting' ? t('backends.title') : t(`nav.${router.route}`)} · MIBoard`
  })

</script>

{#if core.status === 'boot'}
  <div class="min-h-dvh bg-page"></div>
{:else if router.route === 'setup' || core.status === 'setup' || core.status === 'connecting'}
  <RoutePage route="setup" />
{:else}
  {#await import('./components/Shell.svelte')}
    <div class="min-h-dvh bg-page px-6 py-8 text-sm text-fg-2" role="status">{t('common.loadingPage')}</div>
  {:then module}
    <ErrorBoundary>
      <module.default>
        {#key router.route}
          <div class="enter"><RoutePage route={router.route} /></div>
        {/key}
      </module.default>
    </ErrorBoundary>
  {:catch}
    <RecoveryPanel loading />
  {/await}
{/if}

<NotificationViewport />
{#if core.status === 'ok' || core.status === 'lost'}
  {#key JSON.stringify([core.backend.url, core.backend.secret])}
    {#await import('./components/ClientTools.svelte') then module}<module.default backend={core.backend} />{/await}
  {/key}
{/if}
