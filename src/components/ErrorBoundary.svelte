<script lang="ts">
  import type { Snippet } from 'svelte'
  import RecoveryPanel from './RecoveryPanel.svelte'

  let { children }: { children: Snippet } = $props()
</script>

<svelte:boundary>
  {@render children()}
  {#snippet failed(_error, reset)}
    <RecoveryPanel retry={reset} />
  {/snippet}
</svelte:boundary>
