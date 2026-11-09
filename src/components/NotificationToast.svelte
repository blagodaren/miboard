<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { notificationText as text, type Notification } from '../lib/notifications'
  import { t } from '../lib/i18n.svelte'
  import { IconCheck, IconClose } from '../lib/icons'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import Info from '@lucide/svelte/icons/info'

  let { notice }: { notice: Notification } = $props()
  let element: HTMLElement
  let previousFocus: HTMLElement | null = null
  const headingId = $props.id()
  const heading = $derived(text(notice.title))
  const message = $derived(text(notice.message))
  const closeLabel = $derived(text(notice.closeLabel) || t('notifications.close'))

  // A replacement keeps an existing hover/focus pause; a new card under the pointer also pauses.
  $effect(() => {
    notice.revision
    untrack(() => {
      void tick().then(() => {
        if (!element?.isConnected) return
        if (matchMedia('(hover: hover) and (pointer: fine)').matches && element.matches(':hover')) notifications.pause(notice.id, 'pointer')
        if (element.contains(document.activeElement)) notifications.pause(notice.id, 'focus')
      })
    })
  })
  function dismiss() {
    const restore = element?.contains(document.activeElement) && previousFocus?.isConnected
    notifications.dismiss(notice.id)
    if (restore) previousFocus?.focus({ preventScroll: true })
  }
</script>

<aside bind:this={element} class="notification-toast" class:has-details={!!notice.sections?.length} data-toast-id={notice.id} data-testid={notice.testId ?? 'notification-toast'} data-tone={notice.tone}
  role={notice.tone === 'error' ? 'alert' : 'status'} aria-atomic="true" aria-labelledby={heading ? headingId : undefined}
  onpointerenter={(event) => { if (event.pointerType !== 'touch') notifications.pause(notice.id, 'pointer') }}
  onpointerleave={() => notifications.resume(notice.id, 'pointer')}
  onfocusin={(event) => {
    if (event.relatedTarget instanceof HTMLElement && !element.contains(event.relatedTarget)) previousFocus = event.relatedTarget
    notifications.pause(notice.id, 'focus')
  }}
  onfocusout={(event) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) notifications.resume(notice.id, 'focus')
  }}
  onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); dismiss() } }}
>
  <div class="notification-heading">
    <span class="notification-icon" aria-hidden="true">{#if notice.tone === 'success'}<IconCheck strokeWidth={1.5} />{:else if notice.tone === 'info'}<Info strokeWidth={1.5} />{:else}<CircleAlert strokeWidth={1.5} />{/if}</span>
    <div class="notification-summary">
      {#if heading}<h2 id={headingId}>{heading}</h2>{/if}
      {#if message}<p>{message}</p>{/if}
      {#if notice.action}<a class="notification-action" href={notice.action.href}>{text(notice.action.label)}</a>{/if}
    </div>
    <button class="notification-close" type="button" onclick={dismiss} aria-label={closeLabel} title={closeLabel}><IconClose aria-hidden="true" strokeWidth={1.5} /></button>
  </div>
  {#if notice.sections?.length}
    <div class="notification-details">
      {#each notice.sections as section, index (section.id ?? index)}
        {#if section.items.length}<section data-testid={section.id} data-tone={section.tone ?? 'neutral'}>
          <h3>{text(section.title)}</h3>
          <ul>{#each section.items as item, index (index)}<li>{text(item.label)}{#if item.description}<span>{text(item.description)}</span>{/if}</li>{/each}</ul>
        </section>{/if}
      {/each}
    </div>
  {/if}
</aside>

<style>
  .notification-toast { pointer-events: auto; display: flex; flex-direction: column; flex: none; min-height: 64px; max-height: var(--notification-max-height); overflow: hidden; border: 1px solid var(--line-strong); border-radius: var(--radius-panel); background: var(--notification-surface); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); color: var(--text); box-shadow: var(--shadow-float); animation: notification-enter 140ms var(--ease-out); }
  .notification-heading { display: flex; flex: none; align-items: flex-start; gap: 10px; padding: 10px 10px 10px 16px; }
  .notification-icon { display: inline-flex; flex: none; width: 18px; height: 20px; margin-top: 12px; color: var(--text-2); }
  .notification-icon :global(svg) { width: 18px; height: 18px; }
  [data-tone='success'] > .notification-heading > .notification-icon { color: var(--good); }
  [data-tone='error'] > .notification-heading > .notification-icon, section[data-tone='error'] h3 { color: var(--bad); }
  [data-tone='warning'] > .notification-heading > .notification-icon, section[data-tone='warning'] h3 { color: var(--warning); }
  .notification-summary { min-width: 0; flex: 1; max-height: min(36dvh, 200px, calc(var(--notification-max-height) - 24px)); overflow: auto; padding-block: 12px; overflow-wrap: anywhere; }
  .has-details .notification-summary { max-height: min(32dvh, 160px, max(64px, calc(var(--notification-max-height) - 100px))); }
  h2 { font-size: 14px; font-weight: 500; line-height: 20px; }
  p { font-size: 13px; line-height: 20px; color: var(--text-2); }
  h2 + p { margin-top: 6px; }
  .notification-action { display: inline-flex; align-items: center; min-height: 44px; margin-top: 4px; font-size: 13px; font-weight: 500; color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
  .notification-close { display: flex; flex: none; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--radius-control); color: var(--text-2); cursor: pointer; transition: background-color 150ms var(--ease-out); }
  .notification-close:hover { background: var(--hover); color: var(--text); }
  .notification-close :global(svg) { width: 16px; height: 16px; }
  .notification-details { min-height: 0; overflow: auto; overscroll-behavior: contain; padding-inline: 16px; scrollbar-width: thin; }
  section { padding-block: 12px; border-top: 1px solid var(--line); }
  h3 { font-size: 12px; font-weight: 500; line-height: 18px; color: var(--text-2); }
  ul { display: grid; gap: 6px; margin-top: 8px; }
  li { overflow-wrap: anywhere; font-size: 13px; line-height: 20px; color: var(--text-2); }
  li span { display: block; font-size: 12px; line-height: 18px; }
  @keyframes notification-enter { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .notification-toast { animation: none; } .notification-close { transition: none; } }
  @media (prefers-reduced-transparency: reduce) { .notification-toast { background: var(--card); backdrop-filter: none; } }
</style>
