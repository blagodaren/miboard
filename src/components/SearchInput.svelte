<script lang="ts">
  import { IconSearch } from '../lib/icons'
  import { t } from '../lib/i18n.svelte'

  let { value = $bindable(''), placeholder }: { value: string; placeholder?: string } = $props()
</script>

<label class="relative flex h-8 w-full items-center sm:w-64">
  <IconSearch class="pointer-events-none absolute left-2.5 size-4 text-fg-3" strokeWidth={1.5} />
  <input
    bind:value
    placeholder={placeholder ?? t('common.search')}
    aria-label={placeholder ?? t('common.search')}
    type="search"
    class="h-full w-full rounded-lg border border-field-border bg-field pl-8 pr-3 text-[13px] text-fg placeholder:text-fg-3
      transition-colors hover:border-fg-3 focus:border-accent-ink"
  />
</label>
