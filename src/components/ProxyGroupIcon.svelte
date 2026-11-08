<script lang="ts">
  import { IconProxies } from '../lib/icons'
  import { resolveProxyIcon } from '../lib/proxy-icon'

  let { icon, name, backendUrl, size = 20 }: {
    icon?: string
    name: string
    backendUrl: string
    size?: number
  } = $props()

  const source = $derived(resolveProxyIcon(icon, backendUrl))
  const dimension = $derived(Number.isFinite(size) && size > 0 ? size : 20)
  let failed = $state(false)

  $effect(() => {
    source
    failed = false
  })
</script>

<span class="inline-flex shrink-0 items-center justify-center" style:width="{dimension}px" style:height="{dimension}px" aria-hidden="true" data-group-icon={name}>
  {#key source}
    {#if source && !failed}
      <img src={source} alt="" aria-hidden="true" class="block size-full object-contain" width={dimension} height={dimension} loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror={() => (failed = true)} />
    {:else}
      <IconProxies class="size-full text-fg-3" strokeWidth={1.5} />
    {/if}
  {/key}
</span>
