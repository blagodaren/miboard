<script lang="ts">
  let { label, done, total, indeterminate = false }: {
    label: string
    done: number
    total: number
    indeterminate?: boolean
  } = $props()
</script>

<progress class="latency-progress" aria-label={label} max={Math.max(1, total)} value={indeterminate ? undefined : Math.max(0, Math.min(done, total))}></progress>

<style>
  .latency-progress { display: block; width: 100%; height: 4px; overflow: hidden; border: 0; border-radius: 2px; background: var(--line); accent-color: var(--accent); }
  .latency-progress::-webkit-progress-bar { background: var(--line); border-radius: 2px; }
  .latency-progress::-webkit-progress-value { background: var(--accent); border-radius: 2px; }
  .latency-progress::-moz-progress-bar { background: var(--accent); border-radius: 2px; }
  .latency-progress:indeterminate { background: linear-gradient(90deg, var(--line) 0 35%, var(--accent) 45% 55%, var(--line) 65%); background-size: 250% 100%; animation: waiting 1.4s ease-in-out infinite alternate; }
  .latency-progress:indeterminate::-webkit-progress-bar { background: transparent; }
  @keyframes waiting { from { background-position: 100% 0; } to { background-position: 0 0; } }
  @media (prefers-reduced-motion: reduce) { .latency-progress:indeterminate { animation: none; background-position: 50% 0; } }
</style>
