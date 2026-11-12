<script lang="ts">
  import { tick } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { delaySettings } from '../lib/latency.svelte'
  import { DEFAULT_DELAY_SETTINGS, type DelaySettings as Preferences } from '../lib/latency'
  import Button from './Button.svelte'
  import Segmented from './Segmented.svelte'
  import Toggle from './Toggle.svelte'

  type Field = 'url' | 'timeout' | 'yellow' | 'red'
  let url = $state(delaySettings.value.url)
  let timeout = $state<number | undefined>(delaySettings.value.timeout)
  let yellow = $state<number | undefined>(delaySettings.value.yellow)
  let red = $state<number | undefined>(delaySettings.value.red)
  let touched = $state<Partial<Record<Field, boolean>>>({})
  let formError = $state(false)

  const modes: { value: Preferences['mode']; label: string }[] = $derived([
    { value: 'core', label: t('latency.core') },
    { value: 'panel', label: t('latency.panel') },
  ])
  const unified = $derived(core.configs?.['unified-delay'])
  const unifiedHint = $derived(t(unified === true ? 'latency.unifiedEnabled' : unified === false ? 'latency.unifiedDisabled' : 'latency.unifiedUnknown'))
  const inputClass = 'h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px] text-fg transition-colors hover:border-fg-3 aria-invalid:border-bad focus-visible:border-accent-ink sm:h-10'

  function validNumber(value: number | undefined, max: number) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max
  }

  const errors = $derived.by(() => {
    const errors: Partial<Record<Field, string>> = {}
    try {
      const value = url.trim()
      const parsed = new URL(value)
      if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) errors.url = t('latency.errorUrl')
    } catch {
      errors.url = t('latency.errorUrl')
    }
    if (!validNumber(timeout, 32767)) errors.timeout = t('latency.errorTimeout')
    if (!validNumber(yellow, 60000)) errors.yellow = t('latency.errorThreshold')
    if (!validNumber(red, 60000)) errors.red = t('latency.errorThreshold')
    if (!errors.yellow && !errors.red && red! <= yellow!) errors.red = t('latency.errorThresholdOrder')
    return errors
  })

  function edit() {
    formError = false
  }

  function notify(message: MessageKey) {
    notifications.show({ id: 'settings:latency', tone: 'success', title: () => t('latency.settings'), message: () => t(message) })
  }

  function changeMode(mode: Preferences['mode']) {
    const accepted = delaySettings.set({ ...delaySettings.value, mode })
    formError = !accepted
    if (accepted) notify('latency.modeSaved')
  }

  function changeOption(field: 'ipv6' | 'independent', value: boolean) {
    const accepted = delaySettings.set({ ...delaySettings.value, [field]: value })
    formError = !accepted
    if (accepted) notify(field === 'ipv6' ? 'latency.ipv6Saved' : 'latency.independentSaved')
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    touched = { url: true, timeout: true, yellow: true, red: true }
    const form = event.currentTarget as HTMLFormElement
    if (Object.keys(errors).length) {
      await tick()
      form.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus()
      return
    }
    const accepted = delaySettings.set({ ...delaySettings.value, url: url.trim(), timeout: timeout!, yellow: yellow!, red: red! })
    formError = !accepted
    if (accepted) {
      url = delaySettings.value.url
      notify('latency.saved')
    }
  }

  function reset() {
    delaySettings.reset()
    url = DEFAULT_DELAY_SETTINGS.url
    timeout = DEFAULT_DELAY_SETTINGS.timeout
    yellow = DEFAULT_DELAY_SETTINGS.yellow
    red = DEFAULT_DELAY_SETTINGS.red
    touched = {}
    formError = false
    notify('latency.defaultsRestored')
  }
</script>

<section aria-labelledby="latency-heading">
  <h2 id="latency-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('latency.settings')}</h2>
  <div class="rounded-panel border border-line bg-card">
    <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
      <div class="min-w-0 flex-1 basis-64">
        <div>{t('latency.mode')}</div>
        <p class="mt-0.5 text-[13px] text-fg-3">{t(delaySettings.value.mode === 'core' ? 'latency.coreHint' : 'latency.panelHint')}</p>
      </div>
      <Segmented label={t('latency.mode')} value={delaySettings.value.mode} options={modes} onchange={changeMode} />
    </div>

    <form class="latency-form" onsubmit={save} novalidate>
      <div class="latency-field grid grid-cols-1 items-start gap-x-6 gap-y-2 border-t border-line px-4 py-4 sm:px-5">
        <div class="latency-label min-w-0">
          <label for="latency-url">{t('latency.url')}</label>
          <p id="latency-url-hint" class="mt-0.5 text-[13px] text-fg-3">{t('latency.urlHint')}</p>
        </div>
        <div class="min-w-0">
          <input id="latency-url" class={inputClass} type="url" bind:value={url} placeholder={DEFAULT_DELAY_SETTINGS.url} spellcheck="false" autocomplete="off" aria-invalid={!!(touched.url && errors.url)} aria-describedby="latency-url-hint latency-url-error" oninput={edit} onblur={() => touched.url = true} />
          <p id="latency-url-error" class="mt-1 text-xs text-bad" aria-live="polite">{touched.url ? errors.url ?? '' : ''}</p>
        </div>
      </div>

      <div class="latency-field grid grid-cols-1 items-start gap-x-6 gap-y-2 border-t border-line px-4 py-4 sm:px-5">
        <div class="latency-label min-w-0">
          <label for="latency-timeout">{t('latency.timeout')}</label>
          <p id="latency-timeout-hint" class="mt-0.5 text-[13px] text-fg-3">{t('latency.timeoutHint')}</p>
        </div>
        <div class="latency-control min-w-0">
          <div class="flex items-center gap-3">
            <input id="latency-timeout" class="{inputClass} !w-28 font-mono num" type="number" min="1" max="32767" step="1" bind:value={timeout} aria-invalid={!!(touched.timeout && errors.timeout)} aria-describedby="latency-timeout-hint latency-timeout-unit latency-timeout-error" oninput={edit} onblur={() => touched.timeout = true} />
            <span id="latency-timeout-unit" class="text-[13px] text-fg-3">{t('latency.ms')}</span>
          </div>
          <p id="latency-timeout-error" class="mt-1 text-xs text-bad" aria-live="polite">{touched.timeout ? errors.timeout ?? '' : ''}</p>
        </div>
      </div>

      <div class="latency-field grid grid-cols-1 items-start gap-x-6 gap-y-2 border-t border-line px-4 py-4 sm:px-5">
        <div class="latency-label min-w-0">
          <label for="latency-yellow">{t('latency.yellow')}</label>
          <p id="latency-threshold-hint" class="mt-0.5 text-[13px] text-fg-3">{t('latency.thresholdHint')}</p>
        </div>
        <div class="latency-control min-w-0">
          <div class="flex items-center gap-3">
            <input id="latency-yellow" class="{inputClass} !w-28 font-mono num" type="number" min="1" max="60000" step="1" bind:value={yellow} aria-invalid={!!(touched.yellow && errors.yellow)} aria-describedby="latency-yellow-unit latency-threshold-hint latency-yellow-error" oninput={edit} onblur={() => touched.yellow = true} />
            <span id="latency-yellow-unit" class="text-[13px] text-fg-3">{t('latency.ms')}</span>
          </div>
          <p id="latency-yellow-error" class="mt-1 text-xs text-bad" aria-live="polite">{touched.yellow ? errors.yellow ?? '' : ''}</p>
        </div>
      </div>

      <div class="latency-field grid grid-cols-1 items-start gap-x-6 gap-y-2 border-t border-line px-4 py-4 sm:px-5">
        <label for="latency-red" class="latency-label">{t('latency.red')}</label>
        <div class="latency-control min-w-0">
          <div class="flex items-center gap-3">
            <input id="latency-red" class="{inputClass} !w-28 font-mono num" type="number" min="1" max="60000" step="1" bind:value={red} aria-invalid={!!(touched.red && errors.red)} aria-describedby="latency-red-unit latency-red-error" oninput={edit} onblur={() => touched.red = true} />
            <span id="latency-red-unit" class="text-[13px] text-fg-3">{t('latency.ms')}</span>
          </div>
          <p id="latency-red-error" class="mt-1 text-xs text-bad" aria-live="polite">{touched.red ? errors.red ?? '' : ''}</p>
        </div>
      </div>

      <div class="flex items-start gap-5 border-t border-line px-4 py-4 sm:px-5">
        <div class="min-w-0 flex-1">
          <div>{t('latency.ipv6')}</div>
          <p class="mt-0.5 text-[13px] text-fg-3">{t('latency.ipv6Hint')}</p>
        </div>
        <Toggle label={t('latency.ipv6')} checked={delaySettings.value.ipv6} onchange={(value) => changeOption('ipv6', value)} />
      </div>

      <div class="flex items-start gap-5 border-t border-line px-4 py-4 sm:px-5">
        <div class="min-w-0 flex-1">
          <div>{t('latency.independent')}</div>
          <p class="mt-0.5 text-[13px] text-fg-3">{t('latency.independentHint')}</p>
        </div>
        <Toggle label={t('latency.independent')} checked={delaySettings.value.independent} onchange={(value) => changeOption('independent', value)} />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
        {#if formError}<p class="min-w-0 text-xs text-bad" role="alert">{t('latency.errorSettings')}</p>{/if}
        <div class="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onclick={reset}>{t('latency.reset')}</Button>
          <Button type="submit" size="sm">{t('latency.save')}</Button>
        </div>
      </div>
    </form>

    <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t border-line px-4 py-4 sm:px-5">
      <div class="min-w-0 flex-1 basis-64">
        <div>{t('latency.unified')} <span class="ml-1 font-mono text-xs text-fg-3">unified-delay</span></div>
        <p class="mt-0.5 text-[13px] text-fg-3">{unifiedHint}</p>
      </div>
      <span class="shrink-0 rounded-md bg-raised px-2 py-1 text-xs {unified === true ? 'text-good' : 'text-fg-2'}">{t(unified === true ? 'latency.enabled' : unified === false ? 'latency.disabled' : 'latency.unknown')}</span>
    </div>
  </div>
</section>

<style>
  .latency-form { container-type: inline-size; }

  @container (min-width: 640px) {
    .latency-field { grid-template-columns: minmax(0, 1fr) minmax(180px, 350px); }
    .latency-label { padding-top: 8px; }
    .latency-control { justify-self: end; }
  }
</style>
