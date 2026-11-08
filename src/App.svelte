<script lang="ts">
  import { onMount } from 'svelte'
  import { core, router } from './lib/core.svelte'
  import { t } from './lib/i18n.svelte'
  import Shell from './components/Shell.svelte'
  import Setup from './pages/Setup.svelte'
  import Overview from './pages/Overview.svelte'
  import Proxies from './pages/Proxies.svelte'
  import Connections from './pages/Connections.svelte'
  import Devices from './pages/Devices.svelte'
  import Analysis from './pages/Analysis.svelte'
  import Geography from './pages/Geography.svelte'
  import Rules from './pages/Rules.svelte'
  import Logs from './pages/Logs.svelte'
  import Settings from './pages/Settings.svelte'

  const pages = { overview: Overview, proxies: Proxies, connections: Connections, devices: Devices, analysis: Analysis, geography: Geography, rules: Rules, logs: Logs, settings: Settings }

  onMount(() => core.boot())

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

  const Page = $derived(router.route === 'setup' ? Overview : pages[router.route])
</script>

{#if core.status === 'boot'}
  <div class="min-h-dvh bg-page"></div>
{:else if router.route === 'setup' || core.status === 'setup' || core.status === 'connecting'}
  <Setup />
{:else}
  <Shell>
    {#key router.route}
      <div class="enter"><Page /></div>
    {/key}
  </Shell>
{/if}
