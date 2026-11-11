<script lang="ts">
  import { onMount } from 'svelte'
  import App from './App.svelte'
  import ErrorBoundary from './components/ErrorBoundary.svelte'
  import { t } from './lib/i18n.svelte'
  import { notifications } from './lib/notifications.svelte'

  // Boundaries handle rendering/effects; async actions need a separate notice.
  // Never expose the raw rejection: it can contain controller URLs or secrets.
  onMount(() => {
    const rejected = (event: PromiseRejectionEvent) => {
      if (event.reason && typeof event.reason === 'object' && event.reason.name === 'AbortError') return
      notifications.show({ id: 'unexpected-error', tone: 'error', testId: 'unexpected-error', message: () => t('error.unexpected') })
    }
    window.addEventListener('unhandledrejection', rejected)
    return () => window.removeEventListener('unhandledrejection', rejected)
  })
</script>

<ErrorBoundary><App /></ErrorBoundary>
