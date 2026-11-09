<script lang="ts">
  import { onDestroy } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { applySettingsImport, exportSettings, MAX_SETTINGS_FILE_BYTES, previewSettingsImport, SettingsTransferError, type SettingsImportPreview } from '../lib/settings-transfer'
  import Button from './Button.svelte'

  let includeSecrets = $state(false)
  let fileInput: HTMLInputElement
  let preview = $state.raw<SettingsImportPreview | null>(null)
  let fileName = $state('')
  let error = $state<MessageKey | null>(null)
  let saved = $state(false)
  let reading = $state(false)
  let selection = 0
  let active = true
  const backend = { ...core.backend }
  const current = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret
  onDestroy(() => { active = false; selection++ })
  const inputId = $props.id()
  const counts: Array<{ key: keyof SettingsImportPreview['counts']; label: MessageKey }> = [
    { key: 'servers', label: 'transfer.servers' }, { key: 'aliases', label: 'transfer.aliases' },
    { key: 'sorts', label: 'transfer.sorts' }, { key: 'preferences', label: 'transfer.preferences' },
    { key: 'secrets', label: 'transfer.secrets' },
  ]

  function errorKey(cause: unknown, exporting = false): MessageKey {
    if (cause instanceof SettingsTransferError) {
      if (cause.code === 'size') return 'transfer.errorSize'
      if (cause.code === 'rollback') return 'transfer.errorRollback'
      if (cause.code === 'invalid') return 'transfer.errorInvalid'
    }
    return exporting ? 'transfer.errorExport' : 'transfer.errorStorage'
  }
  function notifyError(cause: unknown, exporting = false) {
    const key = errorKey(cause, exporting)
    notifications.show({ id: exporting ? 'settings-transfer:export' : 'settings-transfer:import', tone: 'error', scope: backend.url,
      title: () => t('transfer.title'), message: () => t(key) })
  }
  function download() {
    if (!current()) return
    error = null
    try {
      const contents = exportSettings({ includeSecrets })
      const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `miboard-settings-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 0)
      notifications.show({ id: 'settings-transfer:export', tone: 'success', scope: backend.url,
        title: () => t('transfer.title'), message: () => t('transfer.exported') })
    } catch (cause) { notifyError(cause, true) }
  }
  async function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !current()) return
    const id = ++selection
    preview = null
    error = null
    saved = false
    fileName = file.name
    reading = true
    try {
      if (file.size > MAX_SETTINGS_FILE_BYTES) throw new SettingsTransferError('size')
      const contents = await file.text()
      if (id === selection && current()) preview = previewSettingsImport(contents)
    } catch (cause) {
      if (id === selection && current()) {
        if (cause instanceof SettingsTransferError && (cause.code === 'invalid' || cause.code === 'size')) error = errorKey(cause)
        else notifyError(cause)
      }
    }
    finally { if (id === selection && active) reading = false; input.value = '' }
  }
  function apply() {
    if (!preview?.document || preview.invalid || !current()) return
    error = null
    try {
      applySettingsImport(preview)
      preview = null
      saved = true
      notifications.show({ id: 'settings-transfer:import', tone: 'success', scope: backend.url,
        title: () => t('transfer.title'), message: () => t('transfer.imported') })
    } catch (cause) { notifyError(cause) }
  }
</script>

<section aria-labelledby="{inputId}-heading" data-testid="settings-transfer">
  <h2 id="{inputId}-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('transfer.title')}</h2>
  <div class="rounded-panel border border-line bg-card p-4 sm:p-5">
    <p class="text-[13px] text-fg-2">{t('transfer.description')}</p>
    <label class="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-[13px]">
      <input type="checkbox" bind:checked={includeSecrets} class="size-4 shrink-0 accent-[var(--accent)]" aria-describedby="{inputId}-secrets-hint" />
      <span>{t('transfer.includeSecrets')}</span>
    </label>
    {#if includeSecrets}<p id="{inputId}-secrets-hint" class="mt-1 text-xs text-warning">{t('transfer.secretsHint')}</p>{/if}
    <div class="mt-4 flex flex-wrap gap-3">
      <Button size="sm" onclick={download}>{t('transfer.export')}</Button>
      <Button size="sm" disabled={reading} onclick={() => fileInput.click()}>{t('transfer.import')}</Button>
      <input bind:this={fileInput} type="file" accept="application/json,.json" class="sr-only" tabindex="-1" aria-label={t('transfer.import')} aria-describedby="{inputId}-file-hint" onchange={choose} />
    </div>
    <p id="{inputId}-file-hint" class="mt-3 text-xs text-fg-3">{t('transfer.fileHint')}</p>

    {#if preview}
      <div class="mt-5 border-t border-line pt-4" data-testid="transfer-preview">
        <h3 class="text-sm font-medium">{t('transfer.preview')}</h3>
        <p class="mt-1 break-all text-xs text-fg-3">{fileName}</p>
        {#if preview.invalid}
          <p class="mt-3 text-[13px] text-bad" role="alert">{t('transfer.invalid', { count: preview.invalid })}</p>
          <p class="mt-1 break-words font-mono text-xs text-fg-3">{preview.issues.slice(0, 5).join(' · ')}</p>
        {:else}
          <dl class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {#each counts as item}
              <div class="min-w-0"><dt class="text-xs text-fg-3">{t(item.label)}</dt><dd class="mt-1 font-mono num text-sm" data-count={item.key}>{preview.counts[item.key]}</dd></div>
            {/each}
          </dl>
          <p class="mt-4 text-[13px] text-fg-2">{t('transfer.existingServers', { count: preview.existingServers })}</p>
          <p class="mt-1 text-[13px] text-fg-2">{t('transfer.conflicts', { count: preview.conflicts })}</p>
          <p class="mt-2 text-xs text-fg-3">{t('transfer.mergeHint')}</p>
        {/if}
        <div class="mt-4 flex flex-wrap gap-3">
          <Button size="sm" variant="primary" disabled={!!preview.invalid} onclick={apply}>{t('transfer.apply')}</Button>
          <Button size="sm" variant="ghost" onclick={() => { selection++; preview = null; error = null }}>{t('transfer.cancel')}</Button>
        </div>
      </div>
    {/if}
    {#if error}<p class="mt-4 text-[13px] text-bad" role="alert">{t(error)}</p>{/if}
    {#if saved}
      <div class="mt-4 border-t border-line pt-4" data-testid="transfer-saved">
        <p class="text-[13px] text-fg-2">{t('transfer.reloadHint')}</p>
        <Button size="sm" class="mt-3" onclick={() => location.reload()}>{t('transfer.reload')}</Button>
      </div>
    {/if}
  </div>
</section>
