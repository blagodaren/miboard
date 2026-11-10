<script lang="ts">
  import { onDestroy } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { bytes } from '../lib/format'
  import { CoreProfileError, coreProfileFilename, fetchCoreProfile, type CoreProfile, type ProfileErrorCode } from '../lib/core-profiles'
  import Button from './Button.svelte'

  let busy = $state<CoreProfile | null>(null)
  let error = $state<ProfileErrorCode | null>(null)
  let savedBytes = $state<number | null>(null)
  let pending: AbortController | undefined
  let active = true
  const urls = new Set<string>()

  $effect(() => {
    const url = core.backend.url, secret = core.backend.secret
    void url; void secret
    pending?.abort()
    busy = null; error = null; savedBytes = null
  })
  onDestroy(() => {
    active = false; pending?.abort()
    for (const url of urls) URL.revokeObjectURL(url)
    urls.clear()
  })

  async function download(kind: CoreProfile) {
    if (busy) return
    const backend = { ...core.backend }
    const controller = new AbortController()
    pending = controller
    busy = kind; error = null; savedBytes = null
    const current = () => active && !controller.signal.aborted && core.backend.url === backend.url && core.backend.secret === backend.secret
    try {
      const blob = await fetchCoreProfile(backend, kind, controller.signal)
      if (!current()) return
      const url = URL.createObjectURL(blob)
      urls.add(url)
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = coreProfileFilename(kind)
      document.body.append(anchor); anchor.click(); anchor.remove()
      setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 1000)
      savedBytes = blob.size
    } catch (cause) {
      if (current()) error = cause instanceof CoreProfileError ? cause.code : 'network'
    } finally {
      if (pending === controller) { pending = undefined; if (active) busy = null }
    }
  }
</script>

<details class="rounded-panel border border-line bg-card px-4 sm:px-5" data-testid="core-profiles">
  <summary class="min-h-11 cursor-pointer py-3 text-[13px] text-fg-2">{t('coreProfiles.title')}</summary>
  <div class="pb-4" aria-busy={busy !== null}>
    <p class="text-xs leading-relaxed text-fg-3">{t('coreProfiles.hint')}</p>
    <div class="mt-4 flex flex-wrap gap-2">
      <Button class="min-h-11" disabled={busy !== null} onclick={() => download('heap')} data-testid="core-profile-heap">{t(busy === 'heap' ? 'coreProfiles.busy' : 'coreProfiles.heap')}</Button>
      <Button class="min-h-11" disabled={busy !== null} onclick={() => download('allocs')} data-testid="core-profile-allocs">{t(busy === 'allocs' ? 'coreProfiles.busy' : 'coreProfiles.allocs')}</Button>
    </div>
    {#if error}<p class="mt-3 text-[13px] text-bad" role="alert">{t(`coreProfiles.${error}`)}</p>{/if}
    {#if savedBytes !== null}<p class="mt-3 text-[13px] text-fg-2" role="status">{t('coreProfiles.saved', { size: bytes(savedBytes) })}</p>{/if}
  </div>
</details>
