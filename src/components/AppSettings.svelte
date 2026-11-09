<script lang="ts">
  import { pwa } from '../lib/pwa.svelte'
  import { t } from '../lib/i18n.svelte'
  import Button from './Button.svelte'

  let { embedded = false }: { embedded?: boolean } = $props()
  const id = $props.id()
  const development = import.meta.env.DEV
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
        <Button size="sm" data-testid="pwa-check" disabled={pwa.checking || pwa.applying} onclick={() => pwa.checkForUpdates(true)}>{t(pwa.checking ? 'pwa.checking' : 'pwa.check')}</Button>
        {#if pwa.updateReady}
          <Button size="sm" variant="primary" data-testid="pwa-apply" disabled={pwa.checking || pwa.applying} onclick={() => pwa.applyUpdate()}>{t(pwa.applying ? 'pwa.applying' : 'pwa.update')}</Button>
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
        {:else if pwa.updateReady}
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
        {#if !pwa.updateReady}<p class="mt-1 text-xs leading-5 text-fg-3">{t('pwa.selfHostedUpdate')}</p>{/if}
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
