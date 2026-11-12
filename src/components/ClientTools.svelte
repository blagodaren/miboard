<script lang="ts">
  import type { Backend } from '../lib/api'
  import BrowserAlertMonitor from './BrowserAlertMonitor.svelte'
  import KeyboardShortcuts from './KeyboardShortcuts.svelte'
  import ProviderAlerts from './ProviderAlerts.svelte'
  let { backend }: { backend: Backend } = $props()
</script>
<BrowserAlertMonitor {backend} />
<ProviderAlerts {backend} />
<KeyboardShortcuts />
