<script lang="ts">
  import { onDestroy } from 'svelte'
  import { errorMessage, request, savedBackends, type Mode, type SavedBackend } from '../lib/api'
  import { t, i18n } from '../lib/i18n.svelte'
  import { bytes } from '../lib/format'
  import { embed } from '../lib/embed'
  import { core } from '../lib/core.svelte'
  import { CoreManagementError, applyFleetAction, readCoreSnapshot, runCoreFleet, unsupportedCoreAction, type CoreSnapshot, type FleetAction, type FleetOutcome } from '../lib/core-management'
  import Button from './Button.svelte'
  import Confirm from './Confirm.svelte'

  const id = $props.id()
  let profiles = $state.raw<SavedBackend[]>(savedBackends())
  let selected = $state<string[]>([])
  let snapshots = $state.raw<Record<string, CoreSnapshot>>({})
  let failures = $state.raw<Record<string, unknown>>({})
  let outcomes = $state.raw<Record<string, FleetOutcome<CoreSnapshot>>>({})
  let mode = $state<Mode>('rule')
  let busy = $state<'check' | 'action' | null>(null)
  let done = $state(0)
  let total = $state(0)
  let summary = $state<{ success: number; failed: number; cancelled: number } | null>(null)
  let confirm = $state(false)
  let pending = $state.raw<{ profiles: SavedBackend[]; action: FleetAction } | null>(null)
  let controller: AbortController | null = null
  let active = true
  const targets = $derived(profiles.filter(profile => selected.includes(profile.id)))
  const pendingAction = $derived(pending?.action.kind ?? 'close')
  const pendingDescription = $derived(t(`coreFleet.description.${pendingAction}`, {
    count: pending?.profiles.length ?? 0,
    names: pending?.profiles.map(profile => profile.name || profile.url).join(', ') ?? '',
    mode: t(`mode.${pending?.action.kind === 'mode' ? pending.action.mode : mode}`),
  }))
  const describe = (error: unknown) => error instanceof CoreManagementError ? t(`coreManagement.${error.code}`) : unsupportedCoreAction(error) ? t('coreManagement.unsupported') : errorMessage(error)
  const profileName = (profile: SavedBackend) => profile.name || profile.url
  const timestamp = (time: number) => new Intl.DateTimeFormat(i18n.intlLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)
  onDestroy(() => { active = false; controller?.abort() })

  function choose(profile: SavedBackend, checked: boolean) {
    if (busy) return
    selected = checked ? [...new Set([...selected, profile.id])] : selected.filter(value => value !== profile.id)
  }
  async function check() {
    if (busy) return
    profiles = savedBackends(); selected = selected.filter(value => profiles.some(profile => profile.id === value))
    const queue = profiles.map(profile => ({ ...profile }))
    if (!queue.length) return
    const abort = new AbortController(); controller = abort; busy = 'check'; done = 0; total = queue.length; summary = null
    snapshots = {}; failures = {}; outcomes = {}
    try {
      await runCoreFleet(queue, (profile, signal) => readCoreSnapshot(request, profile, signal), abort.signal, outcome => {
        if (!active || controller !== abort) return
        done++
        if (outcome.status === 'success') snapshots = { ...snapshots, [outcome.profile.id]: outcome.value }
        else if (outcome.status === 'error') failures = { ...failures, [outcome.profile.id]: outcome.error }
      })
    } finally { if (active && controller === abort) { busy = null; controller = null } }
  }
  function prepare(action: FleetAction) {
    if (busy || !targets.length || (action.kind === 'mode' && embed.hideMode)) return
    pending = { profiles: targets.map(profile => ({ ...profile })), action: { ...action } }; confirm = true
  }
  async function apply() {
    if (!pending || busy || (pending.action.kind === 'mode' && embed.hideMode)) return
    const operation = pending
    const abort = new AbortController(); controller = abort; busy = 'action'; done = 0; total = operation.profiles.length; summary = null; outcomes = {}
    try {
      const results = await runCoreFleet(operation.profiles, async (profile, signal) => {
        await applyFleetAction(request, profile, operation.action, signal, { hideMode: embed.hideMode })
        return readCoreSnapshot(request, profile, signal)
      }, abort.signal, outcome => {
        if (!active || controller !== abort) return
        done++; outcomes = { ...outcomes, [outcome.profile.id]: outcome }
        if (outcome.status === 'success') snapshots = { ...snapshots, [outcome.profile.id]: outcome.value }
        if (outcome.profile.url === core.backend.url && outcome.profile.secret === core.backend.secret && !abort.signal.aborted) void core.refreshConfigs()
      })
      if (active && controller === abort) {
        outcomes = Object.fromEntries(results.map(result => [result.profile.id, result]))
        summary = { success: results.filter(result => result.status === 'success').length, failed: results.filter(result => result.status === 'error').length, cancelled: results.filter(result => result.status === 'cancelled').length }
      }
    } finally { if (active && controller === abort) { busy = null; controller = null; pending = null } }
  }
</script>

<section aria-labelledby="{id}-title" data-testid="core-fleet">
  <h2 id="{id}-title" class="mb-3 px-1 text-[13px] text-fg-2">{t('coreFleet.title')}</h2>
  <div class="rounded-panel border border-line bg-card" aria-busy={busy !== null}>
    <div class="space-y-3 px-4 py-4 sm:px-5">
      <p class="text-[13px] leading-5 text-fg-3">{t('coreFleet.hint')}</p>
      <div class="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={busy !== null} onclick={check} data-testid="core-fleet-check">{t('coreFleet.check')}</Button>
        {#if busy}<span class="text-[13px] text-fg-2" role="status">{t(busy === 'check' ? 'coreFleet.checking' : 'coreFleet.applying', { done, total })}</span><Button size="sm" variant="ghost" onclick={() => controller?.abort()}>{t('coreFleet.cancel')}</Button>{/if}
      </div>
    </div>

    {#if profiles.length}
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
        <label class="inline-flex min-h-11 cursor-pointer items-center gap-3 text-[13px]">
          <input type="checkbox" class="size-4 accent-accent-ink" checked={selected.length === profiles.length} disabled={busy !== null} onchange={event => selected = event.currentTarget.checked ? profiles.map(profile => profile.id) : []} data-testid="core-fleet-select-all" />
          {t('coreFleet.selectAll')}
        </label>
        <span class="text-xs text-fg-3">{t('coreFleet.selected', { count: targets.length })}</span>
      </div>

      <div class="divide-y divide-line border-t border-line">
        {#each profiles as profile (profile.id)}
          {@const snapshot = snapshots[profile.id]}
          {@const outcome = outcomes[profile.id]}
          <article class="px-4 py-4 sm:px-5" data-testid="core-fleet-profile" data-profile={profile.id}>
            <div class="flex items-start justify-between gap-3">
              <label class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-3">
                <input type="checkbox" class="mt-1 size-4 shrink-0 accent-accent-ink" checked={selected.includes(profile.id)} disabled={busy !== null} aria-label={t('coreFleet.select', { name: profileName(profile) })} onchange={event => choose(profile, event.currentTarget.checked)} />
                <span class="min-w-0 text-[13px]"><span class="block break-all font-medium">{profileName(profile)}</span>{#if profile.name}<span class="mt-1 block break-all font-mono text-xs text-fg-3">{profile.url}</span>{/if}</span>
              </label>
              <span class="max-w-[40%] text-right text-xs" class:text-good={!!snapshot && snapshot.errors.length === 0} class:text-warning={!!snapshot && snapshot.errors.length > 0 && snapshot.errors.length < 3} class:text-bad={!!failures[profile.id] || snapshot?.errors.length === 3} class:text-fg-3={!snapshot && !failures[profile.id]}>{t(failures[profile.id] || snapshot?.errors.length === 3 ? 'coreFleet.offline' : !snapshot ? 'coreFleet.unchecked' : snapshot.errors.length ? 'coreFleet.partial' : 'coreFleet.online')}</span>
            </div>
            {#if snapshot}
              <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] sm:grid-cols-3">
                <div><p class="text-xs text-fg-3">{t('coreFleet.source.version')}</p><p class="mt-1 break-all font-mono">{snapshot.version ?? '—'}</p></div>
                {#if !embed.hideMode}<div><p class="text-xs text-fg-3">{t('mode.label')}</p><p class="mt-1">{snapshot.mode === 'rule' || snapshot.mode === 'global' || snapshot.mode === 'direct' ? t(`mode.${snapshot.mode}`) : snapshot.mode ?? '—'}</p></div>{/if}
                <div><p class="text-xs text-fg-3">{t('coreFleet.connections')}</p><p class="num mt-1 font-mono">{snapshot.connections ?? '—'}</p></div>
                <div class="col-span-2"><p class="text-xs text-fg-3">{t('coreFleet.totalTraffic')}</p><p class="num mt-1 font-mono">↓ {snapshot.download === null ? '—' : bytes(snapshot.download)} · ↑ {snapshot.upload === null ? '—' : bytes(snapshot.upload)}</p></div>
              </div>
              <p class="mt-3 text-xs text-fg-3">{t('coreFleet.checkedAt', { time: timestamp(snapshot.checkedAt) })}</p>
              {#each snapshot.errors as failure}<p class="mt-2 break-words text-xs text-warning">{t(`coreFleet.source.${failure.source}`)}: {describe(failure.error)}</p>{/each}
            {/if}
            {#if failures[profile.id]}<p class="mt-2 break-words text-[13px] text-bad">{describe(failures[profile.id])}</p>{/if}
            {#if outcome}
              <p class="mt-3 break-words text-[13px]" class:text-good={outcome.status === 'success'} class:text-bad={outcome.status === 'error'} class:text-warning={outcome.status === 'cancelled'} role="status">{outcome.status === 'success' ? t('coreFleet.applied') : outcome.status === 'error' ? t('coreFleet.failed', { message: describe(outcome.error) }) : t('coreFleet.cancelled')}</p>
            {/if}
          </article>
        {/each}
      </div>

      <div class="space-y-3 border-t border-line px-4 py-4 sm:px-5">
        {#if !embed.hideMode}
          <div class="flex flex-wrap items-end gap-2">
            <div class="min-w-0 flex-1 sm:max-w-52"><label for="{id}-mode" class="mb-1.5 block text-[13px] text-fg-2">{t('mode.label')}</label><select id="{id}-mode" bind:value={mode} disabled={busy !== null} class="min-h-11 w-full rounded-control border border-field-border bg-field px-3 text-[13px] text-fg">{#each ['rule', 'global', 'direct'] as value}<option {value}>{t(`mode.${value}` as 'mode.rule' | 'mode.global' | 'mode.direct')}</option>{/each}</select></div>
            <Button size="sm" class="!h-11" disabled={busy !== null || !targets.length} onclick={() => prepare({ kind: 'mode', mode })} data-testid="core-fleet-mode">{t('coreFleet.mode')}</Button>
          </div>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null || !targets.length} onclick={() => prepare({ kind: 'close' })} data-testid="core-fleet-close">{t('coreFleet.close')}</Button>
          <Button size="sm" disabled={busy !== null || !targets.length} onclick={() => prepare({ kind: 'reload' })} data-testid="core-fleet-reload">{t('coreFleet.reload')}</Button>
        </div>
        {#if summary}<p class="text-[13px] text-fg-2" role="status" data-testid="core-fleet-result">{t('coreFleet.summary', summary)}</p>{/if}
      </div>
    {:else}
      <p class="border-t border-line px-4 py-4 text-[13px] text-fg-3 sm:px-5">{t('coreFleet.empty')}</p>
    {/if}
  </div>
</section>

<Confirm bind:open={confirm} title={t(`coreFleet.confirm.${pendingAction}`)} description={pendingDescription} action={t(`coreFleet.${pendingAction}`)} onconfirm={apply} />
