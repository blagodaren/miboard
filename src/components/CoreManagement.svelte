<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { errorMessage, request, type Backend, type Configs } from '../lib/api'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { connectionJournal } from '../lib/connection-journal.svelte'
  import { CoreManagementError, LOG_LEVELS, RUNTIME_FLAGS, RUNTIME_PORTS, rebaseRuntimeDraft, runtimeDraft, runtimePatch, upgradeCore, writeRuntimeSettings, type CoreUpgrade, type RuntimeDraft, type RuntimeField, type RuntimeIssue, type UpgradeResult } from '../lib/core-management'
  import Button from './Button.svelte'
  import Toggle from './Toggle.svelte'
  import Confirm from './Confirm.svelte'

  let { section = 'all' }: { section?: 'runtime' | 'upgrades' | 'all' } = $props()
  const id = $props.id()
  const flagLabels = { ipv6: 'coreManagement.ipv6', sniffing: 'coreManagement.sniffing', 'tcp-concurrent': 'coreManagement.concurrent' } as const
  const fieldClass = 'min-h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px] text-fg disabled:opacity-50 aria-invalid:border-bad'
  let baseline = $state.raw<Configs | null>(null)
  let draft = $state<RuntimeDraft>({})
  let touched = $state<Partial<Record<RuntimeField, boolean>>>({})
  let submitted = $state(false)
  let busy = $state<'settings' | CoreUpgrade | null>(null)
  let error = $state<unknown>(null)
  let saved = $state(false)
  let upgradeResult = $state<{ action: CoreUpgrade; result: UpgradeResult } | null>(null)
  let confirmPorts = $state(false)
  let confirmUpgrade = $state(false)
  let pendingUpgrade = $state<CoreUpgrade>('core')
  let pendingSettings = $state.raw<{ backend: Backend; configs: Configs; draft: RuntimeDraft } | null>(null)
  let pendingBackend = $state.raw<Backend | null>(null)
  let controller: AbortController | null = null
  let active = true
  let identity = ''
  let errorElement = $state<HTMLParagraphElement | undefined>(undefined)
  const plan = $derived(baseline ? runtimePatch(baseline, draft) : { patch: {}, issues: [], changesPorts: false })
  const dirty = $derived(baseline !== null && JSON.stringify(draft) !== JSON.stringify(runtimeDraft(baseline)))
  const disabled = $derived(busy !== null || core.status !== 'ok' || !baseline)
  const portPreview = $derived(pendingSettings ? RUNTIME_PORTS.filter(key => Object.hasOwn(runtimePatch(pendingSettings!.configs, pendingSettings!.draft).patch, key)).map(key => `${t(`coreManagement.${key}`)} ${pendingSettings!.draft[key]}`).join(', ') : '')

  $effect(() => {
    const key = JSON.stringify([core.backend.url, core.backend.secret])
    untrack(() => {
      if (key === identity) return
      identity = key; controller?.abort(); controller = null; busy = null; error = null; saved = false; upgradeResult = null
      confirmPorts = false; confirmUpgrade = false; pendingSettings = null; pendingBackend = null
      baseline = core.configs ? { ...core.configs } : null; draft = runtimeDraft(baseline); touched = {}; submitted = false
    })
  })
  $effect(() => {
    const configs = core.configs
    untrack(() => { if (configs && !dirty && !busy) { baseline = { ...configs }; draft = runtimeDraft(configs) } })
  })
  onDestroy(() => { active = false; controller?.abort() })
  const sameBackend = (backend: Backend) => active && backend.url === core.backend.url && backend.secret === core.backend.secret
  const current = (backend: Backend, abort: AbortController) => sameBackend(backend) && controller === abort && !abort.signal.aborted
  const describe = (cause: unknown) => cause instanceof CoreManagementError ? t(`coreManagement.${cause.code}`) : errorMessage(cause)
  function fieldIssue(field: RuntimeField): RuntimeIssue | undefined { return submitted || touched[field] ? plan.issues.find(issue => issue.field === field) : undefined }
  function issueMessage(issue: RuntimeIssue): string {
    const key: MessageKey = issue.code === 'port' ? 'coreManagement.portError' : issue.code === 'duplicate' ? 'coreManagement.duplicateError' : issue.code === 'logLevel' ? 'coreManagement.logLevelError' : 'coreManagement.unsupportedField'
    return t(key)
  }
  function reset() { if (!baseline || busy) return; draft = runtimeDraft(core.configs ?? baseline); baseline = { ...(core.configs ?? baseline) }; touched = {}; submitted = false; error = null; saved = false }
  async function prepareSettings(event: SubmitEvent) {
    event.preventDefault()
    if (disabled || !baseline || !dirty) return
    submitted = true; saved = false; error = null
    if (plan.issues.length) { error = new CoreManagementError('invalid'); await tick(); errorElement?.focus(); return }
    pendingSettings = { backend: { ...core.backend }, configs: { ...baseline }, draft: { ...draft } }
    if (plan.changesPorts) confirmPorts = true
    else await applySettings()
  }
  async function applySettings() {
    const selected = pendingSettings
    if (!selected || busy || core.status !== 'ok' || !sameBackend(selected.backend)) return
    const abort = new AbortController(); controller = abort; busy = 'settings'; error = null; saved = false
    try {
      const observed = await writeRuntimeSettings(request, selected.backend, selected.configs, selected.draft, abort.signal)
      if (!current(selected.backend, abort)) return
      core.configs = observed; baseline = { ...observed }; draft = runtimeDraft(observed); touched = {}; submitted = false; saved = true
    } catch (cause) { if (current(selected.backend, abort)) {
      if (cause instanceof CoreManagementError && cause.observed) {
        draft = rebaseRuntimeDraft(selected.configs, selected.draft, cause.observed)
        core.configs = cause.observed; baseline = { ...cause.observed }
      }
      error = cause; await tick(); errorElement?.focus()
    } }
    finally { if (controller === abort) { busy = null; controller = null; pendingSettings = null } }
  }
  function prepareUpgrade(action: CoreUpgrade) {
    if (busy || core.status !== 'ok') return
    pendingUpgrade = action; pendingBackend = { ...core.backend }; confirmUpgrade = true
  }
  async function applyUpgrade() {
    const backend = pendingBackend, action = pendingUpgrade
    if (!backend || !sameBackend(backend) || busy || core.status !== 'ok') return
    const abort = new AbortController(); controller = abort; busy = action; error = null; upgradeResult = null
    try {
      const result = await upgradeCore(request, backend, action, abort.signal)
      if (!current(backend, abort)) return
      core.version = result.version; upgradeResult = { action, result }
      void core.refreshConfigs()
    } catch (cause) { if (current(backend, abort)) error = cause }
    finally { if (controller === abort) { busy = null; controller = null; pendingBackend = null } }
  }
  async function reloadUi() {
    if (busy) return
    try { await connectionJournal.flush(); window.location.reload() } catch (cause) { error = cause }
  }
</script>

{#if section === 'runtime' || section === 'all'}
  <section aria-labelledby="{id}-runtime" data-testid="core-runtime-settings">
    <h2 id="{id}-runtime" class="mb-3 px-1 text-[13px] text-fg-2">{t('coreManagement.title')}</h2>
    <form onsubmit={prepareSettings} novalidate class="rounded-panel border border-line bg-card" aria-busy={busy === 'settings'}>
      <div class="space-y-2 px-4 py-4 sm:px-5">
        <p class="text-[13px] leading-5 text-fg-3">{t('coreManagement.hint')}</p>
        {#if core.status !== 'ok'}<p class="text-[13px] text-warning" role="status">{t('coreManagement.offline')}</p>{/if}
        {#if error}<p bind:this={errorElement} tabindex="-1" class="text-[13px] text-bad" role="alert">{describe(error)}</p>{/if}
        {#if saved}<p class="text-[13px] text-good" role="status">{t('coreManagement.saved')}</p>{/if}
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
        <label for="{id}-level" class="text-[13px]">{t('coreManagement.logLevel')}</label>
        <div class="w-full sm:w-48">
          <select id="{id}-level" class={fieldClass} bind:value={draft['log-level']} disabled={disabled || draft['log-level'] === undefined} aria-invalid={!!fieldIssue('log-level')} aria-describedby={fieldIssue('log-level') ? `${id}-level-error` : undefined} onblur={() => touched['log-level'] = true} data-testid="core-log-level">
            {#if draft['log-level'] !== undefined && !(LOG_LEVELS as readonly string[]).includes(draft['log-level'])}<option value={draft['log-level']}>{draft['log-level']}</option>{/if}
            {#each LOG_LEVELS as level}<option value={level}>{t(`coreManagement.level.${level}`)}</option>{/each}
          </select>
          {#if fieldIssue('log-level')}<p id="{id}-level-error" class="mt-1 text-xs text-bad">{issueMessage(fieldIssue('log-level')!)}</p>{/if}
        </div>
      </div>
      {#each RUNTIME_FLAGS as key}
        <div class="flex items-center justify-between gap-4 border-t border-line px-4 py-4 sm:px-5">
          <div class="text-[13px]">{t(flagLabels[key])}{#if draft[key] === undefined}<p class="mt-1 text-xs text-fg-3">{t('coreManagement.unsupportedField')}</p>{/if}</div>
          <Toggle label={t(flagLabels[key])} checked={draft[key] ?? false} disabled={disabled || draft[key] === undefined} onchange={value => { draft[key] = value; saved = false }} />
        </div>
      {/each}
      <details class="border-t border-line" open={submitted && plan.issues.some(issue => RUNTIME_PORTS.includes(issue.field as typeof RUNTIME_PORTS[number]))}>
        <summary class="min-h-11 cursor-pointer px-4 py-3 text-[13px] sm:px-5">{t('coreManagement.ports')}</summary>
        <div class="px-4 pb-4 sm:px-5">
          <p class="mb-3 text-[13px] text-fg-3">{t('coreManagement.portsHint')}</p>
          <div class="grid gap-4 sm:grid-cols-2">
            {#each RUNTIME_PORTS as key}
              <div>
                <label for="{id}-{key}" class="mb-1.5 block text-[13px] text-fg-2">{t(`coreManagement.${key}`)}</label>
                <input id="{id}-{key}" class={fieldClass} type="text" inputmode="numeric" autocomplete="off" bind:value={draft[key]} disabled={disabled || draft[key] === undefined} onblur={() => touched[key] = true} aria-invalid={!!fieldIssue(key)} aria-describedby={`${id}-${key}-hint`} data-testid={`core-port-${key}`} />
                <p id="{id}-{key}-hint" class="mt-1 text-xs" class:text-bad={!!fieldIssue(key)} class:text-fg-3={!fieldIssue(key)}>{fieldIssue(key) ? issueMessage(fieldIssue(key)!) : draft[key] === undefined ? t('coreManagement.unsupportedField') : ''}</p>
              </div>
            {/each}
          </div>
        </div>
      </details>
      <div class="flex flex-wrap gap-2 border-t border-line px-4 py-3 sm:px-5">
        <Button type="submit" variant="primary" size="sm" disabled={disabled || !dirty} data-testid="core-runtime-save">{t(busy === 'settings' ? 'coreManagement.saving' : 'coreManagement.save')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null || !dirty} onclick={reset}>{t('coreManagement.reset')}</Button>
      </div>
    </form>
  </section>
{/if}

{#if section === 'upgrades' || section === 'all'}
  <section aria-labelledby="{id}-upgrades" data-testid="core-upgrades" class:mt-6={section === 'all'}>
    <h2 id="{id}-upgrades" class="mb-3 px-1 text-[13px] text-fg-2">{t('coreManagement.upgrades')}</h2>
    <div class="rounded-panel border border-line bg-card px-4 py-4 sm:px-5" aria-busy={busy !== null}>
      <p class="text-[13px] leading-5 text-fg-3">{t('coreManagement.upgradesHint')}</p>
      {#if core.status !== 'ok' && !busy}<p class="mt-2 text-[13px] text-warning" role="status">{t('coreManagement.offline')}</p>{/if}
      <div class="mt-4 flex flex-wrap gap-2">
        {#each ['core', 'ui', 'geo'] as kind}
          <Button size="sm" disabled={busy !== null || core.status !== 'ok'} onclick={() => prepareUpgrade(kind as CoreUpgrade)} data-testid={`core-upgrade-${kind}`}>{t(`coreManagement.upgrade.${kind}` as MessageKey)}</Button>
        {/each}
      </div>
      {#if busy && busy !== 'settings'}<p class="mt-3 text-[13px] text-fg-2" role="status">{t('coreManagement.upgrading')}</p>{/if}
      {#if error && section === 'upgrades'}<p class="mt-3 text-[13px] text-bad" role="alert">{describe(error)}</p>{/if}
      {#if upgradeResult}
        {@const result = upgradeResult.result}
        <p class="mt-3 text-[13px]" class:text-warning={result.outcome === 'unconfirmed'} class:text-good={result.outcome !== 'unconfirmed'} role="status" data-testid="core-upgrade-result">{t(result.outcome === 'versionChanged' ? 'coreManagement.upgraded' : result.outcome === 'accepted' ? 'coreManagement.upgradeAccepted' : 'coreManagement.upgradeUnconfirmed', { version: result.version, previous: result.previousVersion })}</p>
        {#if upgradeResult.action === 'ui' && result.outcome === 'accepted'}<div class="mt-3"><Button size="sm" onclick={reloadUi}>{t('coreManagement.reloadUi')}</Button></div>{/if}
      {/if}
    </div>
  </section>
{/if}

<Confirm bind:open={confirmPorts} title={t('coreManagement.portConfirm')} description={t('coreManagement.portDescription', { name: pendingSettings?.backend.name || pendingSettings?.backend.url || '', ports: portPreview })} action={t('coreManagement.save')} onconfirm={applySettings} />
<Confirm bind:open={confirmUpgrade} title={t(`coreManagement.upgrade.${pendingUpgrade}`)} description={t(`coreManagement.upgradeDescription.${pendingUpgrade}`, { name: pendingBackend?.name || pendingBackend?.url || '' })} action={t(`coreManagement.upgrade.${pendingUpgrade}`)} onconfirm={applyUpgrade} />
