<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ApiError, request, errorMessage, type Backend, type Proxy } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { applyScene, captureScene, parseScenes, planScene, pushScenes, readScenes, saveScenes, sceneDocument, sceneFingerprint, sceneLocalKey, SceneError, SCENES_LIMIT, SCENES_STORAGE_KEY, type SceneDocument, type ProxyScene, type ScenePlanRow, type SceneApplyResult } from '../lib/proxy-scenes'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'

  let { backend, disabled = false, onrunning, oncomplete }: { backend: Backend; disabled?: boolean; onrunning: (value: boolean) => void; oncomplete: () => void } = $props()
  let document = $state.raw<SceneDocument>(sceneDocument([]))
  let selected = $state('')
  let label = $state('')
  let busy = $state(false)
  let issue = $state('')
  let notice = $state('')
  let localReady = $state(false)
  let deleting = $state(false)
  let deletingId = ''
  let preview = $state.raw<{ scene: ProxyScene; proxies: Record<string, Proxy>; rows: ScenePlanRow[] } | null>(null)
  let results = $state.raw<SceneApplyResult[]>([])
  let sync = $state.raw<{ direction: 'push' | 'pull'; remote: SceneDocument | null; local: SceneDocument } | null>(null)
  let controller: AbortController | null = null
  let alive = true
  const scene = $derived(document.scenes.find(value => value.id === selected))
  const inputClass = 'min-h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px]'
  const current = () => alive && core.backend.url === backend.url && core.backend.secret === backend.secret
  const describe = (error: unknown) => error instanceof SceneError ? t(`scenes.error.${error.code}`)
    : error instanceof ApiError && [404, 405, 501].includes(error.status) ? t('scenes.unsupportedStorage') : errorMessage(error)
  onMount(() => {
    try { document = readScenes(backend.url); selected = document.scenes[0]?.id ?? ''; localReady = true }
    catch { issue = t('scenes.error.storage') }
    const refresh = (event: StorageEvent) => {
      if (event.key !== sceneLocalKey(backend.url) || !current()) return
      try { document = readScenes(backend.url); if (!document.scenes.some(item => item.id === selected)) selected = document.scenes[0]?.id ?? ''; preview = null; sync = null; localReady = true; notice = t('scenes.changed') }
      catch { issue = t('scenes.error.storage'); localReady = false }
    }
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  })
  onDestroy(() => { alive = false; controller?.abort(); onrunning(false) })
  function store(next: SceneDocument) {
    if (!localReady) throw new SceneError('storage')
    if (sceneFingerprint(readScenes(backend.url)) !== sceneFingerprint(document)) throw new SceneError('conflict')
    saveScenes(backend.url, next)
    document = next
    preview = null; sync = null; results = []
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (busy || disabled || !current()) return
    busy = true; onrunning(true); issue = ''; notice = ''
    const abort = new AbortController(); controller = abort
    try { await action(abort.signal) }
    catch (error) { if (current()) issue = abort.signal.aborted ? t('scenes.cancelled') : describe(error) }
    finally { if (alive) { busy = false; onrunning(false) }; if (controller === abort) controller = null }
  }
  const fresh = (signal: AbortSignal) => request<{ proxies: Record<string, Proxy> }>('/proxies', { signal }, backend).then(value => value.proxies)
  const remote = async (signal: AbortSignal) => {
    const value = await request<unknown>(`/storage/${SCENES_STORAGE_KEY}`, { signal }, backend)
    return value === null ? null : parseScenes(value)
  }
  function capture() {
    void run(async signal => {
      if (document.scenes.length >= SCENES_LIMIT) throw new SceneError('limit')
      if (!label.trim() || label.trim().length > 80) throw new SceneError('invalid')
      const proxies = await fresh(signal)
      if (!current()) return
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
      const next = captureScene(label, proxies, id)
      store(parseScenes(sceneDocument([...document.scenes, next])))
      selected = next.id; label = ''; notice = t('scenes.saved')
    })
  }
  function prepare() {
    if (!scene) return
    const chosen = scene
    void run(async signal => {
      const proxies = await fresh(signal)
      if (current()) { preview = { scene: chosen, proxies, rows: planScene(chosen, proxies) }; results = []; sync = null }
    })
  }
  function apply() {
    if (!preview) return
    const chosen = preview
    void run(async signal => {
      const proxies = await fresh(signal)
      if (!current()) return
      const rows = planScene(chosen.scene, proxies)
      if (sceneFingerprint(rows) !== sceneFingerprint(chosen.rows)) {
        preview = { ...chosen, proxies, rows }; notice = t('scenes.changed'); return
      }
      results = await applyScene(chosen.scene, proxies, (entry, signal) => {
        if (!current()) { controller?.abort(); signal.throwIfAborted() }
        return request(`/proxies/${encodeURIComponent(entry.group)}`, { method: entry.mode === 'auto' ? 'DELETE' : 'PUT', ...(entry.mode === 'select' ? { body: { name: entry.node } } : {}), signal }, backend)
      }, signal, value => { if (current()) results = value })
      if (current()) { preview = null; notice = t('scenes.complete', { done: results.filter(row => row.result === 'applied').length, failed: results.filter(row => row.result === 'failed').length, skipped: results.filter(row => row.result === 'skipped' || row.result === 'cancelled').length }); oncomplete() }
    })
  }
  function remove() {
    if (!deletingId || busy || disabled) return
    try { store(sceneDocument(document.scenes.filter(value => value.id !== deletingId))); selected = document.scenes[0]?.id ?? ''; issue = '' }
    catch (error) { issue = describe(error) }
  }
  function exportScenes() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }))
    const link = window.document.createElement('a'); link.href = url; link.download = 'miboard-scenes.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function prepareSync(direction: 'push' | 'pull') {
    void run(async signal => {
      const value = await remote(signal)
      if (!current()) return
      if (direction === 'pull' && value === null) throw new SceneError('missing')
      sync = { direction, remote: value, local: document }; preview = null; results = []
    })
  }
  function applySync() {
    if (!sync) return
    const chosen = sync
    void run(async signal => {
      if (sceneFingerprint(readScenes(backend.url)) !== sceneFingerprint(chosen.local)) throw new SceneError('conflict')
      if (chosen.direction === 'push') await pushScenes(chosen.local, chosen.remote, () => remote(signal), value => {
        if (!current()) throw new DOMException('Aborted', 'AbortError')
        signal.throwIfAborted()
        if (sceneFingerprint(readScenes(backend.url)) !== sceneFingerprint(chosen.local)) throw new SceneError('conflict')
        return request(`/storage/${SCENES_STORAGE_KEY}`, { method: 'PUT', body: value, signal }, backend)
      })
      else {
        const latest = await remote(signal)
        if (sceneFingerprint(latest) !== sceneFingerprint(chosen.remote)) throw new SceneError('conflict')
        if (sceneFingerprint(readScenes(backend.url)) !== sceneFingerprint(chosen.local)) throw new SceneError('conflict')
        if (!current()) return
        store(latest!); selected = document.scenes[0]?.id ?? ''
      }
      if (current()) { sync = null; notice = t('scenes.synced') }
    })
  }
</script>

<details class="mb-4 min-w-0 rounded-panel border border-line bg-card" data-testid="proxy-scenes">
  <summary class="min-h-11 cursor-pointer px-4 py-3 text-[13px] font-medium">{t('scenes.title')} <span class="ml-2 font-mono text-xs text-fg-3">{document.scenes.length}/{SCENES_LIMIT}</span></summary>
  <div class="space-y-4 border-t border-line p-4">
    <p class="text-xs leading-5 text-fg-3">{t('scenes.hint')}</p>
    <form class="flex flex-wrap items-end gap-2" onsubmit={event => { event.preventDefault(); capture() }}>
      <label class="min-w-0 flex-1 basis-48 text-xs text-fg-2">{t('scenes.name')}<input class={inputClass + ' mt-1'} bind:value={label} maxlength="80" required disabled={busy || disabled || !localReady} data-testid="scene-name" /></label>
      <Button type="submit" size="sm" disabled={busy || disabled || !localReady || document.scenes.length >= SCENES_LIMIT}>{t('scenes.capture')}</Button>
    </form>
    <label class="block text-xs text-fg-2">{t('scenes.choose')}<select class={inputClass + ' mt-1'} bind:value={selected} disabled={busy || !document.scenes.length} onchange={() => { preview = null; results = []; notice = '' }} data-testid="scene-select">{#if !document.scenes.length}<option value="">{t('scenes.empty')}</option>{/if}{#each document.scenes as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select></label>
    <div class="flex flex-wrap gap-2">
      <Button size="sm" onclick={prepare} disabled={busy || disabled || !scene}>{t('scenes.preview')}</Button>
      <Button size="sm" variant="ghost" onclick={() => { deletingId = selected; deleting = true }} disabled={busy || disabled || !scene}>{t('scenes.delete')}</Button>
      <Button size="sm" variant="ghost" onclick={exportScenes} disabled={!document.scenes.length}>{t('scenes.export')}</Button>
      {#if busy}<Button size="sm" onclick={() => controller?.abort()}>{t('scenes.cancel')}</Button><span class="self-center text-xs text-fg-3" role="status">{t('scenes.busy')}</span>{/if}
    </div>
    {#if preview}
      <ul class="max-h-64 space-y-2 overflow-y-auto text-xs" data-testid="scene-preview">{#each preview.rows as row (row.group)}<li class="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-line py-2"><span class="min-w-0 break-words">{row.group} → {row.mode === 'auto' ? t('scenes.auto') : row.node}</span><span class="text-fg-3">{t(`scenes.${row.status}`)}</span></li>{/each}</ul>
      <Button size="sm" onclick={apply} disabled={busy || disabled || !preview.rows.some(row => row.status === 'ready')} data-testid="scene-apply">{t('scenes.apply')}</Button>
    {/if}
    {#if results.length}<ul class="max-h-64 space-y-2 overflow-y-auto text-xs" data-testid="scene-results">{#each results as row (row.group)}<li class="break-words">{row.group}: {t(`scenes.${row.result}`)}{#if row.result === 'skipped'} · {t(`scenes.${row.status}`)}{/if}{#if row.error} · {errorMessage(row.error)}{/if}</li>{/each}</ul>{/if}
    <details class="border-t border-line pt-3"><summary class="min-h-11 cursor-pointer text-[13px]">{t('scenes.sync')}</summary><p class="mb-3 text-xs leading-5 text-fg-3">{t('scenes.syncHint')}</p><div class="flex flex-wrap gap-2"><Button size="sm" disabled={busy || disabled || !localReady} onclick={() => prepareSync('push')}>{t('scenes.push')}</Button><Button size="sm" disabled={busy || disabled || !localReady} onclick={() => prepareSync('pull')}>{t('scenes.pull')}</Button></div>
      {#if sync}<p class="my-3 text-xs" role="status">{t('scenes.syncPreview', { local: sync.local.scenes.length, remote: sync.remote?.scenes.length ?? 0 })}</p><Button size="sm" disabled={busy || disabled} onclick={applySync}>{t(sync.direction === 'push' ? 'scenes.confirmPush' : 'scenes.confirmPull')}</Button>{/if}
    </details>
    {#if issue}<p class="break-words text-xs text-bad" role="alert">{issue}</p>{/if}
    {#if notice}<p class="text-xs text-fg-2" role="status">{notice}</p>{/if}
  </div>
</details>
<Confirm bind:open={deleting} title={t('scenes.delete')} description={t('scenes.deleteHint')} action={t('scenes.delete')} onconfirm={remove} />
