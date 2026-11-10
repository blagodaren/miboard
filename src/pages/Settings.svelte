<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Tabs } from 'bits-ui'
  import IconPaintbrush from '@lucide/svelte/icons/paintbrush'
  import IconDatabase from '@lucide/svelte/icons/database'
  import IconWrench from '@lucide/svelte/icons/wrench'
  import { api, errorMessage, type Mode } from '../lib/api'
  import { core, router, theme, type Theme } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { embed } from '../lib/embed'
  import { IconLogout, IconServer, IconProxies } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Toggle from '../components/Toggle.svelte'
  import Confirm from '../components/Confirm.svelte'
  import LanguageSelect from '../components/LanguageSelect.svelte'
  import DelaySettings from '../components/DelaySettings.svelte'
  import PrizrakSettings from '../components/PrizrakSettings.svelte'
  import SettingsTransfer from '../components/SettingsTransfer.svelte'
  import JournalSettings from '../components/JournalSettings.svelte'
  import AppSettings from '../components/AppSettings.svelte'
  import CoreStatus from '../components/CoreStatus.svelte'
  import CoreProfiles from '../components/CoreProfiles.svelte'
  import SettingsSync from '../components/SettingsSync.svelte'
  import ProviderAlertSettings from '../components/ProviderAlertSettings.svelte'
  import LiveUpdateSettings from '../components/LiveUpdateSettings.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { appearance } from '../lib/appearance.svelte'
  import type { ProxyCardSize, ProxyGroupHeight } from '../lib/appearance'

  const categories = [
    { value: 'appearance', label: 'settings.appearance', hint: 'settings.category.appearanceHint', icon: IconPaintbrush },
    { value: 'core', label: 'settings.category.core', hint: 'settings.category.coreHint', icon: IconServer },
    { value: 'proxies', label: 'nav.proxies', hint: 'settings.category.proxiesHint', icon: IconProxies },
    { value: 'data', label: 'settings.category.data', hint: 'settings.category.dataHint', icon: IconDatabase },
    { value: 'maintenance', label: 'settings.category.maintenance', hint: 'settings.category.maintenanceHint', icon: IconWrench },
  ] as const
  type Category = typeof categories[number]['value']
  function readCategory(): Category {
    const value = new URLSearchParams(location.hash.split('?')[1]).get('category')
    return categories.find((item) => item.value === value)?.value ?? 'appearance'
  }
  let category = $state<Category>(readCategory())
  const selectedCategory = $derived(categories.find((item) => item.value === category) ?? categories[0])
  function changeCategory(value: string) {
    const next = categories.find((item) => item.value === value)
    if (!next) return
    category = next.value
    const params = new URLSearchParams(location.hash.split('?')[1])
    params.set('category', next.value)
    location.hash = `/settings?${params}`
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const backend = { ...core.backend }
  let active = true
  let busy = $state<Record<string, boolean>>({})
  let confirmRestart = $state(false)
  let cardSizeSaved = $state(true)
  let groupHeightSaved = $state(true)
  const groupHeights = $derived([
    { value: 'compact' as const, label: t('settings.groupHeight.compact') },
    { value: 'large' as const, label: t('settings.groupHeight.large') },
    { value: 'full' as const, label: t('settings.groupHeight.full') },
  ])
  function changeGroupHeight(value: ProxyGroupHeight) { groupHeightSaved = appearance.setProxyGroupHeight(value) }
  const cardSizes = $derived([
    { value: 'large' as const, label: t('settings.proxyCards.large') },
    { value: 'compact' as const, label: t('settings.proxyCards.compact') },
  ])
  function changeCardSize(value: ProxyCardSize) { cardSizeSaved = appearance.setProxyCardSize(value) }
  onDestroy(() => { active = false })
  const current = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret

  async function run(key: string, title: () => string, fn: () => Promise<unknown>) {
    if (busy[key] || !current()) return
    busy[key] = true
    try {
      await fn()
      if (current()) notifications.show({ id: `settings:${key}`, tone: 'success', title, message: () => t('common.done'), scope: backend.url })
    } catch (error) {
      if (current()) notifications.show({ id: `settings:${key}`, tone: 'error', title, message: () => errorMessage(error), scope: backend.url })
    } finally {
      if (active) busy[key] = false
    }
  }

  function patch(key: string, title: () => string, body: Record<string, unknown>) {
    void run(key, title, async () => {
      await api.patchConfigs(body)
      if (current()) await core.refreshConfigs()
    })
  }

  const modes: { value: Mode; label: string }[] = $derived([
    { value: 'rule', label: t('mode.rule') },
    { value: 'global', label: t('mode.global') },
    { value: 'direct', label: t('mode.direct') },
  ])
  const themes: { value: Theme; label: string }[] = $derived([
    { value: 'system', label: t('settings.theme.system') },
    { value: 'dark', label: t('settings.theme.dark') },
    { value: 'light', label: t('settings.theme.light') },
  ])
  const ports = $derived(
    core.configs
      ? [
          ['mixed', core.configs['mixed-port']],
          ['http', core.configs.port],
          ['socks', core.configs['socks-port']],
        ].filter(([, p]) => p)
      : [],
  )
</script>

<svelte:window onhashchange={() => { category = readCategory() }} />

{#snippet row(title: string, hint: string, control: import('svelte').Snippet)}
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line px-4 py-4 first:border-t-0 sm:px-5">
    <div class="min-w-0 max-w-full flex-1 basis-44">
      <div class="break-words [overflow-wrap:anywhere]">{title}</div>
      {#if hint}<div class="mt-0.5 text-[13px] text-fg-3">{hint}</div>{/if}
    </div>
    <div class="flex min-w-0 max-w-full flex-wrap items-center gap-3 sm:justify-end">{@render control()}</div>
  </div>
{/snippet}

{#snippet feedback(key: string)}
  {#if busy[key]}<span class="font-mono text-xs text-fg-3" role="status">…</span>{/if}
{/snippet}

{#snippet action(key: string, label: string, title: () => string, fn: () => Promise<unknown>)}
  {@render feedback(key)}
  <Button size="sm" disabled={busy[key]} onclick={() => run(key, title, fn)}>{label}</Button>
{/snippet}

<PageHeader title={t('nav.settings')} />

<Tabs.Root value={category} onValueChange={changeCategory} orientation="vertical" activationMode="manual" class="grid max-w-[1020px] items-start gap-6 lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-8">
  <Tabs.List aria-label={t('settings.categories')} class="hidden flex-col gap-1 lg:sticky lg:top-8 lg:flex">
    {#each categories as item (item.value)}
      <Tabs.Trigger value={item.value} data-testid="settings-category-{item.value}" class="flex min-h-11 items-center gap-2.5 rounded-control border border-transparent px-3 py-2.5 text-left text-[13px] text-fg-2 transition-colors hover:bg-hover hover:text-fg data-[state=active]:border-selected-border data-[state=active]:bg-selected data-[state=active]:font-medium data-[state=active]:text-selected-text">
        <item.icon class="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span>{t(item.label)}</span>
      </Tabs.Trigger>
    {/each}
  </Tabs.List>

  <div class="lg:hidden">
    <label for="settings-category" class="mb-2 block text-xs text-fg-2">{t('settings.categories')}</label>
    <select id="settings-category" data-testid="settings-category-select" value={category} onchange={(event) => changeCategory(event.currentTarget.value)} class="h-11 w-full rounded-control border border-field-border bg-field px-3 text-[13px] text-fg">
      {#each categories as item (item.value)}<option value={item.value}>{t(item.label)}</option>{/each}
    </select>
  </div>

  <div class="min-w-0">
    <header class="mb-6">
      <h2 class="text-lg font-medium">{t(selectedCategory.label)}</h2>
      <p class="mt-1 text-[13px] leading-relaxed text-fg-3">{t(selectedCategory.hint)}</p>
    </header>

    <!-- Tabs.Content keeps every panel mounted, preserving drafts and pending operations. -->
    <Tabs.Content value="core" data-testid="settings-category-panel-core" class="flex min-w-0 flex-col gap-6 data-[state=inactive]:hidden">
      <section>
        <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.connection')}</h2>
        <div class="rounded-panel border border-line bg-card">
          {#snippet backendCtl()}
            <Button size="sm" variant="ghost" onclick={() => router.go('setup')}><IconLogout strokeWidth={1.5} />{t('settings.change')}</Button>
          {/snippet}
          {@render row(core.backend.url, core.version ? `${core.prizrak ? 'Prizrak-Core' : 'mihomo'} ${core.version}` : '', backendCtl)}
        </div>
      </section>

      {#if core.configs}
        {@const cfg = core.configs}
        <section>
          <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.core')}</h2>
          <div class="rounded-panel border border-line bg-card">
            {#if !embed.hideMode}
              {#snippet modeCtl()}
                <Segmented full label={t('mode.routing')} value={cfg.mode} options={modes} onchange={(m) => core.setMode(m)} />
              {/snippet}
              {@render row(t('mode.label'), t('settings.modeHint'), modeCtl)}
            {/if}

            {#snippet tunCtl()}
              <Toggle label="TUN" checked={!!cfg.tun?.enable} disabled={busy.tun} onchange={(v) => patch('tun', () => 'TUN', { tun: { enable: v } })} />
            {/snippet}
            {@render row('TUN', t('settings.tunHint'), tunCtl)}

            {#snippet lanCtl()}
              <Toggle label={t('settings.allowLan')} checked={!!cfg['allow-lan']} disabled={busy.lan} onchange={(v) => patch('lan', () => t('settings.allowLan'), { 'allow-lan': v })} />
            {/snippet}
            {@render row(t('settings.allowLan'), t('settings.lanHint'), lanCtl)}

            {#if ports.length}
              {#snippet portsCtl()}
                <span class="num font-mono text-xs text-fg-2">{ports.map(([n, p]) => `${n} ${p}`).join(' · ')}</span>
              {/snippet}
              {@render row(t('settings.ports'), '', portsCtl)}
            {/if}
          </div>
        </section>
      {/if}

      <CoreStatus />
      <CoreProfiles />

      {#if core.prizrak}
        <PrizrakSettings />
      {/if}
    </Tabs.Content>

    <Tabs.Content value="proxies" data-testid="settings-category-panel-proxies" class="flex min-w-0 flex-col gap-6 data-[state=inactive]:hidden">
      <DelaySettings />
      <ProviderAlertSettings />
    </Tabs.Content>

    <Tabs.Content value="data" data-testid="settings-category-panel-data" class="flex min-w-0 flex-col gap-6 data-[state=inactive]:hidden">
      <LiveUpdateSettings />
      <JournalSettings />
      <SettingsSync />
      <SettingsTransfer />
    </Tabs.Content>

    <Tabs.Content value="maintenance" data-testid="settings-category-panel-maintenance" class="flex min-w-0 flex-col gap-6 data-[state=inactive]:hidden">
      <AppSettings />
      <section>
        <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.maintenance')}</h2>
        <div class="rounded-panel border border-line bg-card">
          {#snippet fakeIp()}{@render action('fakeip', t('settings.flush'), () => t('settings.fakeIpCache'), api.flushFakeIp)}{/snippet}
          {@render row(t('settings.fakeIpCache'), t('settings.fakeIpHint'), fakeIp)}
          {#snippet dns()}{@render action('dns', t('settings.flush'), () => t('settings.dnsCache'), api.flushDns)}{/snippet}
          {@render row(t('settings.dnsCache'), '', dns)}
          {#snippet reload()}{@render action('reload', t('settings.reload'), () => t('settings.config'), () => api.reloadConfig().then(() => { if (current()) return core.refreshConfigs() }))}{/snippet}
          {@render row(t('settings.config'), t('settings.configHint'), reload)}
          {#snippet restart()}
            {@render feedback('restart')}
            <Button size="sm" variant="ghost" class="!text-bad" disabled={busy.restart} onclick={() => (confirmRestart = true)}>{t('settings.restart')}</Button>
          {/snippet}
          {@render row(t('settings.core'), t('settings.restartHint'), restart)}
        </div>
      </section>
    </Tabs.Content>

    <Tabs.Content value="appearance" data-testid="settings-category-panel-appearance" class="min-w-0 data-[state=inactive]:hidden">
      <div class="rounded-panel border border-line bg-card">
        {#snippet themeCtl()}
          <Segmented full label={t('settings.theme')} value={theme.value} options={themes} onchange={(value) => theme.set(value)} />
        {/snippet}
        {@render row(t('settings.theme'), '', themeCtl)}
        {#snippet cardSizeCtl()}
          <div data-testid="proxy-card-size-settings"><Segmented full label={t('settings.proxyCardSize')} value={appearance.proxyCardSize} options={cardSizes} onchange={changeCardSize} /></div>
        {/snippet}
        {@render row(t('settings.proxyCardSize'), t('settings.proxyCardSizeHint'), cardSizeCtl)}
        <div class="border-t border-line px-4 py-4 sm:px-5">
          <p class="mb-3 text-xs text-fg-3">{t('settings.proxyCardPreview')}</p>
          <div class="proxy-card-preview" class:compact={appearance.proxyCardSize === 'compact'} data-testid="proxy-card-preview" data-size={appearance.proxyCardSize}>
            <span class="preview-name">{t('settings.proxyCardExample')}</span>
            <div class="preview-meta"><span>VLESS</span><span>—</span></div>
          </div>
          {#if !cardSizeSaved}<p class="mt-3 text-xs text-warning" role="status">{t('settings.appearanceMemory')}</p>{/if}
        </div>
        {#snippet groupHeightCtl()}
          <div data-testid="proxy-group-height-settings"><Segmented full label={t('settings.groupHeight')} value={appearance.proxyGroupHeight} options={groupHeights} onchange={changeGroupHeight} /></div>
        {/snippet}
        {@render row(t('settings.groupHeight'), t('settings.groupHeightHint'), groupHeightCtl)}
        {#if !groupHeightSaved}<p class="px-4 pb-4 text-xs text-warning sm:px-5" role="status">{t('settings.groupHeightMemory')}</p>{/if}
        <div class="flex justify-between border-t border-line px-4 py-4 sm:px-5">
          <LanguageSelect full />
        </div>
      </div>
    </Tabs.Content>
  </div>
</Tabs.Root>

<Confirm
  bind:open={confirmRestart}
  title={t('settings.restartTitle')}
  description={t('settings.restartDescription')}
  action={t('settings.restart')}
  onconfirm={() => run('restart', () => t('settings.restart'), api.restart)}
/>

<style>
  .proxy-card-preview { display: flex; flex-direction: column; justify-content: space-between; width: min(100%, 240px); height: 88px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--raised); }
  .preview-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 20px; }
  .preview-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-2); font-family: var(--font-mono); font-size: 12px; line-height: 16px; }
  .proxy-card-preview.compact { width: min(100%, 180px); height: 72px; padding: 6px 8px; }
  .compact .preview-name { font-size: 12px; line-height: 16px; }
  @media (min-width: 640px) {
    .proxy-card-preview { height: 72px; }
    .proxy-card-preview.compact { height: 56px; }
  }
</style>
