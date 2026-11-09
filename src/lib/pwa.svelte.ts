import { version } from '../../package.json'
import { t, type MessageKey } from './i18n.svelte'
import { notifications } from './notifications.svelte'
import { connectionJournal } from './connection-journal.svelte'
import {
  canUpdateTo, compareAppVersions, fetchVersionJson, parseAppRelease, parseDeployment, parseReleaseCache,
  readWorkerVersion, withVersionDeadline, RELEASE_API_URL, UPDATE_CHECK_INTERVAL, VersionRequestError, type AppRelease, type AppVersion,
} from './app-version'

type InstallPrompt = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
type CheckState = 'idle' | 'current' | 'available' | 'error'
const RELEASE_CACHE_KEY = 'miboard.release-check.v1'

class Pwa {
  readonly currentVersion = version
  installed = $state(false)
  canInstall = $state(false)
  installBusy = $state(false)
  secureContext = $state(false)
  supported = $state(false)
  offlineReady = $state(false)
  updateReady = $state(false)
  checking = $state(false)
  applying = $state(false)
  latestVersion = $state<string | null>(null)
  releaseUrl = $state<string | null>(null)
  checkState = $state<CheckState>('idle')
  #errorKey = $state<MessageKey | null>(null)
  get error(): string | null { return this.#errorKey ? t(this.#errorKey) : null }

  #started = false
  #generation = 0
  #syncFlight: Promise<void> | null = null
  #syncPending = false
  #prompt: InstallPrompt | null = null
  #registration: ServiceWorkerRegistration | null = null
  #registrationReady: Promise<ServiceWorkerRegistration | null> | null = null
  #readyWorker: ServiceWorker | null = null
  #deployed: AppVersion | null = null
  #seenWaitingBuild: string | null = null
  #updateAnnounced: string | null = null
  #releaseAnnounced: string | null = null
  #lastAutoCheck: number | null = null
  #checkFlight: Promise<void> | null = null
  #manualRequested = false
  #lifecycle = new AbortController()
  #cleanups: (() => void)[] = []
  #currentBuild(): AppVersion { return { version: this.currentVersion, buildId: __APP_BUILD_ID__ } }

  start(): () => void {
    if (this.#started || typeof window === 'undefined') return () => {}
    this.#started = true
    const generation = ++this.#generation
    this.#lifecycle = new AbortController()
    this.secureContext = window.isSecureContext
    this.supported = this.secureContext && 'serviceWorker' in navigator
    const standalone = window.matchMedia('(display-mode: standalone)')
    const syncInstalled = () => {
      this.installed = standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
      this.canInstall = !!this.#prompt && !this.installed
    }
    const installPrompt = (event: Event) => {
      if (!this.secureContext) return
      event.preventDefault()
      this.#prompt = event as InstallPrompt
      syncInstalled()
    }
    const installed = () => { this.#prompt = null; this.installed = true; this.canInstall = false }
    const automaticCheck = () => {
      if (import.meta.env.PROD && document.visibilityState === 'visible' && navigator.onLine) void this.checkForUpdates()
    }
    const controllerChanged = () => { void this.#syncRegistration(generation) }
    syncInstalled()
    standalone.addEventListener('change', syncInstalled)
    window.addEventListener('beforeinstallprompt', installPrompt)
    window.addEventListener('appinstalled', installed)
    window.addEventListener('online', automaticCheck)
    document.addEventListener('visibilitychange', automaticCheck)
    if (this.supported) navigator.serviceWorker.addEventListener('controllerchange', controllerChanged)
    this.#cleanups.push(() => {
      standalone.removeEventListener('change', syncInstalled)
      window.removeEventListener('beforeinstallprompt', installPrompt)
      window.removeEventListener('appinstalled', installed)
      window.removeEventListener('online', automaticCheck)
      document.removeEventListener('visibilitychange', automaticCheck)
      if (this.supported) navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged)
    })
    if (import.meta.env.PROD && this.supported) this.#registrationReady = this.#register(generation)
    if (import.meta.env.PROD) {
      const interval = setInterval(automaticCheck, UPDATE_CHECK_INTERVAL)
      this.#cleanups.push(() => clearInterval(interval))
    }
    automaticCheck()
    return () => {
      if (generation !== this.#generation) return
      this.#started = false
      ++this.#generation
      this.#syncFlight = null
      this.#syncPending = false
      this.#lifecycle.abort()
      for (const cleanup of this.#cleanups.splice(0)) cleanup()
      this.#prompt = null
      this.canInstall = false
      this.installBusy = false
      this.applying = false
      this.checking = false
      this.#manualRequested = false
      this.#checkFlight = null
      this.#registrationReady = null
      this.#registration = null
      this.#readyWorker = null
      this.offlineReady = false
      this.updateReady = false
      this.#lastAutoCheck = null
    }
  }

  async #register(generation: number): Promise<ServiceWorkerRegistration | null> {
    try {
      const registration = await withVersionDeadline(navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
        scope: './', updateViaCache: 'none',
      }))
      if (!this.#current(generation)) return null
      this.#registration = registration
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return
        const changed = () => { void this.#syncRegistration(generation) }
        worker.addEventListener('statechange', changed)
        this.#cleanups.push(() => worker.removeEventListener('statechange', changed))
      }
      const found = () => { watch(registration.installing); void this.#syncRegistration(generation) }
      registration.addEventListener('updatefound', found)
      this.#cleanups.push(() => registration.removeEventListener('updatefound', found))
      watch(registration.installing)
      await this.#syncRegistration(generation)
      return registration
    } catch {
      if (this.#current(generation)) {
        this.#errorKey = 'pwa.workerUnavailable'
        this.#registrationReady = null
      }
      return null
    }
  }

  #current(generation: number) { return this.#started && generation === this.#generation }

  async #syncRegistration(generation: number): Promise<void> {
    if (!this.#current(generation)) return
    this.#syncPending = true
    if (this.#syncFlight) return this.#syncFlight
    const run = async () => {
      while (this.#current(generation) && this.#syncPending) {
        this.#syncPending = false
        await this.#readRegistration(generation)
      }
    }
    const flight = run().finally(() => { if (this.#syncFlight === flight) this.#syncFlight = null })
    this.#syncFlight = flight
    return flight
  }

  async #readRegistration(generation: number) {
    const registration = this.#registration
    if (!registration || !this.#current(generation)) return
    const active = registration.active, waiting = registration.waiting
    const [activeResult, waitingResult] = await Promise.allSettled([
      active ? readWorkerVersion(active) : Promise.resolve(null),
      waiting ? readWorkerVersion(waiting) : Promise.resolve(null),
    ])
    if (!this.#current(generation)) return
    if (registration.active !== active || registration.waiting !== waiting) { this.#syncPending = true; return }
    const activeVersion = activeResult.status === 'fulfilled' ? activeResult.value : null
    const waitingVersion = waitingResult.status === 'fulfilled' ? waitingResult.value : null
    this.offlineReady = !!activeVersion && active?.state === 'activated'
    const waitingReady = !!active && !!waitingVersion && canUpdateTo(this.#currentBuild(), waitingVersion)
    if (waitingReady) this.#seenWaitingBuild = waitingVersion!.buildId
    // A different tab may activate the update. Offer this tab an explicit reload, never perform one here.
    const activeReady = !!activeVersion && this.offlineReady && canUpdateTo(this.#currentBuild(), activeVersion) &&
      (compareAppVersions(activeVersion.version, this.currentVersion) === 1 || activeVersion.buildId === this.#deployed?.buildId || activeVersion.buildId === this.#seenWaitingBuild)
    this.#readyWorker = waitingReady ? waiting : activeReady ? active : null
    this.updateReady = !!this.#readyWorker
    const readyVersion = waitingReady ? waitingVersion : activeReady ? activeVersion : null
    if (readyVersion) {
      this.checkState = 'available'
      if (this.#updateAnnounced !== readyVersion.buildId) {
        this.#updateAnnounced = readyVersion.buildId
        if (!this.#manualRequested) notifications.show({ id: 'pwa:update-ready', tone: 'info', message: () => t('pwa.updateReadyNotification'),
          action: { label: () => t('pwa.openUpdate'), href: '#/settings?category=maintenance' }, testId: 'pwa-update-ready' })
      }
    }
  }

  async install(): Promise<void> {
    const prompt = this.#prompt
    if (!prompt || this.installBusy || this.installed) return
    const generation = this.#generation
    this.installBusy = true
    this.#prompt = null
    this.canInstall = false
    try { await prompt.prompt(); await prompt.userChoice }
    catch {
      if (this.#current(generation)) notifications.show({ id: 'pwa:install-error', tone: 'error', message: () => t('pwa.installFailed') })
    } finally { if (generation === this.#generation) this.installBusy = false }
  }

  async #release(manual: boolean, signal: AbortSignal): Promise<AppRelease> {
    if (!manual) {
      try {
        const cached = parseReleaseCache(JSON.parse(sessionStorage.getItem(RELEASE_CACHE_KEY) ?? 'null'), Date.now())
        if (cached) return cached
      } catch { /* Storage is optional. */ }
    }
    const raw = await fetchVersionJson(RELEASE_API_URL, { signal })
    const release = parseAppRelease(raw)
    if (!release) throw new Error('Invalid release metadata')
    try { sessionStorage.setItem(RELEASE_CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), release: raw })) }
    catch { /* The current result remains usable without storage. */ }
    return release
  }

  async checkForUpdates(manual = false): Promise<void> {
    if (!this.#started || this.applying) return
    if (this.#checkFlight) { this.#manualRequested ||= manual; return this.#checkFlight }
    const now = Date.now()
    if (!manual && this.#lastAutoCheck !== null && now - this.#lastAutoCheck < UPDATE_CHECK_INTERVAL) return
    this.#lastAutoCheck = now
    this.#manualRequested = manual
    this.checking = true
    const generation = this.#generation
    const signal = this.#lifecycle.signal
    const run = async () => {
      const [localResult, releaseResult] = await Promise.allSettled([
        (import.meta.env.PROD ? fetchVersionJson(new URL('version.json', document.baseURI), { credentials: 'same-origin', signal }) : Promise.resolve(this.#currentBuild())).then((value) => {
          const deployment = parseDeployment(value)
          if (!deployment) throw new Error('Invalid deployment metadata')
          return deployment
        }),
        this.#release(manual, signal),
      ])
      if (!this.#current(generation)) return
      this.#deployed = localResult.status === 'fulfilled' ? localResult.value : null
      if (releaseResult.status === 'fulfilled') {
        const release = releaseResult.value
        const newer = compareAppVersions(release.version, this.currentVersion) === 1
        this.latestVersion = newer ? release.version : null
        this.releaseUrl = newer ? release.url : null
        if (newer && this.#releaseAnnounced !== release.version) {
          this.#releaseAnnounced = release.version
          if (!this.#manualRequested) notifications.show({ id: 'pwa:release-available', tone: 'info',
            message: () => t('pwa.releaseAvailableNotification', { version: release.version }),
            action: { label: () => t('pwa.openUpdate'), href: '#/settings?category=maintenance' }, testId: 'pwa-release-available' })
        }
      }
      let workerFailed = false
      if (import.meta.env.PROD && this.supported) {
        const registration = await (this.#registrationReady ??= this.#register(generation))
        if (!this.#current(generation)) return
        if (!registration) workerFailed = true
        else {
          try {
            if (!registration.installing) await withVersionDeadline(registration.update())
            await this.#waitForInstallation(registration, signal)
          }
          catch { workerFailed = true }
          await this.#syncRegistration(generation)
        }
      }
      if (!this.#current(generation)) return
      const deploymentPending = !!this.#deployed && canUpdateTo(this.#currentBuild(), this.#deployed) && !this.updateReady
      const failed = localResult.status === 'rejected' || releaseResult.status === 'rejected' || workerFailed || deploymentPending
      const failureKey = releaseResult.status === 'rejected' && releaseResult.reason instanceof VersionRequestError && releaseResult.reason.rateLimited
        ? 'pwa.rateLimited' : 'pwa.checkFailed'
      this.#errorKey = failed ? failureKey : null
      this.checkState = failed ? 'error' : this.updateReady || this.latestVersion ? 'available' : 'current'
      if (this.#manualRequested) {
        const ready = this.updateReady, latest = this.latestVersion
        notifications.show({ id: 'pwa:check-result', tone: failed ? 'error' : 'success',
          message: () => failed ? t(failureKey) : ready ? t('pwa.updateReadyNotification')
            : latest ? t('pwa.releaseAvailableNotification', { version: latest }) : t('pwa.currentNotification'),
          ...(ready || latest ? { action: { label: () => t('pwa.openUpdate'), href: '#/settings?category=maintenance' } } : {}),
          testId: 'pwa-check-result',
        })
      }
    }
    const flight = run().finally(() => {
      if (this.#checkFlight === flight) { this.#checkFlight = null; this.checking = false; this.#manualRequested = false }
    })
    this.#checkFlight = flight
    return flight
  }

  async #waitForInstallation(registration: ServiceWorkerRegistration, signal: AbortSignal): Promise<void> {
    const worker = registration.installing
    if (!worker) return
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer); worker.removeEventListener('statechange', changed); signal.removeEventListener('abort', aborted)
        if (error) reject(error); else resolve()
      }
      const changed = () => {
        if (worker.state === 'installed' || worker.state === 'activated') done()
        else if (worker.state === 'redundant') done(new Error('Worker installation failed'))
      }
      const aborted = () => done(new Error('Worker installation cancelled'))
      const timer = setTimeout(() => done(new Error('Worker installation timed out')), 15000)
      worker.addEventListener('statechange', changed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted(); else changed()
    })
  }

  async applyUpdate(): Promise<void> {
    if (this.applying || !this.#started) return
    const generation = this.#generation
    this.applying = true
    this.#errorKey = null
    try {
      await this.#syncRegistration(generation)
      if (!this.#current(generation)) return
      const worker = this.#readyWorker
      const registration = this.#registration
      if (!this.updateReady || !worker || !registration) {
        this.#errorKey = 'pwa.updateUnavailable'
        throw new Error('No prepared update')
      }
      // Persist queued closed connections before changing the worker or leaving the page.
      await withVersionDeadline(connectionJournal.flush())
      if (!this.#current(generation)) return
      if (registration.waiting === worker) {
        await new Promise<void>((resolve, reject) => {
          const signal = this.#lifecycle.signal
          const done = (error?: Error) => {
            clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); signal.removeEventListener('abort', aborted)
            if (error) reject(error); else resolve()
          }
          const changed = () => { if (navigator.serviceWorker.controller === worker) done() }
          const aborted = () => done(new Error('Update cancelled'))
          const timer = setTimeout(() => done(new Error('Update activation timed out')), 15000)
          navigator.serviceWorker.addEventListener('controllerchange', changed)
          signal.addEventListener('abort', aborted, { once: true })
          try { worker.postMessage({ type: 'SKIP_WAITING' }); changed() }
          catch (error) { done(error instanceof Error ? error : new Error('Update activation failed')) }
        })
      } else if (registration.active !== worker || worker.state !== 'activated') throw new Error('Prepared update was replaced')
      if (this.#current(generation)) window.location.reload()
    } catch {
      if (this.#current(generation)) {
        this.#errorKey ??= 'pwa.updateFailed'
        const key = this.#errorKey
        notifications.show({ id: 'pwa:update-error', tone: 'error', message: () => t(key), testId: 'pwa-update-error' })
      }
    } finally { if (generation === this.#generation) this.applying = false }
  }
}

export const pwa = new Pwa()
