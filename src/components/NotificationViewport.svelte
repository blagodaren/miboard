<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { core, router } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import NotificationToast from './NotificationToast.svelte'

  const shell = $derived(router.route !== 'setup' && !['boot', 'setup', 'connecting'].includes(core.status))
  $effect(() => {
    const backend = core.backend.url
    notifications.entries
    untrack(() => notifications.dismissOtherScopes(backend))
  })
  onMount(() => {
    const resize = () => notifications.setVisibleLimit(innerHeight < 480 ? 1 : innerHeight < 700 ? 2 : 3)
    const visibility = () => document.hidden ? notifications.pauseAll('document-hidden') : notifications.resumeAll('document-hidden')
    resize()
    visibility()
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility); notifications.resumeAll('document-hidden') }
  })
</script>

<div class="notification-viewport" class:with-navigation={shell} data-testid="notification-viewport" role="region" aria-label={t('notifications.label')}
  style:--notification-count={Math.max(1, notifications.visible.length)}>
  {#each notifications.visible as notice (notice.id)}<NotificationToast {notice} />{/each}
</div>

<style>
  .notification-viewport { --notification-bottom: max(24px, env(safe-area-inset-bottom)); --notification-max-height: min(60dvh, calc((100dvh - var(--notification-bottom) - 32px) / var(--notification-count) - 8px)); position: fixed; right: max(24px, env(safe-area-inset-right)); bottom: var(--notification-bottom); z-index: 30; display: flex; flex-direction: column; gap: 8px; width: min(420px, calc(100vw - 32px)); max-height: calc(100dvh - var(--notification-bottom) - 16px); pointer-events: none; }
  @media (max-width: 767px) { .notification-viewport { --notification-bottom: calc(16px + env(safe-area-inset-bottom)); right: max(16px, env(safe-area-inset-right)); } .notification-viewport.with-navigation { --notification-bottom: calc(72px + env(safe-area-inset-bottom)); } }
</style>
