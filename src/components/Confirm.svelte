<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { t } from '../lib/i18n.svelte'
  import { buttonClass } from '../lib/ui'

  type Props = {
    open: boolean
    title: string
    description: string
    action: string
    onconfirm: () => void
  }
  let { open = $bindable(), title, description, action, onconfirm }: Props = $props()
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-40 bg-scrim" />
    <AlertDialog.Content
      class="enter fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2
        overflow-y-auto overscroll-contain rounded-panel border border-line bg-card p-6 shadow-[var(--shadow-float)]"
    >
      <AlertDialog.Title class="text-base font-medium [overflow-wrap:anywhere]">{title}</AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-fg-2 [overflow-wrap:anywhere]">{description}</AlertDialog.Description>
      <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <AlertDialog.Cancel
          class={buttonClass({ class: '!h-auto min-h-11 min-w-0 max-w-full !whitespace-normal py-1.5 [overflow-wrap:anywhere] sm:min-h-9' })}>{t('common.cancel')}</AlertDialog.Cancel
        >
        <AlertDialog.Action
          onclick={() => {
            onconfirm()
            open = false
          }}
          class={buttonClass({ variant: 'danger', class: '!h-auto min-h-11 min-w-0 max-w-full !whitespace-normal py-1.5 [overflow-wrap:anywhere] sm:min-h-9' })}
          >{action}</AlertDialog.Action
        >
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
