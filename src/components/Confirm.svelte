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
      class="enter fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2
        rounded-panel border border-line bg-card p-6 shadow-[var(--shadow-float)]"
    >
      <AlertDialog.Title class="text-base font-medium">{title}</AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-fg-2">{description}</AlertDialog.Description>
      <div class="mt-6 flex justify-end gap-2">
        <AlertDialog.Cancel
          class={buttonClass()}>{t('common.cancel')}</AlertDialog.Cancel
        >
        <AlertDialog.Action
          onclick={() => {
            onconfirm()
            open = false
          }}
          class={buttonClass({ variant: 'danger' })}
          >{action}</AlertDialog.Action
        >
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
