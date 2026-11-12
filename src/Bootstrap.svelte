<script lang="ts">
  import { onMount } from 'svelte'
  import Root from './Root.svelte'
  import { i18n } from './lib/i18n.svelte'
  import Button from './components/Button.svelte'

  let ready = $state(false)
  let failed = $state(false)
  // These few messages must work even when a dictionary cannot be downloaded.
  const text = $derived(i18n.locale === 'ru'
    ? { loading: 'Загрузка языка…', title: 'Не удалось загрузить язык', hint: 'Проверьте подключение и перезагрузите панель.', reload: 'Перезагрузить панель' }
    : { loading: 'Loading language…', title: 'Could not load language', hint: 'Check your connection and reload the app.', reload: 'Reload app' })

  onMount(() => {
    void i18n.initialize().then(() => { ready = true }).catch(() => { failed = true })
  })
</script>

{#if ready}
  <Root />
{:else if failed}
  <section class="mx-auto my-6 max-w-xl rounded-panel border border-line bg-card p-6 sm:p-8" data-testid="locale-recovery">
    <div role="alert">
      <h1 class="text-xl font-semibold text-fg">{text.title}</h1>
      <p class="mt-3 text-sm leading-relaxed text-fg-2">{text.hint}</p>
    </div>
    <div class="mt-6"><Button variant="primary" onclick={() => location.reload()}>{text.reload}</Button></div>
  </section>
{:else}
  <div class="flex min-h-dvh items-center justify-center bg-page text-sm text-fg-2" role="status" aria-busy="true">{text.loading}</div>
{/if}
