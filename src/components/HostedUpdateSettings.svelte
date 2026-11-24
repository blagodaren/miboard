<script lang="ts">
  import { LATEST_DASHBOARD_URL } from '../lib/app-version'
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { pwa } from '../lib/pwa.svelte'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'
  import Toggle from './Toggle.svelte'

  let { busy }: { busy: boolean } = $props()
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

<Confirm bind:open={confirming}
  title={t(pending?.action === 'auto' ? 'pwa.hostedAuto' : 'pwa.hostedUpdate')}
  description={t(pending?.action === 'auto' ? 'pwa.hostedAutoConfirm' : 'pwa.hostedConfirm', { url: LATEST_DASHBOARD_URL, version: pending?.version ?? '' })}
  action={t(pending?.action === 'auto' ? 'pwa.hostedEnable' : 'pwa.hostedUpdate')}
  onconfirm={applyHosted} />
