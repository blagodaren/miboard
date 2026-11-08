<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  type Props = HTMLButtonAttributes & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md'
    children: Snippet
  }
  let { variant = 'secondary', size = 'md', children, class: cls = '', ...rest }: Props = $props()

  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium select-none ' +
    'transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.97] ' +
    'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0'
  const sizes = { sm: 'h-8 px-3 rounded-lg text-[13px]', md: 'h-9 px-4 rounded-[10px] text-sm' }
  const variants = {
    primary: 'bg-btn text-on-btn hover:opacity-90 shadow-[var(--highlight)]',
    secondary: 'bg-field text-fg border border-field-border hover:border-fg-3 hover:bg-hover shadow-[var(--highlight)]',
    ghost: 'text-fg-2 hover:text-fg hover:bg-hover',
    danger: 'bg-bad text-white hover:opacity-90',
  }
</script>

<button class="{base} {sizes[size]} {variants[variant]} {cls}" {...rest}>
  {@render children()}
</button>
