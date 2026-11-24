<script lang="ts">
  import { pwa } from '../lib/pwa.svelte'
  import { core } from '../lib/core.svelte'
  import { LATEST_DASHBOARD_URL } from '../lib/app-version'
  import { t } from '../lib/i18n.svelte'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'
  import Toggle from './Toggle.svelte'

  let { embedded = false }: { embedded?: boolean } = $props()
  const id = $props.id()
  const development = import.meta.env.DEV
  const busy = $derived(pwa.checking || pwa.applying || pwa.hostedUpdating)
  let confirming = $state(false)
  let pending = $state.raw<{ action: 'update' | 'auto'; url: string; secret: string; version: string | null } | null>(null)

  function confirmHosted(action: 'update' | 'auto') {
    pending = { action, url: core.backend.url, secret: core.backend.secret, version: pwa.latestVersion }
    confirming = true
  }

  function applyHosted() {
    const selection = pending
    pending = null
    if (!selection || selection.url !== core.backend.url || selection.secret !== core.backend.secret) return
    if (selection.action === 'auto') pwa.setHostedAuto(true)
    else if (selection.version === pwa.latestVersion) void pwa.updateHosted(true)
  }
</script>

<section aria-labelledby={embedded ? undefined : `${id}-heading`} aria-label={embedded ? t('pwa.title') : undefined} data-testid="app-settings">
  {#if !embedded}<h2 id="{id}-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('pwa.title')}</h2>{/if}
  <div class={embedded ? '' : 'rounded-panel border border-line bg-card'}>
    <div class="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
      <div class="min-w-0">
        <h3 class="text-[13px] text-fg-2">{t('pwa.version')}</h3>
        <p class="mt-1 break-all font-mono text-sm" data-testid="app-current-version">MIBoard {pwa.currentVersion}</p>
      </div>
      <div class="flex max-w-full flex-wrap gap-3">
        <Button size="sm" data-testid="pwa-check" disabled={busy} onclick={() => pwa.checkForUpdates(true)}>{t(pwa.checking ? 'pwa.checking' : 'pwa.check')}</Button>
        {#if pwa.canApply}
          <Button size="sm" variant="primary" data-testid="pwa-apply" disabled={busy} onclick={() => pwa.applyUpdate()}>{t(pwa.applying ? 'pwa.applying' : 'pwa.update')}</Button>
        {/if}
      </div>
    </div>

    <div class="border-t border-line p-4 sm:p-5" aria-labelledby="{id}-updates">
      <h3 id="{id}-updates" class="text-[13px]">{t('pwa.updates')}</h3>
      <div class="mt-1 text-[13px] text-fg-2" role="status" aria-live="polite" aria-atomic="true" data-testid="pwa-status">
        {#if pwa.applying}
          <p>{t('pwa.applying')}</p>
        {:else if pwa.checking}
          <p>{t('pwa.checking')}</p>
        {:else if pwa.canApply}
          <p>{t('pwa.updateReady')}</p>
        {:else if pwa.checkState === 'current'}
          <p>{t('pwa.current')}</p>
        {:else if pwa.checkState === 'error' && !pwa.error}
          <p class="text-bad">{t('pwa.checkFailed')}</p>
        {:else if pwa.checkState !== 'error' && !pwa.latestVersion}
          <p>{t('pwa.notChecked')}</p>
        {/if}
        {#if pwa.latestVersion}<p class="break-words">{t('pwa.releaseAvailable', { version: pwa.latestVersion })}</p>{/if}
        {#if pwa.error}<p class="mt-2 break-words {pwa.checkState === 'available' ? 'text-warning' : 'text-bad'}">{pwa.error}</p>{/if}
      </div>
      {#if pwa.latestVersion && pwa.releaseUrl}
        <a class="mt-3 inline-flex min-h-11 max-w-full items-center rounded-control text-[13px] text-accent-ink underline decoration-accent-ink/40 underline-offset-4 hover:decoration-accent-ink sm:min-h-8" data-testid="pwa-release" href={pwa.releaseUrl} target="_blank" rel="noopener noreferrer">{t('pwa.release')}</a>
        {#if !pwa.hostedScope && !pwa.canApply}<p class="mt-1 text-xs leading-5 text-fg-3">{t('pwa.selfHostedUpdate')}</p>{/if}
      {/if}
      {#if pwa.hostedScope}
        {#if pwa.hostedAvailable}
          <div class="mt-3">
            <Button size="sm" variant="primary" data-testid="pwa-hosted-update" disabled={busy || core.status !== 'ok'} onclick={() => confirmHosted('update')}>{t('pwa.hostedUpdate')}</Button>
          </div>
        {/if}
        {#if pwa.hostedUpdating || pwa.hostedError}
          <p class="mt-2 break-words text-[13px] {pwa.hostedError ? 'text-bad' : 'text-fg-2'}" role="status" data-testid="pwa-hosted-status">{pwa.hostedError ?? t('pwa.hostedUpdating')}</p>
        {/if}
        <div class="mt-4 flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[13px]">{t('pwa.hostedAuto')}</p>
            <p class="mt-1 text-xs leading-5 text-fg-3">{t('pwa.hostedAutoHint')}</p>
          </div>
          <Toggle checked={pwa.hostedAuto} testId="pwa-hosted-auto" label={t('pwa.hostedAuto')} disabled={pwa.hostedUpdating} onchange={enabled => enabled ? confirmHosted('auto') : pwa.setHostedAuto(false)} />
        </div>
      {/if}
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 sm:p-5">
      <div class="min-w-0 flex-1 basis-56">
        <h3 class="text-[13px]">{t('pwa.installation')}</h3>
        <p class="mt-1 text-[13px] leading-5 text-fg-2" data-testid={pwa.installed ? 'pwa-installed' : 'app-install-status'}>
          {t(pwa.installed ? 'pwa.installed' : !pwa.secureContext ? 'pwa.httpsRequired' : pwa.canInstall ? 'pwa.installHint' : 'pwa.manualInstall')}
        </p>
      </div>
      {#if pwa.canInstall && !pwa.installed}
        <Button size="sm" data-testid="pwa-install" disabled={pwa.installBusy} onclick={() => pwa.install()}>{t(pwa.installBusy ? 'pwa.installing' : 'pwa.install')}</Button>
      {/if}
    </div>

    <div class="border-t border-line p-4 sm:p-5">
      <h3 class="text-[13px]">{t('pwa.offline')}</h3>
      <p class="mt-1 text-[13px] leading-5 {pwa.offlineReady ? 'text-good' : 'text-fg-2'}" role="status" data-testid="pwa-offline">
        {t(pwa.offlineReady ? 'pwa.offlineReady' : development ? 'pwa.offlineDevelopment' : !pwa.secureContext ? 'pwa.httpsRequired' : !pwa.supported ? 'pwa.offlineUnsupported' : 'pwa.offlinePending')}
      </p>
      <p class="mt-2 text-xs leading-5 text-fg-3">{t('pwa.offlineBoundary')}</p>
    </div>
  </div>
</section>

<Confirm bind:open={confirming}
  title={t(pending?.action === 'auto' ? 'pwa.hostedAuto' : 'pwa.hostedUpdate')}
  description={t(pending?.action === 'auto' ? 'pwa.hostedAutoConfirm' : 'pwa.hostedConfirm', { url: LATEST_DASHBOARD_URL, version: pending?.version ?? '' })}
  action={t(pending?.action === 'auto' ? 'pwa.hostedEnable' : 'pwa.hostedUpdate')}
  onconfirm={applyHosted} />
