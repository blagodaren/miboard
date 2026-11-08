import type { ClassValue } from 'svelte/elements'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium select-none ' +
  'transition-[background-color,color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.97] ' +
  'disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 ' +
  'aria-pressed:border-selected-border aria-pressed:bg-selected aria-pressed:text-selected-text'

const sizes = {
  sm: 'h-11 px-3 text-[13px] sm:h-8',
  md: 'h-11 px-4 text-sm sm:h-9',
}

const variants = {
  primary: 'border-transparent bg-btn text-on-btn hover:opacity-90 shadow-[var(--highlight)]',
  secondary: 'border-field-border bg-field text-fg hover:border-fg-3 hover:bg-hover shadow-[var(--highlight)]',
  ghost: 'border-transparent text-fg-2 hover:text-fg hover:bg-hover',
  danger: 'border-transparent bg-bad-fill text-on-bad hover:opacity-90',
}

/** The same action template is used by buttons and the dialog primitives. */
export function buttonClass({ variant = 'secondary', size = 'md', class: extra = '' }: {
  variant?: ButtonVariant
  size?: ButtonSize
  class?: ClassValue | null
} = {}): ClassValue {
  return [base, sizes[size], variants[variant], extra]
}
