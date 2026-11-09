<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { api, ApiError, errorMessage } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { t, i18n, type MessageKey } from '../lib/i18n.svelte'
  import { SettingsTransferError } from '../lib/settings-transfer'
  import { SETTINGS_SYNC_KEY, applySyncPull, createSyncDocument, parseSyncDocument, previewSync, syncFingerprint, syncPreviewChanged, SettingsSyncError, type SyncChange, type SyncPreview } from '../lib/settings-sync'
  import Button from './Button.svelte'

  const id = $props.id()
  const backend = { ...core.backend }
  let active = true
  let aborter: AbortController | null = null
  let busy = $state<'read' | 'apply' | null>(null)
  let preview = $state.raw<SyncPreview | null>(null)
  let error = $state.raw<unknown>(null)
  let notice = $state<MessageKey | null>(null)
  let loaded = $state(false)
  let previewElement = $state<HTMLDivElement>()
  const current = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret
  const dateFormat = $derived(new Intl.DateTimeFormat(i18n.intlLocale, { dateStyle: 'medium', timeStyle: 'short' }))
  const sections: SyncChange['section'][] = ['devices', 'sorts', 'preferences']
  const latencyLabels: Record<string, MessageKey> = {
    mode: 'latency.mode', url: 'latency.url', timeout: 'latency.timeout', yellow: 'latency.yellow', red: 'latency.red', ipv6: 'latency.ipv6', independent: 'latency.independent',
  }
  const sortLabels: Record<string, MessageKey> = { config: 'proxies.sortConfig', name: 'proxies.sortName', latency: 'proxies.sortLatency', protocol: 'proxies.sortProtocol' }
  onDestroy(() => { active = false; aborter?.abort() })

  function failure(cause: unknown): string {
    if (cause instanceof ApiError && [404, 405, 501].includes(cause.status)) return t('sync.unsupported')
    if (cause instanceof SettingsSyncError) return t(`sync.${cause.code}`)
    if (cause instanceof SettingsTransferError) return t(cause.code === 'rollback' ? 'transfer.errorRollback' : cause.code === 'storage' ? 'transfer.errorStorage' : cause.code === 'size' ? 'sync.size' : 'sync.invalid')
    return errorMessage(cause)
  }
  function changeLabel(change: SyncChange): string {
    if (change.section !== 'preferences') return change.key
    if (change.key === 'theme') return t('sync.theme')
    if (change.key === 'locale') return t('sync.locale')
    if (change.key === 'proxyCardSize') return t('settings.proxyCardSize')
    if (change.key === 'proxyGroupHeight') return t('settings.groupHeight')
    if (change.key === 'proxyTestSelection') return t('proxyTest.title')
    if (change.key === 'liveUpdateMode') return t('liveUpdates.mode')
    if (change.key.startsWith('latency.')) return t('sync.latency', { field: t(latencyLabels[change.key.slice(8)]) })
    if (change.key.startsWith('groups.')) return t('sync.group', { name: change.key.slice(7) })
    return change.key
  }
  function display(value: unknown, change: SyncChange, after = false): string {
    if (value === undefined) return t(after && change.kind === 'remove' ? 'sync.removed' : 'sync.empty')
    if (typeof value === 'boolean') return t(value ? 'coreTools.enabled' : 'coreTools.disabled')
    if (change.section === 'sorts' && typeof value === 'object' && value !== null) {
      const sort = value as { key: string; direction: string }
      const direction = sort.key === 'latency' ? (sort.direction === 'asc' ? 'proxies.sortFastFirst' : 'proxies.sortSlowFirst') : (sort.direction === 'asc' ? 'proxies.sortAscending' : 'proxies.sortDescending')
      return `${t(sortLabels[sort.key])}${sort.key === 'config' ? '' : ' · ' + t(direction)}`
    }
    if (change.key === 'theme' && (value === 'system' || value === 'dark' || value === 'light')) return t(`settings.theme.${value}`)
    if (change.key === 'locale') return value === 'ru' ? 'Русский' : 'English'
    if (change.key === 'proxyCardSize' && (value === 'large' || value === 'compact')) return t(`settings.proxyCards.${value}`)
    if (change.key === 'proxyGroupHeight' && (value === 'large' || value === 'compact' || value === 'full')) return t(`settings.groupHeight.${value}`)
    if (change.key === 'liveUpdateMode' && (value === 'realtime' || value === 'eco')) return t(`liveUpdates.${value}`)
    if (change.key === 'proxyTestSelection' && typeof value === 'object' && value !== null) {
      const selection = value as { mode: string; groups: string[] }
      return selection.mode === 'all' ? t('proxyTest.all') : `${t('proxyTest.selected')}: ${selection.groups.join(', ') || '—'}`
    }
    if (change.key === 'latency.mode' && (value === 'core' || value === 'panel')) return t(`latency.${value}`)
    if (['latency.timeout', 'latency.yellow', 'latency.red'].includes(change.key)) return `${value} ${t('latency.ms')}`
    return String(value)
  }
  async function read(signal: AbortSignal) {
    const value = await api.getStorage(SETTINGS_SYNC_KEY, backend, signal)
    if (!current() || signal.aborted) return undefined
    return parseSyncDocument(value, backend.url)
  }
  async function focusPreview() {
    await tick()
    if (current()) previewElement?.focus({ preventScroll: true })
  }
  async function prepare(direction: 'push' | 'pull') {
    if (busy || !current()) return
    aborter = new AbortController()
    const signal = aborter.signal
    busy = 'read'; error = null; notice = null; preview = null; loaded = false
    try {
      const remote = await read(signal)
      if (remote === undefined) return
      preview = previewSync(direction, remote, backend.url)
      void focusPreview()
    } catch (cause) { if (current() && !signal.aborted) error = cause }
    finally { if (current()) busy = null }
  }
  async function apply() {
    if (!preview || busy || !current()) return
    const chosen = preview
    aborter = new AbortController()
    const signal = aborter.signal
    busy = 'apply'; error = null; notice = null
    try {
      const latest = await read(signal)
      if (latest === undefined) return
      if (syncPreviewChanged(chosen, latest, backend.url)) {
        preview = previewSync(chosen.direction, latest, backend.url)
        notice = 'sync.changed'
        void focusPreview()
        return
      }
      if (chosen.direction === 'pull') {
        applySyncPull(chosen, backend.url)
        preview = null; loaded = true; notice = 'sync.loaded'
      } else {
        const document = createSyncDocument(chosen.local, backend.url)
        await api.putStorage(SETTINGS_SYNC_KEY, document, backend, signal)
        if (!current() || signal.aborted) return
        try {
          const verified = await read(signal)
          if (verified === undefined) return
          if (syncFingerprint(verified) !== syncFingerprint(document)) throw new SettingsSyncError('verify')
        } catch {
          // A PUT may have succeeded even when the following read fails.
          if (current() && !signal.aborted) throw new SettingsSyncError('verify')
          return
        }
        preview = null; notice = 'sync.saved'
      }
    } catch (cause) { if (current() && !signal.aborted) { error = cause; preview = null } }
    finally { if (current()) busy = null }
  }
</script>

<section aria-labelledby="{id}-heading" data-testid="settings-sync">
  <h2 id="{id}-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('sync.title')}</h2>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <p class="text-[13px] leading-relaxed text-fg-2">{t('sync.description')}</p>
    <p class="mt-2 text-xs leading-relaxed text-fg-3">{t('sync.private')}</p>
    <div class="mt-4 flex flex-wrap gap-3">
      <Button size="sm" disabled={!!busy} onclick={() => prepare('push')} data-testid="sync-push">{t('sync.push')}</Button>
      <Button size="sm" disabled={!!busy} onclick={() => prepare('pull')} data-testid="sync-pull">{t('sync.pull')}</Button>
    </div>
    {#if busy}<p class="mt-3 text-[13px] text-fg-3" role="status">{t(busy === 'read' ? 'sync.loading' : 'sync.saving')}</p>{/if}
    {#if error}<p class="mt-4 text-[13px] text-bad" role="alert" data-testid="sync-error">{failure(error)}</p>{/if}
    {#if notice}<p class="mt-4 text-[13px] text-fg-2" role="status" data-testid="sync-notice">{t(notice)}</p>{/if}
    {#if loaded}<Button size="sm" class="mt-3" onclick={() => location.reload()}>{t('transfer.reload')}</Button>{/if}
    {#if preview}
      <div bind:this={previewElement} tabindex="-1" role="region" aria-labelledby="{id}-preview-title" class="sync-preview mt-5 rounded-[var(--radius-card)] border border-line bg-raised p-4" data-testid="sync-preview">
        <h3 id="{id}-preview-title" class="text-sm font-medium">{t(preview.direction === 'push' ? 'sync.pushPreview' : 'sync.pullPreview')}</h3>
        <p class="mt-2 text-xs text-fg-3">{preview.remote ? t('sync.remoteDate', { date: dateFormat.format(new Date(preview.remote.updatedAt)) }) : t('sync.newCopy')}</p>
        <p class="mt-3 text-[13px] text-fg-2">{t(preview.direction === 'push' ? 'sync.pushHint' : 'sync.pullHint')}</p>
        <p class="mt-2 text-xs leading-relaxed text-fg-3">{t('sync.raceHint')}</p>
        <p class="mt-4 text-[13px] font-medium">{t('sync.changes', { count: preview.changes.length })}</p>
        {#if !preview.changes.length}<p class="mt-2 text-[13px] text-fg-3">{t('sync.none')}</p>{/if}
        <div class="sync-diff">
          {#each sections as section}
            {@const rows = preview.changes.filter(change => change.section === section)}
            {#if rows.length}
              <section aria-label={t(`sync.${section}`)} class="mt-4">
                <h4 class="mb-2 text-xs font-medium text-fg-2">{t(`sync.${section}`)} · {rows.length}</h4>
                <dl>
                  {#each rows.slice(0, 60) as change}
                    <div class="diff-row">
                      <dt>{changeLabel(change)}</dt>
                      <dd><span>{t('sync.before')}</span><p>{display(change.before, change)}</p></dd>
                      <dd><span>{t('sync.after')}</span><p>{display(change.after, change, true)}</p></dd>
                    </div>
                  {/each}
                </dl>
                {#if rows.length > 60}<p class="mt-2 text-xs text-fg-3">{t('sync.more', { count: rows.length - 60 })}</p>{/if}
              </section>
            {/if}
          {/each}
        </div>
        <div class="mt-4 flex flex-wrap gap-3">
          <Button size="sm" variant="primary" disabled={!!busy} onclick={apply} data-testid="sync-apply">{t(preview.direction === 'push' ? 'sync.applyPush' : 'sync.applyPull')}</Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onclick={() => { preview = null; notice = null }} data-testid="sync-cancel">{t('transfer.cancel')}</Button>
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .sync-diff { max-height: 420px; overflow-y: auto; scrollbar-gutter: stable; }
  .diff-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); font-size: 12px; }
  .diff-row dt, .diff-row dd { min-width: 0; overflow-wrap: anywhere; }
  .diff-row dt { color: var(--text-2); }
  .diff-row dd > span { color: var(--text-3); }
  .diff-row p { margin-top: 3px; }
  @media (max-width: 520px) { .sync-preview { padding: 12px; } .diff-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .diff-row dt { grid-column: 1 / -1; } }
</style>
