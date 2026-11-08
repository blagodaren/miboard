<script lang="ts" generics="T extends string">
  import { ToggleGroup } from 'bits-ui'

  type Props = {
    value: T
    options: { value: T; label: string }[]
    onchange: (v: T) => void
    label: string
    full?: boolean
  }
  let { value, options, onchange, label, full = false }: Props = $props()
</script>

<ToggleGroup.Root
  type="single"
  {value}
  onValueChange={(v) => v && onchange(v as T)}
  aria-label={label}
  class="inline-flex h-8 items-center gap-0.5 rounded-lg border border-field-border bg-raised p-0.5 {full ? 'w-full' : ''}"
>
  {#each options as o (o.value)}
    <ToggleGroup.Item
      value={o.value}
      class="h-full flex-1 whitespace-nowrap rounded-md border border-transparent {full ? 'px-1.5 text-xs' : 'px-3 text-[13px]'} text-fg-2 transition-colors duration-150 hover:bg-hover hover:text-fg
        data-[state=on]:border-selected-border data-[state=on]:bg-selected data-[state=on]:font-medium data-[state=on]:text-selected-text data-[state=on]:shadow-[var(--highlight)]"
    >
      {o.label}
    </ToggleGroup.Item>
  {/each}
</ToggleGroup.Root>
