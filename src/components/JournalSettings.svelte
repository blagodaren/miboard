<script lang="ts">
  import { onDestroy } from 'svelte'
  import { errorMessage } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { connectionJournal, type JournalRetention } from '../lib/connection-journal.svelte'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { notifications } from '../lib/notifications.svelte'
  import { count } from '../lib/format'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'

  let confirmClear = $state(false)
  let confirmDisable = $state(false)
  let capturedBackend = $state('')
  const backend = { ...core.backend }
  let active = true
  let operation = 0
  onDestroy(() => { active = false; operation++ })
  const current = () => active && core.backend.url === backend.url && core.backend.secret === backend.secret && connectionJournal.backendUrl === backend.url
  const ready = $derived(!!connectionJournal.backendUrl && connectionJournal.backendUrl === core.backend.url && !connectionJournal.loading)
  async function persist(message: MessageKey) {
    const run = ++operation
    try {
      await connectionJournal.flush()
      if (!current() || run !== operation) return
      const memory = connectionJournal.storageState === 'memory'
      notifications.show({ id: 'settings:journal', tone: memory ? 'warning' : 'success', scope: backend.url,
        title: () => t('journal.title'), message: () => t(memory ? 'journal.memory' : message) })
    } catch (error) {
      if (current() && run === operation) notifications.show({ id: 'settings:journal', tone: 'error', scope: backend.url,
        title: () => t('journal.title'), message: () => errorMessage(error) })
    }
  }
  function change(value: string) {
    if (!ready || !current()) return
    if (value === 'off' && connectionJournal.entries.length) {
      capturedBackend = connectionJournal.backendUrl
      confirmDisable = true
    } else {
      connectionJournal.setRetention(value as JournalRetention)
      void persist(value === 'off' ? 'journal.recordingDisabled' : 'journal.retentionSaved')
    }
  }
  function clear() {
    capturedBackend = connectionJournal.backendUrl
    confirmClear = true
  }
  function confirmClearJournal() {
    if (!ready || !current() || capturedBackend !== connectionJournal.backendUrl) return
    connectionJournal.clear()
    void persist('journal.cleared')
  }
  function confirmDisableJournal() {
    if (!ready || !current() || capturedBackend !== connectionJournal.backendUrl) return
    connectionJournal.setRetention('off')
    void persist('journal.recordingDisabled')
  }
</script>

<section aria-labelledby="journal-settings-heading">
  <h2 id="journal-settings-heading" class="mb-3 px-1 text-[13px] text-fg-2">{t('journal.title')}</h2>
  <div class="rounded-panel border border-line bg-card">
    <div class="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
      <div class="min-w-0 flex-1 basis-64">
        <label for="journal-retention">{t('journal.retention')}</label>
        <p id="journal-retention-hint" class="mt-1 max-w-2xl text-[13px] leading-5 text-fg-3">{t('journal.retentionHint')}</p>
      </div>
      <select id="journal-retention" value={connectionJournal.retention} disabled={!ready} onchange={(event) => { const next = event.currentTarget.value; event.currentTarget.value = connectionJournal.retention; change(next) }} aria-describedby="journal-retention-hint" class="h-11 w-full rounded-control border border-field-border bg-field px-3 text-[13px] text-fg sm:h-9 sm:w-40">
        <option value="off">{t('journal.off')}</option>
        <option value="1h">{t('journal.1h')}</option>
        <option value="24h">{t('journal.24h')}</option>
        <option value="7d">{t('journal.7d')}</option>
      </select>
    </div>
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 sm:px-5">
      <span class="num text-xs text-fg-3" role="status">{t('journal.records', { count: count(connectionJournal.entries.length) })}</span>
      <Button size="sm" variant="ghost" disabled={!ready || !connectionJournal.entries.length} onclick={clear}>{t('journal.clear')}</Button>
    </div>
    {#if connectionJournal.storageState === 'memory'}<p class="border-t border-line px-4 py-3 text-xs leading-5 text-warning sm:px-5" role="status">{t('journal.memory')}</p>{/if}
  </div>
</section>

<Confirm bind:open={confirmClear} title={t('journal.clearTitle')} description={t('journal.clearDescription', { count: count(connectionJournal.entries.length) })} action={t('journal.clear')} onconfirm={confirmClearJournal} />
<Confirm bind:open={confirmDisable} title={t('journal.disableTitle')} description={t('journal.disableDescription')} action={t('journal.disable')} onconfirm={confirmDisableJournal} />
