import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as versions from '../src/lib/app-version.ts'

const release = (tag = 'v1.0.0', extra = {}) => ({ tag_name: tag, html_url: `https://github.com/blagodaren/miboard/releases/tag/${tag}`, draft: false, prerelease: false, ...extra })

test('SemVer follows numeric/prerelease ordering, ignores build metadata and accepts only complete valid versions', () => {
  const ordered = ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(versions.compareAppVersions(ordered[index - 1], ordered[index]), -1)
    assert.equal(versions.compareAppVersions(ordered[index], ordered[index - 1]), 1)
  }
  assert.equal(versions.compareAppVersions('v1.2.3+one', '1.2.3+two'), 0)
  assert.equal(versions.compareAppVersions('1.0.0-9007199254740993', '1.0.0-9007199254740992'), 1)
  assert.equal(versions.compareAppVersions('9007199254740993.0.0', '9007199254740992.0.0'), 1)
  assert.equal(versions.parseAppVersion('v0.1.1-alpha+0001')?.version, '0.1.1-alpha+0001')
  for (const value of [null, {}, ['1.0.0'], 1, '', 'v', '1', '1.2', '01.2.3', '1.02.3', '1.2.03', '1.2.3-01', '1.2.3-rc.01', '1.2.3-', '1.2.3+', '1.2.3-a..b', '1.2.3+test!', ' 1.2.3', '1.2.3\n', '=1.2.3']) {
    assert.equal(versions.parseAppVersion(value), null, JSON.stringify(value))
    assert.equal(versions.compareAppVersions(value, '1.2.3'), null)
  }
})

test('release metadata requires a stable published tag and its matching HTTPS URL in the expected repository', () => {
  assert.deepEqual(versions.parseAppRelease(release('v1.2.3')), { version: '1.2.3', url: 'https://github.com/blagodaren/miboard/releases/tag/v1.2.3' })
  for (const value of [release('v1.2.3-alpha'), release('v1.2.3', { draft: true }), release('v1.2.3', { prerelease: true }), release('v1.2.3', { draft: undefined })]) assert.equal(versions.parseAppRelease(value), null)
  for (const url of [
    'http://github.com/blagodaren/miboard/releases/tag/v1.2.3',
    'https://github.com.evil.example/blagodaren/miboard/releases/tag/v1.2.3',
    'https://github.com/other/miboard/releases/tag/v1.2.3',
    'https://github.com/blagodaren/miboard/releases/tag/v9.9.9',
    'https://github.com/blagodaren/miboard/releases/tag/v1.2.3/elsewhere',
    'https://user@github.com/blagodaren/miboard/releases/tag/v1.2.3',
    'https://github.com:8443/blagodaren/miboard/releases/tag/v1.2.3',
    'https://github.com/blagodaren/miboard/releases/tag/v1.2.3?redirect=elsewhere',
    'https://github.com/blagodaren/miboard/releases/tag/v1.2.3#unknown',
    'javascript:alert(1)',
  ]) assert.equal(versions.parseAppRelease(release('v1.2.3', { html_url: url })), null, url)
})

test('deployment changes support same-version builds without offering a downgrade; cache rejects stale/future/corrupt results', () => {
  const current = { version: '1.2.3', buildId: 'hash-a' }
  assert.deepEqual(versions.parseDeployment({ version: 'v1.2.3', buildId: 'abcdef1234567890' }), { version: '1.2.3', buildId: 'abcdef1234567890' })
  for (const buildId of ['', 'bad build', '../elsewhere', 'a'.repeat(129), 123]) assert.equal(versions.parseDeployment({ version: '1.2.3', buildId }), null)
  assert.equal(versions.canUpdateTo(current, { version: '1.2.3', buildId: 'hash-b' }), true)
  assert.equal(versions.canUpdateTo(current, current), false)
  assert.equal(versions.canUpdateTo(current, { version: '1.2.2', buildId: 'hash-b' }), false)
  assert.equal(versions.canUpdateTo(current, { version: '1.2.3-alpha', buildId: 'hash-b' }), false)
  const now = versions.RELEASE_CACHE_MS + 100
  assert.equal(versions.parseReleaseCache({ checkedAt: now - 1, release: release() }, now)?.version, '1.0.0')
  for (const value of [{ checkedAt: 100, release: release() }, { checkedAt: now + 1, release: release() }, { checkedAt: NaN, release: release() }, { checkedAt: now, release: release('v1.0') }, null]) assert.equal(versions.parseReleaseCache(value, now), null)
})

test('metadata fetch bypasses caches and rejects HTTP errors, malformed JSON, timeout and abort', async () => {
  let received: RequestInit | undefined
  const payload = { version: '1.0.0', buildId: 'hash' }
  assert.deepEqual(await versions.fetchVersionJson('https://example.test/version.json', { fetcher: (async (_, options) => { received = options; return Response.json(payload) }) as typeof fetch }), payload)
  assert.equal(received?.cache, 'no-store')
  assert.equal(received?.credentials, 'omit')
  assert.equal(received?.redirect, 'error')
  await assert.rejects(versions.fetchVersionJson('https://example.test', { fetcher: (async () => new Response('', { status: 403 })) as typeof fetch }), /403/)
  await assert.rejects(versions.fetchVersionJson('https://example.test', { fetcher: (async () => new Response('not json')) as typeof fetch }))
  let timedSignal: AbortSignal | undefined
  await assert.rejects(versions.fetchVersionJson('https://example.test', { timeout: 5, fetcher: ((_, options) => { timedSignal = options?.signal as AbortSignal; return new Promise(() => {}) }) as typeof fetch }), /timed out/)
  assert.equal(timedSignal?.aborted, true)
  const abort = new AbortController()
  abort.abort()
  let called = false
  await assert.rejects(versions.fetchVersionJson('https://example.test', { signal: abort.signal, fetcher: (async () => { called = true; return Response.json(payload) }) as typeof fetch }), /cancelled/)
  assert.equal(called, false)
})

test('worker version messages require valid metadata and close on timeout or postMessage failure', async () => {
  const worker = (value: unknown) => ({ postMessage(message: unknown, transfer: Transferable[]) {
    assert.deepEqual(message, { type: 'GET_VERSION' })
    ;(transfer[0] as MessagePort).postMessage(value)
  } })
  assert.deepEqual(await versions.readWorkerVersion(worker({ version: 'v1.2.3', buildId: 'hash' }) as unknown as ServiceWorker), { version: '1.2.3', buildId: 'hash' })
  await assert.rejects(versions.readWorkerVersion(worker({ version: 'bad', buildId: 'hash' }) as unknown as ServiceWorker), /Invalid/)
  await assert.rejects(versions.readWorkerVersion({ postMessage() {} }, 5), /timed out/)
  await assert.rejects(versions.readWorkerVersion({ postMessage() { throw new Error('disconnected') } }), /disconnected/)
})

test('metadata HTTP errors distinguish GitHub rate limits from unrelated forbidden responses', async () => {
  for (const [status, remaining, limited] of [[403, '0', true], [429, undefined, true], [403, '1', false], [403, undefined, false], [500, '0', false]] as const) {
    await assert.rejects(versions.fetchVersionJson(versions.RELEASE_API_URL, {
      fetcher: (async () => new Response('', { status, headers: remaining === undefined ? {} : { 'X-RateLimit-Remaining': remaining } })) as typeof fetch,
    }), (error: unknown) => {
      assert(error instanceof versions.VersionRequestError)
      assert.equal(error.status, status)
      assert.equal(error.rateLimited, limited)
      return true
    })
  }
})

const runtimeSource = readFileSync(new URL('../src/lib/pwa.svelte.ts', import.meta.url), 'utf8')
const compileRuntime = (production: boolean) => ts.transpileModule(runtimeSource.replaceAll('import.meta.env.PROD', String(production)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const runtimeCode = compileRuntime(true)
const devRuntimeCode = compileRuntime(false)
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function runtime(production = true) {
  const notices: any[] = []
  const calls: string[] = []
  const storage = new Map<string, string>()
  const intervals = new Map<number, () => void>()
  let clock = 100_000_000
  let local: unknown = { version: '1.0.0', buildId: 'build-current' }
  let upstream: unknown = release()
  let githubStatus = 200
  let githubRemaining: string | undefined
  let localStatus = 200
  let fetchGate: Promise<void> | null = null
  let reloads = 0
  let registrations = 0
  let registrationFailure = false
  let updates = 0
  let skipWaiting = 0
  let autoActivate = true
  let flushGate: Promise<void> | null = null
  let flushes = 0
  const serviceWorker: any = new EventTarget()
  const registration: any = new EventTarget()
  const makeWorker = (metadata: unknown, state = 'activated') => Object.assign(new EventTarget(), {
    metadata, state,
    postMessage(message: { type: string }) {
      if (message.type === 'SKIP_WAITING') {
        skipWaiting++
        if (autoActivate) {
          this.state = 'activated'
          registration.active = this
          registration.waiting = null
          serviceWorker.controller = this
          serviceWorker.dispatchEvent(new Event('controllerchange'))
        }
      }
    },
  })
  registration.active = makeWorker(local)
  registration.waiting = null
  registration.installing = null
  registration.update = async () => { updates++; return registration }
  serviceWorker.controller = registration.active
  serviceWorker.register = async (url: URL, options: object) => {
    registrations++
    if (registrationFailure) throw new Error('Worker is not deployed yet')
    assert.equal(String(url), 'https://board.example/subpath/sw.js')
    assert.deepEqual(options, { scope: './', updateViaCache: 'none' })
    return registration
  }
  const media = Object.assign(new EventTarget(), { matches: false })
  const window = Object.assign(new EventTarget(), { isSecureContext: true, matchMedia: () => media, location: { reload() { reloads++ } } })
  const document = Object.assign(new EventTarget(), { baseURI: 'https://board.example/subpath/', visibilityState: 'hidden' })
  const navigator = { serviceWorker, onLine: true }
  const fetcher = (async (url: URL | string, options: RequestInit) => {
    calls.push(String(url))
    assert.equal(options.cache, 'no-store')
    if (fetchGate) await fetchGate
    if (options.signal?.aborted) throw new Error('aborted')
    return String(url) === versions.RELEASE_API_URL
      ? Response.json(upstream, { status: githubStatus, headers: githubRemaining === undefined ? {} : { 'X-RateLimit-Remaining': githubRemaining } })
      : Response.json(local, { status: localStatus })
  }) as typeof fetch
  const helpers = {
    ...versions,
    fetchVersionJson: (url: URL | string, options: object) => versions.fetchVersionJson(url, { ...options, fetcher }),
    readWorkerVersion: async (worker: any) => {
      const result = versions.parseDeployment(worker.metadata)
      if (!result) throw new Error('Invalid worker metadata')
      return result
    },
  }
  const require = (name: string) => {
    if (name === '../../package.json') return { version: '1.0.0' }
    if (name === './app-version') return helpers
    if (name === './i18n.svelte') return { t: (key: string, params?: object) => `${key}${params ? JSON.stringify(params) : ''}` }
    if (name === './notifications.svelte') return { notifications: { show: (notice: any) => { notices.push(notice) } } }
    if (name === './connection-journal.svelte') return { connectionJournal: { flush: async () => { flushes++; if (flushGate) await flushGate } } }
    throw new Error(`Unexpected dependency: ${name}`)
  }
  const exports: any = {}
  const execute = new Function('require', 'exports', '$state', '__APP_BUILD_ID__', 'window', 'document', 'navigator', 'sessionStorage', 'Date', 'setTimeout', 'setInterval', 'clearInterval', production ? runtimeCode : devRuntimeCode)
  execute(require, exports, (value: unknown) => value, 'build-current', window, document, navigator,
    { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    class extends Date { static now() { return clock } },
    (callback: () => void, milliseconds: number) => setTimeout(callback, Math.min(milliseconds, 100)),
    (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, versions.UPDATE_CHECK_INTERVAL); intervals.set(1, callback); return 1 },
    (id: number) => intervals.delete(id),
  )
  return {
    pwa: exports.pwa, notices, calls, registration, serviceWorker, makeWorker, window, document, media,
    get reloads() { return reloads }, get registrations() { return registrations }, get updates() { return updates }, get skipWaiting() { return skipWaiting },
    get flushes() { return flushes }, set flushGate(value: Promise<void> | null) { flushGate = value },
    set local(value: unknown) { local = value }, set upstream(value: unknown) { upstream = value },
    set githubStatus(value: number) { githubStatus = value }, set localStatus(value: number) { localStatus = value },
    set githubRemaining(value: string | undefined) { githubRemaining = value },
    set fetchGate(value: Promise<void> | null) { fetchGate = value }, set autoActivate(value: boolean) { autoActivate = value },
    set registrationFailure(value: boolean) { registrationFailure = value },
    advance(milliseconds: number) { clock += milliseconds },
    tickIntervals() { for (const callback of intervals.values()) callback() },
    get intervalCount() { return intervals.size },
  }
}

test('runtime checks are single-flight, throttle automatic events, cache only successful releases and never claim current on failure', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  assert.equal(state.registrations, 1)
  assert.equal(state.pwa.offlineReady, true)
  assert.equal(state.notices.length, 0, 'First offline cache availability is only a persistent status')
  let releaseGate!: () => void
  state.fetchGate = new Promise((resolve) => { releaseGate = resolve })
  const first = state.pwa.checkForUpdates(), second = state.pwa.checkForUpdates(true)
  await settle()
  assert.equal(state.calls.length, 2)
  releaseGate()
  await Promise.all([first, second])
  assert.equal(state.pwa.checkState, 'current')
  assert.equal(state.notices.filter((notice) => notice.testId === 'pwa-check-result').length, 1)
  await state.pwa.checkForUpdates()
  assert.equal(state.calls.length, 2)
  state.advance(versions.UPDATE_CHECK_INTERVAL)
  await state.pwa.checkForUpdates()
  assert.equal(state.calls.length, 3, 'Automatic checks reuse a valid six-hour GitHub cache')
  state.upstream = release('v1.1.0')
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.latestVersion, '1.1.0')
  assert.equal(state.pwa.updateReady, false, 'An upstream release is not a downloaded deployment')
  state.githubStatus = 403
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.checkState, 'error')
  assert.equal(state.pwa.error, 'pwa.checkFailed')
  assert.equal(state.pwa.latestVersion, '1.1.0', 'Previously validated release remains identifiable')
  state.githubStatus = 200
  state.upstream = release('v0.9.0')
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.latestVersion, null)
  assert.equal(state.pwa.releaseUrl, null)
  assert.equal(state.pwa.checkState, 'current')
  cleanup()
})

test('runtime prepares same-version updates without activation, applies only on explicit request and never reloads another tab', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  const candidate = { version: '1.0.0', buildId: 'build-next' }
  state.local = candidate
  state.registration.waiting = state.makeWorker(candidate, 'installed')
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.updateReady, true)
  assert.equal(state.skipWaiting, 0)
  assert.equal(state.reloads, 0)
  await state.pwa.applyUpdate()
  assert.equal(state.skipWaiting, 1)
  assert.equal(state.reloads, 1)
  assert.equal(state.flushes, 1)
  cleanup()

  const other = runtime(), stopOther = other.pwa.start()
  await settle()
  other.local = candidate
  other.registration.waiting = other.makeWorker(candidate, 'installed')
  await other.pwa.checkForUpdates(true)
  const next = other.registration.waiting
  next.state = 'activated'
  other.registration.active = next
  other.registration.waiting = null
  other.serviceWorker.controller = next
  other.serviceWorker.dispatchEvent(new Event('controllerchange'))
  await settle()
  assert.equal(other.reloads, 0, 'Controller changes in other tabs never reload this tab')
  assert.equal(other.pwa.updateReady, true)
  await other.pwa.applyUpdate()
  assert.equal(other.reloads, 1)
  assert.equal(other.skipWaiting, 0)
  stopOther()
})

test('runtime refuses stale/downgraded workers and reports an activation timeout without a late reload', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  state.registration.waiting = state.makeWorker({ version: '0.9.0', buildId: 'old-build' }, 'installed')
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.updateReady, false)
  await state.pwa.applyUpdate()
  assert.equal(state.skipWaiting, 0)
  assert.equal(state.pwa.error, 'pwa.updateUnavailable')
  const candidate = { version: '1.0.0', buildId: 'next-build' }
  state.local = candidate
  state.registration.waiting = state.makeWorker(candidate, 'installed')
  await state.pwa.checkForUpdates(true)
  state.autoActivate = false
  await state.pwa.applyUpdate()
  assert.equal(state.pwa.applying, false)
  assert.equal(state.pwa.error, 'pwa.updateFailed')
  assert.equal(state.reloads, 0)
  state.registration.active = state.registration.waiting
  state.registration.active.state = 'activated'
  state.registration.waiting = null
  state.serviceWorker.controller = state.registration.active
  state.serviceWorker.dispatchEvent(new Event('controllerchange'))
  await settle()
  assert.equal(state.reloads, 0, 'An activation after the explicit request timed out must not reload')
  cleanup()
})

test('runtime disposal aborts in-flight checks and removes event listeners without late notifications', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  let releaseGate!: () => void
  state.fetchGate = new Promise((resolve) => { releaseGate = resolve })
  const pending = state.pwa.checkForUpdates(true)
  await settle()
  cleanup()
  releaseGate()
  await pending
  assert.equal(state.pwa.checking, false)
  assert.equal(state.notices.length, 0)
  state.advance(versions.UPDATE_CHECK_INTERVAL)
  state.document.visibilityState = 'visible'
  state.window.dispatchEvent(new Event('online'))
  state.document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(state.calls.length, 2)
})

test('runtime captures native install prompt once and confirms installed state only after browser installation', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  let prompts = 0
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => { prompts++ }, userChoice: Promise.resolve({ outcome: 'accepted' }),
  })
  state.window.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(state.pwa.canInstall, true)
  await Promise.all([state.pwa.install(), state.pwa.install()])
  assert.equal(prompts, 1)
  assert.equal(state.pwa.canInstall, false)
  assert.equal(state.pwa.installed, false)
  state.window.dispatchEvent(new Event('appinstalled'))
  assert.equal(state.pwa.installed, true)
  cleanup()
})

test('runtime retries a failed registration and waits for the first cache installation without racing update()', async () => {
  const failed = runtime()
  failed.registrationFailure = true
  const cleanup = failed.pwa.start()
  await settle()
  assert.equal(failed.pwa.error, 'pwa.workerUnavailable')
  failed.registrationFailure = false
  await failed.pwa.checkForUpdates(true)
  assert.equal(failed.registrations, 2)
  assert.equal(failed.pwa.checkState, 'current')
  assert.equal(failed.pwa.error, null)
  cleanup()

  const first = runtime()
  first.registration.active = null
  first.serviceWorker.controller = null
  const installing = first.makeWorker({ version: '1.0.0', buildId: 'build-current' }, 'installing')
  first.registration.installing = installing
  const stop = first.pwa.start()
  await settle()
  const check = first.pwa.checkForUpdates(true)
  await settle()
  assert.equal(first.updates, 0, 'The initial install must finish before any update() call')
  assert.equal(first.pwa.checking, true)
  first.registration.installing = null
  first.registration.active = installing
  installing.state = 'activated'
  installing.dispatchEvent(new Event('statechange'))
  await check
  assert.equal(first.pwa.offlineReady, true)
  assert.equal(first.pwa.checkState, 'current')
  assert.equal(first.notices.some((notice) => notice.testId === 'pwa-offline-ready'), false)
  stop()
})

test('runtime disposal resets install/apply busy states and prevents old completions affecting a restarted instance', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  let resolveChoice!: (value: { outcome: string }) => void
  state.window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: async () => {}, userChoice: new Promise((resolve) => { resolveChoice = resolve }),
  }))
  const installation = state.pwa.install()
  assert.equal(state.pwa.installBusy, true)
  cleanup()
  assert.equal(state.pwa.installBusy, false)
  const stop = state.pwa.start()
  resolveChoice({ outcome: 'accepted' })
  await installation
  await settle()
  const candidate = { version: '1.0.0', buildId: 'next-build' }
  state.local = candidate
  state.registration.waiting = state.makeWorker(candidate, 'installed')
  await state.pwa.checkForUpdates(true)
  state.autoActivate = false
  const applying = state.pwa.applyUpdate()
  await settle()
  assert.equal(state.pwa.applying, true)
  const before = state.calls.length
  await state.pwa.checkForUpdates(true)
  assert.equal(state.calls.length, before, 'A check cannot race an explicitly requested activation')
  stop()
  await applying
  assert.equal(state.pwa.applying, false)
  assert.equal(state.reloads, 0)
  assert.equal(state.notices.some((notice) => notice.testId === 'pwa-update-error'), false, 'Unmount is not shown as an update failure')
})

test('explicit update waits for queued connection journal writes before activation or reload', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  const candidate = { version: '1.0.0', buildId: 'build-next' }
  state.local = candidate
  state.registration.waiting = state.makeWorker(candidate, 'installed')
  await state.pwa.checkForUpdates(true)
  let flushed!: () => void
  state.flushGate = new Promise((resolve) => { flushed = resolve })
  const applying = state.pwa.applyUpdate()
  await settle()
  assert.equal(state.flushes, 1)
  assert.equal(state.skipWaiting, 0)
  assert.equal(state.reloads, 0)
  flushed()
  await applying
  assert.equal(state.skipWaiting, 1)
  assert.equal(state.reloads, 1)
  cleanup()
})

test('a continuously visible production board rechecks hourly and stops its poll on disposal', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  await state.pwa.checkForUpdates()
  assert.equal(state.intervalCount, 1)
  const count = state.calls.length
  state.document.visibilityState = 'visible'
  state.advance(versions.UPDATE_CHECK_INTERVAL)
  state.tickIntervals()
  await settle()
  assert.equal(state.calls.length, count + 1, 'Hourly poll checks the deployment and reuses the release cache')
  cleanup()
  assert.equal(state.intervalCount, 0)
})

test('development checks upstream on demand without requesting a missing local manifest or registering a worker', async () => {
  const state = runtime(false)
  state.document.visibilityState = 'visible'
  const cleanup = state.pwa.start()
  await settle()
  assert.equal(state.registrations, 0)
  assert.equal(state.calls.length, 0)
  assert.equal(state.intervalCount, 0)
  await state.pwa.checkForUpdates(true)
  assert.deepEqual(state.calls, [versions.RELEASE_API_URL])
  assert.equal(state.pwa.checkState, 'current')
  assert.equal(state.pwa.offlineReady, false)
  assert.equal(state.updates, 0)
  cleanup()
})

test('a rate-limited release check explains the limit without disabling a downloaded local update', async () => {
  const state = runtime(), cleanup = state.pwa.start()
  await settle()
  const candidate = { version: '1.0.0', buildId: 'build-next' }
  state.local = candidate
  state.registration.waiting = state.makeWorker(candidate, 'installed')
  state.githubStatus = 403
  state.githubRemaining = '0'
  await state.pwa.checkForUpdates(true)
  assert.equal(state.pwa.error, 'pwa.rateLimited')
  assert.equal(state.pwa.checkState, 'error')
  assert.equal(state.pwa.updateReady, true)
  const notice = state.notices.findLast((notice) => notice.testId === 'pwa-check-result')
  assert.equal(notice.message(), 'pwa.rateLimited')
  assert.equal(notice.action.href, '#/settings?category=maintenance')
  await state.pwa.applyUpdate()
  assert.equal(state.reloads, 1)
  cleanup()
})
