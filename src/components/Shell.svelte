<script lang="ts">
  import { tick } from 'svelte'
  import type { Action } from 'svelte/action'
  import type { Snippet } from 'svelte'
  import { core, router, type Route } from '../lib/core.svelte'
  import type { Mode } from '../lib/api'
  import { t } from '../lib/i18n.svelte'
  import { count } from '../lib/format'
  import { embed } from '../lib/embed'
  import { IconServer, IconMore, NAV_ICONS } from '../lib/icons'
  import { NAV_ROUTES, MOBILE_NAV_SLOTS } from '../lib/mobile-nav'
  import { appearance } from '../lib/appearance.svelte'
  import Segmented from './Segmented.svelte'
  import Brand from './Brand.svelte'
  import SidebarStats from './SidebarStats.svelte'
  import LiveUpdateNotice from './LiveUpdateNotice.svelte'
  import IconCollapse from '@lucide/svelte/icons/panel-left-close'
  import IconExpand from '@lucide/svelte/icons/panel-left-open'

  let { children }: { children: Snippet } = $props()

  const nav = NAV_ROUTES.map(route => ({ route, icon: NAV_ICONS[route] }))
  const collapsed = $derived(appearance.sidebarCollapsed)
  const bar = $derived(appearance.mobileNav.slice(0, MOBILE_NAV_SLOTS).map(route => ({ route, icon: NAV_ICONS[route] })))
  const more = $derived(appearance.mobileNav.slice(MOBILE_NAV_SLOTS).map(route => ({ route, icon: NAV_ICONS[route] })))
  const moreActive = $derived(more.some(item => item.route === router.route))
  const barIndex = $derived(moreActive ? bar.length : bar.findIndex(item => item.route === router.route))
  let moreOpen = $state(false)
  let moreTrigger = $state<HTMLButtonElement>()
  $effect(() => { void router.route; moreOpen = false })
  function closeMore() {
    moreOpen = false
    moreTrigger?.focus({ preventScroll: true })
  }

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

{#snippet brand(compact = false)}
  <div class="flex items-center gap-2.5" class:justify-center={compact}>
    <Brand {compact} />
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
    class="sticky top-0 hidden h-dvh shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-line bg-deep pb-4 pt-5 transition-[width] duration-200 md:flex {collapsed ? 'w-[72px] px-2' : 'w-[248px] px-3'}"
    data-collapsed={collapsed}
    data-testid="sidebar"
  >
    <div class="shrink-0 {collapsed ? 'flex flex-col items-center gap-2' : 'px-3'}">{@render brand(collapsed)}</div>

    <nav use:revealSection={router.route} class="mt-8 flex min-h-24 flex-col gap-0.5 overflow-y-auto" aria-label={t('nav.sections')}>
      {#each nav as item (item.route)}
        {@const active = router.route === item.route}
        <a
          href="#/{item.route}"
          aria-current={active ? 'page' : undefined}
          title={collapsed ? t(`nav.${item.route}`) : undefined}
          class="sidebar-link relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg transition-colors duration-150 {collapsed ? 'justify-center px-0' : 'px-3'}
            {active ? 'bg-nav-active font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'}"
        >
          <item.icon class="size-4 shrink-0 {active ? 'text-fg' : 'text-fg-3'}" strokeWidth={1.5} />
          <span class="flex-1" class:sr-only={collapsed}>{t(`nav.${item.route}`)}</span>
          {#if item.route === 'connections' && core.conns.length}
            {#if collapsed}<span class="count-dot" aria-hidden="true"></span>{:else}<span class="num font-mono text-xs text-fg-3">{count(core.conns.length)}</span>{/if}
          {/if}
        </a>
      {/each}
    </nav>

    <div class="mt-auto flex shrink-0 flex-col gap-3 pt-3 {collapsed ? 'items-center' : 'px-1'}">
      {#if !collapsed}
        <SidebarStats />
        {#if core.configs && !embed.hideMode}
          <div class="flex flex-col gap-2">
            <span class="px-2 text-xs text-fg-3">{t('mode.label')}</span>
            <Segmented label={t('mode.routing')} full value={core.configs.mode} options={modes} onchange={(m) => core.setMode(m)} />
          </div>
        {/if}
      {/if}
      <div class="flex min-w-0 items-center gap-1 {collapsed ? 'flex-col' : ''}">
        <a href="#/setup" class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-fg-2 transition-colors hover:bg-hover hover:text-fg" title={collapsed ? `${core.backend.name || host} · ${core.version}` : t('backends.switchServer')}>
          <IconServer class="size-4 shrink-0" strokeWidth={1.5} />
          <span class="min-w-0 flex-1" class:sr-only={collapsed}>
            <span class="block truncate text-xs">{core.backend.name || host}</span>
            <span class="mt-0.5 block truncate font-mono text-xs text-fg-3">{core.version}</span>
          </span>
        </a>
        <button type="button" class="flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-hover hover:text-fg" data-testid="sidebar-toggle"
          aria-label={t(collapsed ? 'nav.expand' : 'nav.collapse')} title={t(collapsed ? 'nav.expand' : 'nav.collapse')} aria-expanded={!collapsed} onclick={() => appearance.toggleSidebar()}>
          {#if collapsed}<IconExpand class="size-4" strokeWidth={1.5} />{:else}<IconCollapse class="size-4" strokeWidth={1.5} />{/if}
        </button>
      </div>
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

    <!-- Нижняя панель: мобильный. Порядок задаётся в настройках, остальное — в ⋯ -->
    {#if moreOpen}<button type="button" class="more-backdrop md:hidden" tabindex="-1" aria-hidden="true" onclick={closeMore}></button>{/if}
    <nav class="mobile-sections flex md:hidden" aria-label={t('nav.sections')} style:--tab-count={bar.length + (more.length ? 1 : 0)} style:--tab-index={barIndex}>
      {#if barIndex >= 0}<span class="tab-indicator" aria-hidden="true"></span>{/if}
      {#each bar as item (item.route)}
        {@const active = router.route === item.route}
        <a href="#/{item.route}" aria-current={active ? 'page' : undefined} class="tab-item" class:active onclick={() => (moreOpen = false)}>
          <item.icon class="size-[18px]" strokeWidth={1.5} />
          <span class="tab-label">{t(`nav.${item.route}`)}</span>
        </a>
      {/each}
      {#if more.length}
        <button bind:this={moreTrigger} type="button" class="tab-item" class:active={moreActive} data-testid="mobile-nav-more" aria-expanded={moreOpen} aria-controls="mobile-nav-more" onclick={() => (moreOpen = !moreOpen)}>
          <IconMore class="size-[18px]" strokeWidth={1.5} />
          <span class="tab-label">{t('nav.more')}</span>
        </button>
      {/if}
      {#if moreOpen}
        <div id="mobile-nav-more" class="more-panel" data-testid="mobile-nav-more-panel">
          {#each more as item (item.route)}
            {@const active = router.route === item.route}
            <a href="#/{item.route}" aria-current={active ? 'page' : undefined} class="more-item" class:active onclick={closeMore}>
              <item.icon class="size-[18px] shrink-0" strokeWidth={1.5} />
              <span class="min-w-0 truncate">{t(`nav.${item.route}`)}</span>
            </a>
          {/each}
        </div>
      {/if}
    </nav>
  </div>
</div>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && moreOpen) { event.preventDefault(); closeMore() } }} />

<style>
  .sidebar-link[aria-current='page'] { box-shadow: inset 3px 0 var(--accent); }
  .count-dot { position: absolute; top: 7px; right: 12px; width: 6px; height: 6px; border-radius: 9999px; background: var(--accent); }
  @media (prefers-reduced-motion: reduce) { aside { transition: none; } }
  .mobile-sections {
    position: fixed; z-index: 20; left: 12px; right: 12px; bottom: calc(8px + env(safe-area-inset-bottom));
    height: 56px; padding: 4px; border: 1px solid var(--line); border-radius: 9999px;
    background: color-mix(in oklab, var(--deep) 82%, transparent); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%);
    box-shadow: var(--shadow-float);
  }
  .tab-indicator {
    position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 8px) / var(--tab-count)); border-radius: 9999px;
    background: color-mix(in oklab, var(--accent) 16%, transparent); transform: translateX(calc(100% * var(--tab-index)));
    transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1); pointer-events: none;
  }
  .tab-item {
    position: relative; display: flex; min-width: 0; flex: 1 1 0; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    border-radius: 9999px; color: var(--text-3); font-size: 11px; line-height: 14px; transition: color 0.15s;
  }
  .tab-item.active { color: var(--accent-ink); font-weight: 500; }
  .tab-label { max-width: 100%; overflow: hidden; padding: 0 2px; text-overflow: ellipsis; white-space: nowrap; }
  .more-panel {
    position: absolute; right: 0; bottom: calc(100% + 8px); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px;
    width: min(320px, 100%); padding: 6px; border: 1px solid var(--line); border-radius: 20px; background: var(--card); box-shadow: var(--shadow-float);
    transform-origin: bottom right; animation: more-in 0.18s ease-out;
  }
  .more-item { display: flex; min-height: 44px; align-items: center; gap: 10px; padding: 0 12px; border-radius: 14px; color: var(--text-2); font-size: 13px; }
  .more-item:hover { background: var(--hover); color: var(--text); }
  .more-item.active { background: var(--selected); color: var(--selected-text); font-weight: 500; }
  .more-backdrop { position: fixed; inset: 0; z-index: 19; }
  @keyframes more-in { from { opacity: 0; transform: translateY(6px) scale(0.97); } }
  @media (prefers-reduced-motion: reduce) { .tab-indicator { transition: none; } .more-panel { animation: none; } }
</style>
