<script module lang="ts">
  export type ProxySelectionNoticeData = {
    node: string
    applied: string[]
    unchanged: string[]
    missing: string[]
    unsupported: string[]
    unsafe: string[]
    failed: { group: string; message: string }[]
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { IconCheck, IconClose } from '../lib/icons'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'

  let { notice, onclose }: {
    notice: ProxySelectionNoticeData | null
    onclose: () => void
  } = $props()

  const headingId = $props.id()
  const hasSkipped = $derived(Boolean(notice && (notice.missing.length || notice.unsupported.length || notice.unsafe.length)))
  const LIFETIME = 8000
  let element = $state<HTMLElement>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let remaining = LIFETIME
  let deadline = 0
  let hovered = false
  let focused = false

  function clearTimer() {
    clearTimeout(timer)
    timer = undefined
  }

  function pause() {
    if (timer === undefined) return
    clearTimer()
    remaining = Math.max(0, deadline - Date.now())
  }

  function resume() {
    if (!notice || timer !== undefined || hovered || focused) return
    const current = notice
    deadline = Date.now() + remaining
    timer = setTimeout(() => {
      timer = undefined
      if (notice === current) onclose()
    }, remaining)
  }

  function dismiss() {
    clearTimer()
    onclose()
  }

  $effect(() => {
    const current = notice
    untrack(() => {
      clearTimer()
      remaining = LIFETIME
      hovered = Boolean(current && element?.matches(':hover') && matchMedia('(hover: hover) and (pointer: fine)').matches)
      focused = Boolean(current && element?.contains(document.activeElement))
      if (current) resume()
    })
    return clearTimer
  })
</script>

{#snippet groupList(kind: string, label: MessageKey, groups: string[], tone: 'neutral' | 'warning' = 'neutral')}
  {#if groups.length}
    <section class="notice-section" data-testid="selection-{kind}">
      <h3 class:warning={tone === 'warning'}>{t(label, { count: groups.length })}</h3>
      <ul>{#each groups as group, index (index)}<li>{group}</li>{/each}</ul>
    </section>
  {/if}
{/snippet}

{#if notice}
  <aside
    bind:this={element}
    class="selection-notice"
    data-testid="proxy-selection-notice"
    data-tone={notice.failed.length ? 'error' : hasSkipped ? 'warning' : 'success'}
    role={notice.failed.length ? 'alert' : 'status'}
    aria-labelledby={headingId}
    aria-atomic="true"
    onpointerenter={(event) => { if (event.pointerType !== 'touch') { hovered = true; pause() } }}
    onpointerleave={() => { hovered = false; resume() }}
    onfocusin={() => { focused = true; pause() }}
    onfocusout={(event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      focused = false
      resume()
    }}
  >
    <div class="notice-heading">
      <div class="notice-summary">
        <span class="summary-icon" class:warning={hasSkipped} class:failed={notice.failed.length > 0} aria-hidden="true">{#if hasSkipped || notice.failed.length}<CircleAlert strokeWidth={1.5} />{:else}<IconCheck strokeWidth={1.5} />{/if}</span>
        <h2 id={headingId}>{t('proxies.selectionNoticeTitle', { node: notice.node, count: notice.applied.length })}</h2>
      </div>
      <button type="button" class="notice-close" onclick={dismiss} aria-label={t('proxies.selectionNoticeClose')} title={t('proxies.selectionNoticeClose')}>
        <IconClose aria-hidden="true" strokeWidth={1.5} />
      </button>
    </div>
    <div class="notice-body">
      {#if notice.failed.length}
        <section class="notice-section" data-testid="selection-failed">
          <h3 class="failed">{t('proxies.selectionFailed', { count: notice.failed.length })}</h3>
          <ul>
            {#each notice.failed as failure, index (index)}
              <li><span class="failed-group">{failure.group}</span><span class="failure-message">{failure.message}</span></li>
            {/each}
          </ul>
        </section>
      {/if}
      {@render groupList('missing', 'proxies.selectionMissing', notice.missing, 'warning')}
      {@render groupList('unsupported', 'proxies.selectionUnsupported', notice.unsupported, 'warning')}
      {@render groupList('unsafe', 'proxies.selectionUnsafe', notice.unsafe, 'warning')}
      {@render groupList('applied', 'proxies.selectionApplied', notice.applied)}
      {@render groupList('already', 'proxies.selectionAlready', notice.unchanged)}
    </div>
  </aside>
{/if}

<style>
  .selection-notice { position: fixed; top: 24px; right: 24px; z-index: 30; display: flex; flex-direction: column; width: min(420px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); color: var(--text); box-shadow: var(--shadow-float); }
  .notice-heading { display: flex; flex: none; align-items: flex-start; gap: 8px; padding: 12px 12px 12px 20px; }
  .notice-summary { display: flex; min-width: 0; flex: 1; align-items: flex-start; gap: 8px; padding-top: 12px; }
  .summary-icon { display: inline-flex; flex: none; width: 18px; height: 20px; align-items: center; color: var(--text-2); }
  .summary-icon :global(svg) { width: 18px; height: 18px; }
  h2 { min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 500; line-height: 20px; }
  .notice-close { display: flex; width: 44px; height: 44px; flex: none; align-items: center; justify-content: center; border-radius: var(--radius-control); color: var(--text-2); cursor: pointer; transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out); }
  .notice-close:hover { background: var(--hover); color: var(--text); }
  .notice-close :global(svg) { width: 16px; height: 16px; }
  .notice-body { min-height: 0; max-height: 50dvh; overflow: auto; overscroll-behavior: contain; padding: 0 20px; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
  .notice-section { padding: 12px 0; border-top: 1px solid var(--line); }
  h3 { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--text-2); }
  ul { display: grid; gap: 4px; margin-top: 8px; }
  li { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; color: var(--text-2); }
  .failed-group { display: block; font-weight: 500; }
  .failure-message { display: block; font-size: 12px; line-height: 18px; color: var(--text-3); }
  .warning { color: var(--warning); }
  .failed { color: var(--bad); }
  @media (max-width: 767px) { .selection-notice { top: 72px; right: 16px; max-height: calc(100dvh - 160px); } .notice-heading { padding-left: 16px; } .notice-body { padding-right: 16px; padding-left: 16px; } }
  @media (prefers-reduced-motion: reduce) { .selection-notice, .notice-close { transition: none; } }
</style>
