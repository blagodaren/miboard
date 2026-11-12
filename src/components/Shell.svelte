<script lang="ts">
  import { tick } from 'svelte'
  import type { Action } from 'svelte/action'
  import type { Snippet } from 'svelte'
  import { core, router, type Route } from '../lib/core.svelte'
  import type { Mode } from '../lib/api'
  import { t } from '../lib/i18n.svelte'
  import { count } from '../lib/format'
  import { embed } from '../lib/embed'
  import {
    IconOverview,
    IconProxies,
    IconConnections,
    IconDevices,
    IconAnalysis,
    IconGeography,
    IconRules,
    IconLogs,
    IconSettings,
    IconServer,
  } from '../lib/icons'
  import Segmented from './Segmented.svelte'
  import Brand from './Brand.svelte'
  import SidebarStats from './SidebarStats.svelte'
  import LiveUpdateNotice from './LiveUpdateNotice.svelte'
  import IconHistory from '@lucide/svelte/icons/history'

  let { children }: { children: Snippet } = $props()

  const nav: { route: Exclude<Route, 'setup'>; icon: typeof IconOverview }[] = [
    { route: 'overview', icon: IconOverview },
    { route: 'proxies', icon: IconProxies },
    { route: 'devices', icon: IconDevices },
    { route: 'connections', icon: IconConnections },
    { route: 'analysis', icon: IconAnalysis },
    { route: 'geography', icon: IconGeography },
    { route: 'rules', icon: IconRules },
    { route: 'logs', icon: IconLogs },
    { route: 'history', icon: IconHistory },
    { route: 'fleet', icon: IconServer },
    { route: 'settings', icon: IconSettings },
  ]
  const modes: { value: Mode; label: string }[] = $derived([
    { value: 'rule', label: t('mode.rule') },
    { value: 'global', label: t('mode.global') },
    { value: 'direct', label: t('mode.direct') },
  ])

  const host = $derived(core.backend.url.replace(/^https?:\/\//, ''))
  const linkUp = $derived(core.status === 'ok')

  // Keep the active section visible in either scrollable navigation.
  // Scroll only the menu: scrollIntoView would also move the page content.
  const revealSection: Action<HTMLElement, Route> = (element) => {
    let disposed = false
    const reveal = async () => {
      await tick()
      if (disposed || !element.clientWidth) return
      const selected = element.querySelector<HTMLElement>('[aria-current="page"]')
      if (!selected) return
      const menu = element.getBoundingClientRect()
      const item = selected.getBoundingClientRect()
      if (getComputedStyle(element).flexDirection === 'column') element.scrollTop += item.top - menu.top - (element.clientHeight - item.height) / 2
      else element.scrollLeft += item.left - menu.left - (element.clientWidth - item.width) / 2
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(element)
    void reveal()
    return {
      update: reveal,
      destroy() { disposed = true; observer.disconnect() },
    }
  }
</script>

{#snippet brand()}
  <div class="flex items-center gap-2.5">
    <Brand />
    <span
      class="led"
      data-on={linkUp}
      data-state={core.status === 'lost' ? 'down' : undefined}
      title={linkUp ? t('status.connected') : t('status.disconnected')}
    ></span>
  </div>
{/snippet}

<div class="flex min-h-dvh">
  <!-- Сайдбар: десктоп -->
  <aside
    class="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col overflow-y-auto border-r border-line bg-deep px-3 pb-4 pt-5 md:flex"
  >
    <div class="shrink-0 px-3">{@render brand()}</div>

    <nav use:revealSection={router.route} class="mt-8 flex min-h-24 flex-col gap-0.5 overflow-y-auto" aria-label={t('nav.sections')}>
      {#each nav as item (item.route)}
        {@const active = router.route === item.route}
        <a
          href="#/{item.route}"
          aria-current={active ? 'page' : undefined}
          class="sidebar-link flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 transition-colors duration-150
            {active ? 'bg-nav-active font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}"
        >
          <item.icon class="size-4 {active ? 'text-fg' : 'text-fg-3'}" strokeWidth={1.5} />
          <span class="flex-1">{t(`nav.${item.route}`)}</span>
          {#if item.route === 'connections' && core.conns.length}
            <span class="num font-mono text-xs text-fg-3">{count(core.conns.length)}</span>
          {/if}
        </a>
      {/each}
    </nav>

    <div class="mt-auto flex shrink-0 flex-col gap-3 px-1 pt-3">
      <SidebarStats />
      {#if core.configs && !embed.hideMode}
        <div class="flex flex-col gap-2">
          <span class="px-2 text-xs text-fg-3">{t('mode.label')}</span>
          <Segmented label={t('mode.routing')} full value={core.configs.mode} options={modes} onchange={(m) => core.setMode(m)} />
        </div>
      {/if}
      <a href="#/setup" class="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-fg-2 transition-colors hover:bg-hover hover:text-fg" title={t('backends.switchServer')}>
        <IconServer class="size-4 shrink-0" strokeWidth={1.5} />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs">{core.backend.name || host}</span>
          <span class="mt-0.5 block truncate font-mono text-xs text-fg-3">{core.version}</span>
        </span>
      </a>
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <!-- Верхняя строка: мобильный -->
    <div class="sticky top-0 z-20 flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line bg-deep px-4 py-2 max-[360px]:[&_button]:px-1.5 md:hidden">
      {@render brand()}
      {#if core.configs && !embed.hideMode}
        <Segmented label={t('mode.routing')} value={core.configs.mode} options={modes} onchange={(m) => core.setMode(m)} />
      {/if}
    </div>

    <main class="mx-auto w-full flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-12 md:pt-8 {router.route === 'connections' || router.route === 'proxies' ? 'max-w-none' : 'max-w-[1440px]'}">
      <LiveUpdateNotice />
      {@render children()}
    </main>

    <!-- Нижние вкладки: мобильный -->
    <nav
      use:revealSection={router.route}
      class="mobile-sections fixed inset-x-0 bottom-0 z-20 flex overflow-x-auto border-t border-line bg-deep pb-[env(safe-area-inset-bottom)] md:hidden"
      aria-label={t('nav.sections')}
    >
      {#each nav as item (item.route)}
        {@const active = router.route === item.route}
        <a
          href="#/{item.route}"
          aria-current={active ? 'page' : undefined}
          class="flex h-14 min-w-[88px] flex-1 shrink-0 flex-col items-center justify-center gap-1 border-t-2 text-xs leading-none transition-colors
            {active ? 'border-accent-ink bg-nav-active font-medium text-fg' : 'border-transparent text-fg-3 hover:bg-hover'}"
        >
          <item.icon class="size-[18px]" strokeWidth={1.5} />
          <span class="max-w-full truncate px-0.5">{t(`nav.${item.route}`)}</span>
        </a>
      {/each}
    </nav>
  </div>
</div>

<style>
  .sidebar-link[aria-current='page'] { box-shadow: inset 3px 0 var(--accent); }
  .mobile-sections { scrollbar-width: thin; scrollbar-color: var(--line-strong) var(--deep); }
</style>
