<script lang="ts">
  import { onDestroy } from 'svelte'
  import { api, errorMessage } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'

  type Action = 'flush' | 'model'
  const backend = { ...core.backend }
  let active = true
  let configName = $state('')
  let pendingConfig = $state('')
  let confirmFlush = $state(false)
  let busy = $state<Action | null>(null)
  let completed = $state<Action | null>(null)
  let error = $state.raw<unknown>(null)
  const cfg = $derived(core.configs)
  const hasParameters = $derived(cfg && (
    typeof cfg['lgbm-auto-update'] === 'boolean' ||
    typeof cfg['lgbm-update-interval'] === 'number' ||
    typeof cfg['lgbm-url'] === 'string' ||
    (typeof cfg['smart-collector-size'] === 'number' && cfg['smart-collector-size'] > 0)
  ))

  onDestroy(() => { active = false })

  function currentBackend() {
    return active && core.prizrak && core.backend.url === backend.url && core.backend.secret === backend.secret
  }

  function requestFlush() {
    if (busy || !currentBackend()) return
    pendingConfig = configName.trim()
    confirmFlush = true
  }

  async function run(action: Action) {
    if (busy || !currentBackend()) return
    busy = action
    completed = null
    error = null
    try {
      if (action === 'flush') await api.flushSmart(pendingConfig || undefined, backend)
      else await api.upgradeLightGBM(backend)
      if (currentBackend()) completed = action
    } catch (cause) {
      if (currentBackend()) error = cause
    } finally {
      if (active) busy = null
    }
  }
</script>

<section aria-labelledby="prizrak-heading">
  <h2 id="prizrak-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('prizrak.title')}</h2>
  <div class="rounded-panel border border-line bg-card" aria-busy={busy !== null}>
    <p class="px-4 py-4 text-[13px] text-fg-3 sm:px-5">{t('prizrak.description')}</p>

    {#if cfg && hasParameters}
      <dl class="border-t border-line text-[13px]">
        {#if typeof cfg['lgbm-auto-update'] === 'boolean'}
          <div class="flex flex-wrap justify-between gap-x-6 gap-y-1 px-4 py-3 sm:px-5">
            <dt class="text-fg-2">{t('prizrak.autoUpdate')}</dt>
            <dd>{t(cfg['lgbm-auto-update'] ? 'prizrak.enabled' : 'prizrak.disabled')}</dd>
          </div>
        {/if}
        {#if typeof cfg['lgbm-update-interval'] === 'number'}
          <div class="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-line px-4 py-3 sm:px-5">
            <dt class="text-fg-2">{t('prizrak.updateInterval')}</dt>
            <dd class="num font-mono">{t('prizrak.hours', { count: cfg['lgbm-update-interval'] })}</dd>
          </div>
        {/if}
        {#if typeof cfg['lgbm-url'] === 'string'}
          <div class="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-line px-4 py-3 sm:px-5">
            <dt class="text-fg-2">{t('prizrak.modelUrl')}</dt>
            <dd class="min-w-0 break-all font-mono sm:max-w-[65%]">{cfg['lgbm-url'] || t('prizrak.notConfigured')}</dd>
          </div>
        {/if}
        {#if typeof cfg['smart-collector-size'] === 'number' && cfg['smart-collector-size'] > 0}
          <div class="flex flex-wrap justify-between gap-x-6 gap-y-1 border-t border-line px-4 py-3 sm:px-5">
            <dt class="text-fg-2">{t('prizrak.collectorSize')}</dt>
            <dd class="num font-mono">{t('prizrak.megabytes', { count: cfg['smart-collector-size'] })}</dd>
          </div>
        {/if}
      </dl>
      <p class="border-t border-line px-4 py-3 text-[13px] text-fg-3 sm:px-5">{t('prizrak.configHint')}</p>
    {/if}

    <div class="border-t border-line px-4 py-4 sm:px-5">
      <div>{t('prizrak.history')}</div>
      <p id="prizrak-config-hint" class="mt-0.5 text-[13px] text-fg-3">{t('prizrak.historyHint')}</p>
      <div class="mt-4 flex flex-wrap items-end gap-3">
        <div class="min-w-0 flex-1 basis-56">
          <label for="prizrak-config" class="mb-2 block text-[13px] text-fg-2">{t('prizrak.configName')}</label>
          <input
            id="prizrak-config"
            class="h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px] text-fg transition-colors hover:border-fg-3 focus-visible:border-accent-ink disabled:opacity-50 sm:h-10"
            type="text"
            bind:value={configName}
            placeholder={t('prizrak.configPlaceholder')}
            aria-describedby="prizrak-config-hint"
            autocomplete="off"
            spellcheck="false"
            disabled={busy !== null}
          />
        </div>
        <Button size="sm" class="!h-11 sm:!h-10" disabled={busy !== null} onclick={requestFlush}>{t(busy === 'flush' ? 'prizrak.busy' : 'prizrak.flush')}</Button>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line px-4 py-4 sm:px-5">
      <div class="min-w-0 flex-1 basis-56">
        <div>{t('prizrak.model')}</div>
        <p class="mt-0.5 text-[13px] text-fg-3">{t('prizrak.modelHint')}</p>
      </div>
      <Button size="sm" disabled={busy !== null} onclick={() => run('model')}>{t(busy === 'model' ? 'prizrak.busy' : 'prizrak.updateModel')}</Button>
    </div>

    {#if error}
      <p class="break-words border-t border-line px-4 py-3 text-[13px] text-bad sm:px-5" role="alert">{errorMessage(error)}</p>
    {:else if completed}
      <p class="border-t border-line px-4 py-3 text-[13px] text-good sm:px-5" role="status">{t(completed === 'flush' ? 'prizrak.flushDone' : 'prizrak.modelDone')}</p>
    {/if}
  </div>
</section>

<Confirm
  bind:open={confirmFlush}
  title={t('prizrak.flushTitle')}
  description={pendingConfig ? t('prizrak.flushConfigDescription', { name: pendingConfig }) : t('prizrak.flushAllDescription')}
  action={t('prizrak.flush')}
  onconfirm={() => run('flush')}
/>
