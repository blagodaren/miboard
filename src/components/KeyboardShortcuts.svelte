<script lang="ts">
  import { onMount } from 'svelte'
  import { Dialog } from 'bits-ui'
  import { router, core, type Route } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { buttonClass } from '../lib/ui'
  import { SHORTCUT_ROUTES, shortcutAction } from '../lib/keyboard-shortcuts'
  let open = $state(false)
  onMount(() => {
    const help = () => { open = true }
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || core.status === 'setup' || core.status === 'connecting') return
      const target = event.target instanceof Element ? event.target : null
      const editing = !!target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]')
      const action = shortcutAction(event, editing, !!document.querySelector('[role="dialog"], [role="alertdialog"]'))
      if (!action) return
      if (action === 'search') {
        const input = [...document.querySelectorAll<HTMLInputElement>('main input[type="search"]')].find(element => element.getClientRects().length && !element.disabled)
        if (input) { event.preventDefault(); input.focus(); input.select() }
      } else if (action === 'help') { event.preventDefault(); open = true }
      else { event.preventDefault(); router.go(action as Route) }
    }
    window.addEventListener('keydown', keydown); window.addEventListener('miboard:shortcuts-help', help)
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('miboard:shortcuts-help', help) }
  })
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-scrim" />
    <Dialog.Content class="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel border border-line bg-card p-6">
      <Dialog.Title class="text-base font-medium">{t('panelTools.shortcuts')}</Dialog.Title>
      <Dialog.Description class="my-3 text-[13px] leading-6 text-fg-3">{t('panelTools.shortcutsHint')}</Dialog.Description>
      <dl class="space-y-2 text-sm">
        {#each SHORTCUT_ROUTES as route, index}<div class="flex justify-between gap-4"><dt class="font-mono">Alt+{index + 1}</dt><dd>{t(`nav.${route}`)}</dd></div>{/each}
      </dl>
      <Dialog.Close class={buttonClass({ class: 'mt-5 !h-auto min-h-11 min-w-0 max-w-full !whitespace-normal py-1.5 [overflow-wrap:anywhere] sm:min-h-9' })}>{t('panelTools.shortcutsClose')}</Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
