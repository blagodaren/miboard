<script lang="ts">
  import { Switch } from 'bits-ui'

  type Props = { checked: boolean; onchange: (v: boolean) => void; label: string; disabled?: boolean }
  let { checked, onchange, label, disabled = false }: Props = $props()
</script>

<Switch.Root
  {checked}
  {disabled}
  onCheckedChange={onchange}
  aria-label={label}
  class="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-field-border bg-hover p-0.5
    transition-colors duration-150 data-[state=checked]:border-accent-ink data-[state=checked]:bg-accent disabled:opacity-50"
>
  <Switch.Thumb
    class="block size-4 rounded-full bg-fg transition-transform duration-150 ease-out
      data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent"
  />
</Switch.Root>
