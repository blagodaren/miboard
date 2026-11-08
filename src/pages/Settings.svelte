<script lang="ts">
  import { version as appVersion } from '../../package.json'
  import { api, errorMessage, type Mode } from '../lib/api'
  import { core, router, theme, type Theme } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { IconLogout } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Toggle from '../components/Toggle.svelte'
  import Confirm from '../components/Confirm.svelte'
  import LanguageSelect from '../components/LanguageSelect.svelte'
  import DelaySettings from '../components/DelaySettings.svelte'

  type ActionResult = { status: 'busy' } | { status: 'done' } | { status: 'error'; error: unknown }
  let done = $state<Record<string, ActionResult | undefined>>({})
  let confirmRestart = $state(false)

  function result(key: string): string {
    const state = done[key]
    if (!state) return ''
    if (state.status === 'busy') return '…'
    if (state.status === 'done') return t('common.done')
    return errorMessage(state.error)
  }

  async function run(key: string, fn: () => Promise<unknown>) {
    done[key] = { status: 'busy' }
    try {
      await fn()
      done[key] = { status: 'done' }
    } catch (e) {
      done[key] = { status: 'error', error: e }
    }
    setTimeout(() => (done[key] = undefined), 2500)
  }

  async function patch(body: Record<string, unknown>) {
    await api.patchConfigs(body)
    await core.refreshConfigs()
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

{#snippet row(title: string, hint: string, control: import('svelte').Snippet)}
  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line px-5 py-4 first:border-t-0">
    <div class="min-w-0">
      <div>{title}</div>
      {#if hint}<div class="mt-0.5 text-[13px] text-fg-3">{hint}</div>{/if}
    </div>
    <div class="flex items-center gap-3">{@render control()}</div>
  </div>
{/snippet}

{#snippet action(key: string, label: string, fn: () => Promise<unknown>)}
  {#if done[key]}<span class="font-mono text-xs text-fg-3" role="status">{result(key)}</span>{/if}
  <Button size="sm" onclick={() => run(key, fn)}>{label}</Button>
{/snippet}

<PageHeader title={t('nav.settings')} />

<div class="flex max-w-3xl flex-col gap-8">
  <section>
    <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.connection')}</h2>
    <div class="rounded-2xl border border-line bg-card">
      {#snippet backendCtl()}
        <Button size="sm" variant="ghost" onclick={() => router.go('setup')}><IconLogout strokeWidth={1.5} />{t('settings.change')}</Button>
      {/snippet}
      {@render row(core.backend.url, core.version ? `mihomo ${core.version}` : '', backendCtl)}
    </div>
  </section>

  {#if core.configs}
    {@const cfg = core.configs}
    <section>
      <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.core')}</h2>
      <div class="rounded-2xl border border-line bg-card">
        {#snippet modeCtl()}
          <Segmented label={t('mode.routing')} value={cfg.mode} options={modes} onchange={(m) => core.setMode(m)} />
        {/snippet}
        {@render row(t('mode.label'), t('settings.modeHint'), modeCtl)}

        {#snippet tunCtl()}
          <Toggle label="TUN" checked={!!cfg.tun?.enable} onchange={(v) => patch({ tun: { enable: v } })} />
        {/snippet}
        {@render row('TUN', t('settings.tunHint'), tunCtl)}

        {#snippet lanCtl()}
          <Toggle label={t('settings.allowLan')} checked={!!cfg['allow-lan']} onchange={(v) => patch({ 'allow-lan': v })} />
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

  <DelaySettings />

  <section>
    <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.maintenance')}</h2>
    <div class="rounded-2xl border border-line bg-card">
      {#snippet fakeIp()}{@render action('fakeip', t('settings.flush'), api.flushFakeIp)}{/snippet}
      {@render row(t('settings.fakeIpCache'), t('settings.fakeIpHint'), fakeIp)}
      {#snippet dns()}{@render action('dns', t('settings.flush'), api.flushDns)}{/snippet}
      {@render row(t('settings.dnsCache'), '', dns)}
      {#snippet reload()}{@render action('reload', t('settings.reload'), () => api.reloadConfig().then(() => core.refreshConfigs()))}{/snippet}
      {@render row(t('settings.config'), t('settings.configHint'), reload)}
      {#snippet restart()}
        {#if done.restart}<span class="font-mono text-xs text-fg-3" role="status">{result('restart')}</span>{/if}
        <Button size="sm" variant="ghost" class="!text-bad" onclick={() => (confirmRestart = true)}>{t('settings.restart')}</Button>
      {/snippet}
      {@render row(t('settings.core'), t('settings.restartHint'), restart)}
    </div>
  </section>

  <section>
    <h2 class="mb-3 px-1 text-[13px] text-fg-2">{t('settings.appearance')}</h2>
    <div class="rounded-2xl border border-line bg-card">
      {#snippet themeCtl()}
        <Segmented label={t('settings.theme')} value={theme.value} options={themes} onchange={(value) => theme.set(value)} />
      {/snippet}
      {@render row(t('settings.theme'), '', themeCtl)}
      <div class="flex justify-between border-t border-line px-5 py-4">
        <LanguageSelect full />
      </div>
    </div>
  </section>

  <p class="px-1 font-mono text-xs text-fg-3">MIBoard {appVersion}</p>
</div>

<Confirm
  bind:open={confirmRestart}
  title={t('settings.restartTitle')}
  description={t('settings.restartDescription')}
  action={t('settings.restart')}
  onconfirm={() => run('restart', api.restart)}
/>
