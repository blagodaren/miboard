<script lang="ts">
  import type { Snippet } from 'svelte'

  let { title, meta, actions }: { title: string; meta?: string; actions?: Snippet } = $props()
</script>

<header class="flex flex-wrap items-end justify-between gap-4 pb-6">
  <div class="min-w-0">
    <h1 class="text-[28px] font-normal leading-[1.15] tracking-[-0.01em]">{title}</h1>
    {#if meta}<p class="mt-2 font-mono text-xs text-fg-3 [overflow-wrap:anywhere]">{meta}</p>{/if}
  </div>
  {#if actions}<div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">{@render actions()}</div>{/if}
</header>
