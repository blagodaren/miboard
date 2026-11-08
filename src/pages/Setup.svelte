<script lang="ts">
  import { onMount } from 'svelte'
  import { core, router, theme, type Theme } from '../lib/core.svelte'
  import { normalizeUrl, completeBackendUrl, servedByCore, savedBackends, createSavedBackend, updateSavedBackend, removeSavedBackend, BackendProfileError, type Backend, type SavedBackend } from '../lib/api'
  import { t, type MessageKey } from '../lib/i18n.svelte'
  import { IconServer, IconPlus, IconArrowLeft, IconArrowRight, IconEye, IconEyeOff, IconTrash, IconCheck, IconChevron } from '../lib/icons'
  import Button from '../components/Button.svelte'
  import Segmented from '../components/Segmented.svelte'
  import Confirm from '../components/Confirm.svelte'
  import LanguageSelect from '../components/LanguageSelect.svelte'
  import Brand from '../components/Brand.svelte'
  import { count } from '../lib/format'

  const initialProfiles = savedBackends()
  const initialProfile = initialProfiles.find((p) => p.url === core.backend.url)
    ?? ((core.status === 'ok' || core.status === 'lost') ? initialProfiles[0] : undefined)
  const initialBackend = core.error ? core.backend : initialProfile ?? core.backend
  let profiles = $state(initialProfiles)
  let selectedId = $state<string | null>(initialProfile?.id ?? null)
  let name = $state(initialBackend.name ?? '')
  let url = $state(initialBackend.url || (servedByCore() ? location.origin : ''))
  let secret = $state(initialBackend.secret)
  let showSecret = $state(false)
  let localError = $state<MessageKey | null>(null)
  let confirmRemove = $state(false)
  let removing = $state<SavedBackend | null>(null)
  let savedMessage = $state(false)
  let nameInput: HTMLInputElement

  onMount(() => window.scrollTo(0, 0))

  const busy = $derived(core.status === 'connecting')
  const hasConnection = $derived(core.status === 'ok' || core.status === 'lost')
  const selectedProfile = $derived(profiles.find((profile) => profile.id === selectedId))
  const hasChanges = $derived(!!selectedProfile && (
    name.trim() !== (selectedProfile.name ?? '') || url !== selectedProfile.url || secret !== selectedProfile.secret
  ))
  const addressError = $derived(localError !== null && [
    'backends.errorProtocol', 'backends.errorAddress', 'backends.errorParameters', 'backends.errorUrl', 'backends.errorDuplicate',
  ].includes(localError))
  const error = $derived(localError ? t(localError) : core.error)
  const themes: { value: Theme; label: string }[] = $derived([
    { value: 'system', label: t('settings.theme.system') },
    { value: 'light', label: t('settings.theme.light') },
    { value: 'dark', label: t('settings.theme.dark') },
  ])
  const field =
    'h-11 w-full rounded-[10px] border border-field-border bg-field px-3 text-fg placeholder:text-fg-3 ' +
    'transition-colors duration-150 hover:border-accent-ink disabled:opacity-50'

  function host(address: string) {
    return address.replace(/^https?:\/\//, '')
  }

  function clearError() {
    localError = null
    savedMessage = false
    core.clearError()
  }

  function select(profile: SavedBackend) {
    selectedId = profile.id
    name = profile.name ?? ''
    url = profile.url
    secret = profile.secret
    showSecret = false
    clearError()
  }

  function add() {
    selectedId = null
    name = ''
    url = ''
    secret = ''
    showSecret = false
    clearError()
    nameInput?.focus()
  }

  function remove() {
    if (!removing) return
    removeSavedBackend(removing.id)
    profiles = savedBackends()
    if (selectedId === removing.id) add()
    removing = null
  }

  function prepareBackend(): Backend | null {
    let address = normalizeUrl(completeBackendUrl(url))
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url.trim()) && !/^https?:\/\//i.test(url.trim())) {
      localError = 'backends.errorProtocol'
      return null
    }
    try {
      const parsed = new URL(address)
      if (!parsed.hostname || !['http:', 'https:'].includes(parsed.protocol)) {
        localError = 'backends.errorAddress'
        return null
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        localError = 'backends.errorParameters'
        return null
      }
      address = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
    } catch {
      localError = 'backends.errorUrl'
      return null
    }
    url = address
    return { url: address, secret, name: name.trim() }
  }

  function saveChanges() {
    if (busy) return
    clearError()
    const candidate = prepareBackend()
    if (!candidate) return
    try {
      const updated = selectedId ? updateSavedBackend(selectedId, candidate) : createSavedBackend(candidate)
      profiles = savedBackends()
      select(updated)
      savedMessage = true
    } catch (e) {
      localError = e instanceof BackendProfileError ? {
        duplicate: 'backends.errorDuplicate',
        missing: 'backends.errorMissing',
        invalid: 'backends.errorUrl',
        storage: 'backends.errorStorage',
      }[e.code] as MessageKey : 'backends.errorStorage'
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (busy) return
    clearError()
    const candidate = prepareBackend()
    if (candidate && await core.connect(candidate)) router.go('overview')
  }
</script>

<div class="flex min-h-dvh flex-col bg-page px-4 sm:px-8">
  <header class="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-4 py-6">
    <div class="flex items-center gap-2.5">
      <Brand />
      <span class="led" data-on={core.status === 'ok'} aria-hidden="true"></span>
      {#if hasConnection}
        <Button size="sm" variant="ghost" class="ml-2" onclick={() => router.go('overview')}><IconArrowLeft strokeWidth={1.5} />{t('backends.returnToPanel')}</Button>
      {/if}
    </div>
    <LanguageSelect />
  </header>

  <main class="mx-auto flex w-full max-w-[960px] flex-1 flex-col justify-center py-8 md:py-12">
    <div class="enter">
      <h1 class="text-[32px] leading-[1.15] sm:text-[36px]">{t('backends.title')}</h1>
      <p class="mt-3 max-w-lg text-fg-2">{t('backends.description')}</p>

      <div class="mt-8 grid items-start gap-8 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:gap-12">
        <section aria-labelledby="saved-heading" class="min-w-0">
          <div class="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-2">
            <h2 id="saved-heading" class="text-[13px] text-fg-2">
              {t('backends.saved')} <span class="num ml-1 font-mono text-fg-3">{count(profiles.length)}</span>
            </h2>
            <Button size="sm" variant="ghost" onclick={add} disabled={busy}><IconPlus strokeWidth={1.5} />{t('backends.add')}</Button>
          </div>
          <div class="flex flex-col gap-2">
            {#each profiles as profile (profile.id)}
              {@const selected = selectedId === profile.id}
              <div class="flex min-w-0 items-center rounded-xl border transition-colors duration-150 {selected ? 'border-selected-border bg-selected' : 'border-line bg-card hover:border-field-border hover:bg-hover'}">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-4 py-4 text-left disabled:opacity-50"
                  aria-pressed={selected}
                  disabled={busy}
                  onclick={() => select(profile)}
                >
                  <IconServer class="size-[18px] shrink-0 text-fg-2" strokeWidth={1.5} />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium">{profile.name || host(profile.url)}</span>
                    <span class="mt-1 block truncate font-mono text-xs text-fg-2">{profile.url}</span>
                  </span>
                  {#if selected}<IconCheck class="size-4 shrink-0 text-accent-ink" strokeWidth={1.5} />{/if}
                </button>
                <button
                  type="button"
                  class="mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-page hover:text-fg disabled:opacity-50"
                  aria-label={t('backends.removeLabel', { name: profile.name || host(profile.url) })}
                  title={t('backends.removeHint')}
                  disabled={busy}
                  onclick={() => { removing = profile; confirmRemove = true }}
                ><IconTrash class="size-4" strokeWidth={1.5} /></button>
              </div>
            {:else}
              <div class="rounded-xl border border-line px-5 py-6">
                <p>{t('backends.emptyTitle')}</p>
                <p class="mt-2 text-[13px] text-fg-2">{t('backends.emptyDescription')}</p>
              </div>
            {/each}
          </div>
          <p class="mt-4 text-xs leading-5 text-fg-2">{t('backends.storageHint')}</p>
        </section>

        <section aria-labelledby="connection-heading" class="min-w-0 rounded-2xl border border-line bg-card p-5 sm:p-6">
          <h2 id="connection-heading" class="text-lg font-medium">{t(selectedId ? 'backends.edit' : 'backends.new')}</h2>
          <p class="mt-2 text-[13px] text-fg-2">{t('backends.formDescription')}</p>
          <form class="mt-6 flex flex-col gap-5" onsubmit={submit} aria-busy={busy}>
            <label class="flex flex-col gap-2">
              <span class="flex justify-between gap-2 text-[13px]"><span>{t('backends.name')}</span><span class="text-fg-3">{t('backends.optional')}</span></span>
              <input class={field} bind:this={nameInput} bind:value={name} oninput={clearError} placeholder={t('backends.namePlaceholder')} autocomplete="off" maxlength="80" disabled={busy} />
            </label>
            <div class="flex flex-col gap-2">
              <label for="backend-url" class="text-[13px]">{t('setup.apiUrl')}</label>
              <input
                id="backend-url"
                class="{field} font-mono text-[13px]"
                bind:value={url}
                oninput={clearError}
                onblur={() => (url = completeBackendUrl(url))}
                placeholder="http://192.168.1.1:9090"
                inputmode="url"
                autocomplete="url"
                autocapitalize="none"
                spellcheck={false}
                maxlength="2048"
                aria-invalid={addressError ? true : undefined}
                aria-describedby={addressError ? 'connection-error' : 'address-hint'}
                disabled={busy}
                required
              />
              <span id="address-hint" class="text-xs text-fg-2">{t('backends.addressHint')}</span>
            </div>
            <div>
              <label for="backend-secret" class="mb-2 block text-[13px]">{t('setup.secret')}</label>
              <div class="relative">
                <input
                  id="backend-secret"
                  class="{field} pr-12"
                  type={showSecret ? 'text' : 'password'}
                  bind:value={secret}
                  oninput={clearError}
                  placeholder={t('setup.secretPlaceholder')}
                  autocomplete="current-password"
                  aria-invalid={core.error === t('error.invalidSecret') ? true : undefined}
                  aria-describedby={core.error ? 'connection-error' : 'secret-hint'}
                  disabled={busy}
                />
                <button
                  type="button"
                  class="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-[10px] text-fg-2 transition-colors hover:text-fg disabled:opacity-50"
                  aria-label={t(showSecret ? 'backends.hideSecret' : 'backends.showSecret')}
                  aria-pressed={showSecret}
                  disabled={busy}
                  onclick={() => (showSecret = !showSecret)}
                >
                  {#if showSecret}<IconEyeOff class="size-4" strokeWidth={1.5} />{:else}<IconEye class="size-4" strokeWidth={1.5} />{/if}
                </button>
              </div>
              <p id="secret-hint" class="mt-2 text-xs text-fg-2">{t('backends.secretHint')}</p>
            </div>
            {#if error}<p id="connection-error" class="rounded-lg border border-line bg-page px-3 py-3 text-[13px] text-bad" role="alert">{error}</p>{/if}
            <div class="flex flex-wrap gap-3">
              <Button class="h-11 flex-1" type="button" disabled={busy || (selectedId ? !hasChanges : !url.trim())} onclick={saveChanges}>{t('backends.save')}</Button>
              <Button variant="primary" class="h-11 flex-1" type="submit" disabled={busy}>
                {busy ? t('setup.checking') : t('setup.connect')}
                {#if !busy}<IconArrowRight strokeWidth={1.5} />{/if}
              </Button>
            </div>
            <p class="text-xs text-fg-2">{t(selectedId ? 'backends.saveHint' : 'backends.createHint')}</p>
            {#if savedMessage}
              <p class="flex items-center gap-2 text-[13px] text-fg-2" role="status"><IconCheck class="size-4 shrink-0" strokeWidth={1.5} />{t('backends.savedMessage')}</p>
            {/if}
          </form>
          <details class="group mt-6 border-t border-line pt-4">
            <summary class="flex cursor-pointer list-none items-center justify-between gap-3 rounded text-[13px] text-fg-2 transition-colors hover:text-fg">
              {t('backends.helpTitle')}<IconChevron class="size-4 shrink-0 transition-transform duration-150 group-open:rotate-180" strokeWidth={1.5} />
            </summary>
            <div class="mt-4 text-[13px] text-fg-2">
              <p>{t('backends.helpText')}</p>
              <pre class="mt-3 overflow-x-auto rounded-lg border border-line bg-page p-3 font-mono text-xs leading-5">external-controller: 0.0.0.0:9090
secret: "{t('setup.exampleSecret')}"
external-ui: ui
external-ui-name: miboard</pre>
              <p class="mt-3">{t('backends.helpNetwork')}</p>
            </div>
          </details>
        </section>
      </div>
    </div>
  </main>
  <footer class="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-4 py-5">
    <span class="text-xs text-fg-3">{t('backends.footer')}</span>
    <Segmented label={t('settings.theme')} value={theme.value} options={themes} onchange={(v) => theme.set(v)} />
  </footer>
</div>

<Confirm
  bind:open={confirmRemove}
  title={t('backends.removeTitle')}
  description={t('backends.removeDescription', { name: removing?.name || host(removing?.url ?? '') })}
  action={t('backends.removeAction')}
  onconfirm={remove}
/>
