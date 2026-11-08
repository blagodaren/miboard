<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { buttonClass, type ButtonVariant, type ButtonSize } from '../lib/ui'

  type Props = HTMLButtonAttributes & {
    variant?: ButtonVariant
    size?: ButtonSize
    children: Snippet
  }
  let { variant = 'secondary', size = 'md', children, class: cls = '', ...rest }: Props = $props()
</script>

<button class={buttonClass({ variant, size, class: cls })} {...rest}>
  {@render children()}
</button>
