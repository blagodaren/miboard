import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = (file) => readFileSync(new URL(`../src/lib/${file}`, import.meta.url), 'utf8')
const transpile = (input, module = ts.ModuleKind.CommonJS) => ts.transpileModule(input, {
  compilerOptions: { module, target: ts.ScriptTarget.ES2022 },
}).outputText
const apiCode = transpile(source('api.ts'))
const analysisCode = transpile(source('analysis.ts'))
const trafficHistoryCode = transpile(source('traffic-history.ts'))
const liveUpdatesCode = transpile(source('live-updates.ts'))
const coreCode = transpile(compileModule(transpile(source('core.svelte.ts'), ts.ModuleKind.ESNext), {
  filename: 'core.svelte.js', generate: 'client',
}).js.code)
const plain = (value) => JSON.parse(JSON.stringify(value))

function session(seed = {}, address = 'https://dashboard.test/', fetchResponse) {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  const location = new URL(address)
  const sockets = []
  const timers = new Map()
  const requests = []
  const listeners = new Map()
  const storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  }
  let timerId = 0
  let now = 1_000_000
  class Socket {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this) }
    close() { this.closed = true; this.onclose?.() }
  }
  let api
  let analysis
  let trafficHistory
  let liveUpdates
  const addListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(callback)
  }
  const removeListener = (type, callback) => {
    listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== callback))
  }
  const document = { documentElement: { dataset: {} }, hidden: false, addEventListener: addListener, removeEventListener: removeListener }
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, btoa, AbortController, console,
    location,
    document,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } },
    addEventListener: addListener,
    removeEventListener: removeListener,
    history: { replaceState(_state, _title, path) { location.href = new URL(path, location).href } },
    localStorage: storage,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay, at: now + delay }); return timerId },
    clearTimeout(id) { timers.delete(id) },
    WebSocket: Socket,
    async fetch(url, init) {
      requests.push({ url: String(url), init })
      return fetchResponse ? fetchResponse(url, init) : new Response(JSON.stringify(
        new URL(url).pathname.endsWith('/version') ? { version: 'test' } : { mode: 'rule' },
      ))
    },
    require(id) {
      if (id === './i18n.svelte') return { t: (key) => key }
      if (id === './api') return api
      if (id === './analysis') return analysis
      if (id === './traffic-history') return trafficHistory
      if (id === './live-updates') return liveUpdates
      if (id === './notifications.svelte') return { notifications: { show() {}, dismiss() {} } }
      // Journal persistence is covered separately; these tests isolate controller lifecycle.
      if (id === './connection-journal.svelte') return { connectionJournal: {
        activateBackend: async () => {}, observe() {}, pause() {},
      } }
      return require(id)
    },
  })
  const evaluate = (code, filename) => {
    const exports = {}
    const module = vm.runInContext(`(function(exports, require) {\n${code}\n})`, context, { filename })
    module(exports, context.require)
    return exports
  }
  api = evaluate(apiCode, 'api.ts')
  analysis = evaluate(analysisCode, 'analysis.ts')
  trafficHistory = evaluate(trafficHistoryCode, 'traffic-history.ts')
  liveUpdates = evaluate(liveUpdatesCode, 'live-updates.ts')
  let coreExports
  const runtime = () => coreExports ??= evaluate(coreCode, 'core.svelte.ts')
  return {
    api, store, storage, location, sockets, timers, requests, document,
    advance(milliseconds, run = true) {
      const end = now + milliseconds
      while (run) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at; timers.delete(next[0]); next[1].callback()
      }
      now = end
    },
    core() { return runtime().core },
    router() { return runtime().router },
    dispatch(type) { for (const callback of listeners.get(type) ?? []) callback() },
    reload() { return session(Object.fromEntries(store), location.href, fetchResponse) },
  }
}

test('короткий адрес получает HTTP и порт 9090; явный порт, включая 80 и 443, сохраняется', () => {
  const { api } = session()
  const examples = [
    ['192.168.1.20', 'http://192.168.1.20:9090'],
    [' router.local ', 'http://router.local:9090'],
    ['localhost', 'http://localhost:9090'],
    ['192.168.1.20:7890', 'http://192.168.1.20:7890'],
    ['router.local:80', 'http://router.local:80'],
    ['router.local:443', 'http://router.local:443'],
    ['router.local/api/', 'http://router.local:9090/api/'],
    ['[2001:db8::1]', 'http://[2001:db8::1]:9090'],
    ['[::1]:80', 'http://[::1]:80'],
  ]
  for (const [input, expected] of examples) assert.equal(api.completeBackendUrl(input), expected, input)
})

test('полные URL, пустой ввод и некорректные адреса не переопределяются дополнением', () => {
  const { api } = session()
  for (const input of ['', 'https://router.local', 'http://router.local', 'https://router.local:8443/api/', 'ftp://router.local', 'bad address', 'router.local:70000']) {
    assert.equal(api.completeBackendUrl(input), input)
  }
  assert.equal(api.normalizeUrl('router.local'), 'http://router.local')
  api.saveBackend({ url: 'http://router.local', secret: 'existing' })
  assert.equal(api.savedBackends()[0].url, 'http://router.local')
})

test('старые серверы мигрируют один раз; текущий secret выигрывает, URL дубли не добавляются', () => {
  const s = session({
    'miboard.backend': { url: ' router.test:9090/ ', secret: 'last', name: ' Дом ' },
    'miboard.secrets': {
      'http://router.test:9090': 'old', 'https://other.test/': 'second',
      'bad url': 'bad', 'https://broken.test': 5,
    },
  })
  const profiles = plain(s.api.savedBackends())
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0].url, 'http://router.test:9090')
  assert.equal(profiles[0].secret, 'last')
  assert.equal(profiles[0].name, 'Дом')
  assert.match(profiles[0].id, /^backend-[A-Za-z0-9_-]+$/)
  assert.deepEqual(plain(s.reload().api.savedBackends()), profiles)
  s.store.set('miboard.secrets', JSON.stringify({ 'https://stale.test': 'old' }))
  assert.deepEqual(plain(s.api.savedBackends()), profiles)
})

test('обновление профиля сохраняет ID; удаление чистит secret и последний сервер после reload', () => {
  const s = session()
  s.api.saveBackend({ url: 'router.test:9090', secret: 'first', name: 'Дом' })
  const original = plain(s.api.savedBackends()[0])
  s.api.saveBackend({ url: 'https://other.test', secret: '', name: 'Работа' })
  s.api.saveBackend({ url: 'http://router.test:9090/', secret: 'updated' })
  assert.equal(s.api.savedBackends().length, 2)
  assert.deepEqual(plain(s.api.savedBackends()[0]), { ...original, secret: 'updated' })
  s.api.saveBackend({ url: original.url, secret: 'updated', name: '' })
  assert.equal(s.api.savedBackends()[0].name, undefined)
  s.api.removeSavedBackend(original.id)
  assert.equal(s.store.has('miboard.backend'), false)
  assert.equal(JSON.parse(s.store.get('miboard.secrets'))[original.url], undefined)
  const reload = s.reload()
  assert.deepEqual(plain(reload.api.savedBackends()).map((b) => b.url), ['https://other.test'])
  assert.equal(reload.api.initialBackend(), null)
})

test('legacy URL канонизируются до дедупликации; удаление чистит все алиасы одного сервера', () => {
  const s = session({
    'miboard.backend': { url: 'HTTP://ROUTER.TEST:80/a/../api/', secret: 'working' },
    'miboard.secrets': { 'http://router.test/api': 'older', 'HTTP://ROUTER.TEST:80/api/': 'old' },
  })
  const [profile] = plain(s.api.savedBackends())
  assert.equal(s.api.savedBackends().length, 1)
  assert.equal(profile.url, 'http://router.test/api')
  assert.equal(profile.secret, 'working')
  s.api.saveBackend({ url: 'http://router.test/api/', secret: 'updated' })
  assert.equal(s.api.savedBackends()[0].id, profile.id)
  assert.equal(s.api.savedBackends().length, 1)
  s.api.removeSavedBackend(profile.id)
  const reload = s.reload()
  assert.deepEqual(plain(reload.api.savedBackends()), [])
  assert.deepEqual(JSON.parse(reload.store.get('miboard.secrets')), {})
  assert.equal(reload.api.initialBackend(), null)
})

test('недоступный сервер и произвольный secret сохраняются offline без назначения последним', () => {
  const s = session({}, 'https://dashboard.test/', () => { throw new Error('Network unavailable') })
  const input = { url: 'https://unavailable.invalid:9443/api/', secret: 'arbitrary\nсекрет🔑', name: ' Недоступный ' }
  const created = s.api.createSavedBackend(input)
  assert.equal(created.url, 'https://unavailable.invalid:9443/api')
  assert.equal(created.secret, input.secret)
  assert.equal(created.name, 'Недоступный')
  assert.match(created.id, /^backend-[A-Za-z0-9_-]+$/)
  assert.deepEqual(plain(s.api.backend()), { url: '', secret: '' })
  assert.equal(s.store.has('miboard.backend'), false)
  assert.equal(JSON.parse(s.store.get('miboard.secrets'))[created.url], input.secret)
  const reload = s.reload()
  assert.deepEqual(plain(reload.api.savedBackends()), [plain(created)])
  assert.equal(reload.api.initialBackend(), null)
  assert.equal(s.requests.length, 0)
  assert.equal(s.sockets.length, 0)
  assert.equal(s.timers.size, 0)
})

test('создание другого профиля сохраняет живое подключение и последний успешный сервер', async () => {
  const s = session()
  const core = s.core()
  const live = { url: 'http://router.test:9090', secret: 'connected', name: 'Дом' }
  assert.equal(await core.connect(live), true)
  for (const socket of s.sockets) socket.onopen()
  await new Promise((resolve) => setImmediate(resolve))
  const [activeProfile] = plain(s.api.savedBackends())
  const last = s.store.get('miboard.backend')
  const requestCount = s.requests.length
  const socketCount = s.sockets.length
  const timers = [...s.timers]
  const created = s.api.createSavedBackend({ url: 'https://offline.invalid', secret: 'unverified', name: 'Другой' })
  assert.deepEqual(plain(s.api.savedBackends()), [plain(created), activeProfile])
  assert.deepEqual(plain(core.backend), live)
  assert.deepEqual(plain(s.api.backend()), live)
  assert.equal(core.status, 'ok')
  assert.equal(s.store.get('miboard.backend'), last)
  assert.deepEqual(plain(s.reload().api.initialBackend()), live)
  assert.equal(s.requests.length, requestCount)
  assert.equal(s.sockets.length, socketCount)
  assert.ok(s.sockets.every((socket) => !socket.closed))
  assert.deepEqual([...s.timers], timers)
  core.disconnect()
})

test('offline создание отклоняет canonical duplicate и invalid без записи или миграции', () => {
  const s = session()
  s.api.createSavedBackend({ url: 'http://router.test/api', secret: 'working' })
  const before = Object.fromEntries(s.store)
  assert.throws(() => s.api.createSavedBackend({ url: 'HTTP://ROUTER.TEST:80/a/../api/', secret: 'overwrite' }), (error) => (
    error instanceof s.api.BackendProfileError && error.code === 'duplicate'
  ))
  for (const backend of [null, { url: '', secret: '' }, { url: 'ftp://invalid.test', secret: '' }, { url: 'https://other.test', secret: 5 }, { url: 'https://other.test', secret: '', name: {} }]) {
    assert.throws(() => s.api.createSavedBackend(backend), (error) => error.code === 'invalid')
  }
  assert.deepEqual(Object.fromEntries(s.store), before)
  const legacy = session({ 'miboard.backend': { url: 'HTTP://LEGACY.TEST:80/', secret: 'old' } })
  const beforeMigration = Object.fromEntries(legacy.store)
  assert.throws(() => legacy.api.createSavedBackend({ url: 'http://legacy.test', secret: 'new' }), (error) => error.code === 'duplicate')
  assert.deepEqual(Object.fromEntries(legacy.store), beforeMigration)
})

test('ошибка хранилища при создании откатывает новый профиль и не сообщает success', () => {
  const s = session()
  const before = Object.fromEntries(s.store)
  const setItem = s.storage.setItem
  let fail = true
  s.storage.setItem = (key, value) => {
    if (key === 'miboard.secrets' && fail) { fail = false; throw new Error('Quota exceeded') }
    setItem(key, value)
  }
  assert.throws(() => s.api.createSavedBackend({ url: 'https://new.test', secret: 'new' }), (error) => (
    error instanceof s.api.BackendProfileError && error.code === 'storage'
  ))
  assert.deepEqual(Object.fromEntries(s.store), before)
  s.storage.getItem = () => { throw new Error('Storage blocked') }
  assert.throws(() => s.api.createSavedBackend({ url: 'https://new.test', secret: '' }), (error) => error.code === 'storage')
})

test('редактирование имени и secret не меняет выбранный сервер, порядок и живой backend', () => {
  const s = session()
  s.api.saveBackend({ url: 'http://first.test', secret: 'old', name: 'Первый' })
  s.api.saveBackend({ url: 'http://second.test', secret: 'active', name: 'Второй' })
  s.api.useBackend({ url: 'http://second.test', secret: 'active', name: 'Второй' })
  const [second, first] = plain(s.api.savedBackends())
  const last = s.store.get('miboard.backend')
  const live = plain(s.api.backend())
  const updated = s.api.updateSavedBackend(first.id, { url: first.url, secret: 'new', name: ' Дом ' })
  assert.deepEqual(plain(updated), { ...first, secret: 'new', name: 'Дом' })
  assert.deepEqual(plain(s.api.savedBackends()), [second, plain(updated)])
  assert.equal(s.store.get('miboard.backend'), last)
  assert.deepEqual(plain(s.api.backend()), live)
  assert.equal(JSON.parse(s.store.get('miboard.secrets'))[first.url], 'new')
  assert.equal(s.requests.length, 0)
  assert.equal(s.sockets.length, 0)
})

test('новый URL заменяет профиль на его позиции и очищает legacy алиасы старого secret', () => {
  const s = session()
  s.api.saveBackend({ url: 'http://old.test/api', secret: 'old', name: 'Дом' })
  s.api.saveBackend({ url: 'http://second.test', secret: 'other' })
  const [second, first] = plain(s.api.savedBackends())
  const last = s.store.get('miboard.backend')
  s.store.set('miboard.secrets', JSON.stringify({
    'HTTP://OLD.TEST:80/a/../api/': 'legacy', 'http://old.test/api': 'old', 'http://second.test': 'other',
  }))
  const updated = s.api.updateSavedBackend(first.id, { url: 'HTTPS://NEW.TEST:443/a/../api/', secret: 'new' })
  assert.equal(updated.url, 'https://new.test/api')
  assert.notEqual(updated.id, first.id)
  assert.equal(updated.name, 'Дом')
  assert.deepEqual(plain(s.reload().api.savedBackends()), [second, plain(updated)])
  assert.deepEqual(JSON.parse(s.store.get('miboard.secrets')), { 'http://second.test': 'other', 'https://new.test/api': 'new' })
  assert.equal(s.store.get('miboard.backend'), last)
  assert.equal(s.requests.length, 0)
  assert.equal(s.sockets.length, 0)
})

test('правка последнего профиля обновляет KEY_BACKEND, но не рабочее подключение', () => {
  const s = session()
  const live = { url: 'http://router.test', secret: 'connected', name: 'Дом' }
  s.api.saveBackend(live)
  s.api.useBackend(live)
  const [profile] = s.api.savedBackends()
  const updated = s.api.updateSavedBackend(profile.id, { url: 'https://router.test', secret: 'saved', name: '' })
  assert.deepEqual(JSON.parse(s.store.get('miboard.backend')), { url: updated.url, secret: 'saved' })
  assert.deepEqual(plain(s.api.initialBackend()), { url: updated.url, secret: 'saved' })
  assert.deepEqual(plain(s.api.backend()), live)
  assert.equal(s.api.savedBackends().length, 1)
  assert.equal(s.requests.length, 0)
  assert.equal(s.sockets.length, 0)
})

test('сохранение в Setup оставляет живой сервер и WebSocket, новый URL применяется после reload', async () => {
  const s = session()
  const core = s.core()
  const router = s.router()
  const live = { url: 'http://router.test:9090', secret: 'connected', name: 'Дом' }
  assert.equal(await core.connect(live), true)
  for (const socket of s.sockets) socket.onopen()
  assert.equal(core.status, 'ok')
  await new Promise((resolve) => setImmediate(resolve))
  const [profile] = s.api.savedBackends()
  const requestCount = s.requests.length
  const socketCount = s.sockets.length
  const timers = [...s.timers]
  router.go('setup')
  s.dispatch('hashchange')
  assert.equal(router.route, 'setup')
  const edited = { url: 'https://renamed.test:9443/api', secret: 'saved', name: 'Новый адрес' }
  s.api.updateSavedBackend(profile.id, edited)
  assert.deepEqual(plain(core.backend), live)
  assert.deepEqual(plain(s.api.backend()), live)
  assert.equal(core.status, 'ok')
  assert.equal(s.requests.length, requestCount)
  assert.equal(s.sockets.length, socketCount)
  assert.ok(s.sockets.every((socket) => !socket.closed))
  assert.deepEqual([...s.timers], timers)
  assert.deepEqual(plain(s.reload().api.initialBackend()), edited)
  router.go('overview')
  s.dispatch('hashchange')
  assert.equal(core.status, 'ok')
  assert.equal(s.requests.length, requestCount)
  assert.equal(s.sockets.length, socketCount)
  assert.ok(s.sockets.every((socket) => !socket.closed))
  core.disconnect()
})

test('duplicate, missing и invalid отклоняются без перезаписи или неявной миграции', () => {
  const s = session()
  s.api.saveBackend({ url: 'http://first.test', secret: 'first' })
  s.api.saveBackend({ url: 'https://second.test', secret: 'second' })
  const first = s.api.savedBackends().find((b) => b.url === 'http://first.test')
  const before = Object.fromEntries(s.store)
  const rejects = (id, backend, code) => assert.throws(
    () => s.api.updateSavedBackend(id, backend),
    (error) => error instanceof s.api.BackendProfileError && error.code === code,
  )
  rejects(first.id, { url: 'HTTPS://SECOND.TEST:443/', secret: 'overwrite' }, 'duplicate')
  rejects('missing-id', { url: 'http://third.test', secret: '' }, 'missing')
  for (const backend of [null, { url: 'ftp://invalid.test', secret: '' }, { url: first.url, secret: 5 }, { url: first.url, secret: '', name: {} }]) {
    rejects(first.id, backend, 'invalid')
  }
  assert.deepEqual(Object.fromEntries(s.store), before)
  const legacy = session({ 'miboard.backend': { url: 'http://legacy.test', secret: 'old' } })
  const beforeMigration = Object.fromEntries(legacy.store)
  assert.throws(() => legacy.api.updateSavedBackend('unknown', { url: 'http://new.test', secret: '' }), (e) => e.code === 'missing')
  assert.deepEqual(Object.fromEntries(legacy.store), beforeMigration)
})

test('отказ localStorage сообщает storage и восстанавливает уже записанный список', () => {
  const s = session()
  s.api.saveBackend({ url: 'http://router.test', secret: 'old' })
  const [profile] = s.api.savedBackends()
  const before = Object.fromEntries(s.store)
  const setItem = s.storage.setItem
  let fail = true
  s.storage.setItem = (key, value) => {
    if (key === 'miboard.secrets' && fail) { fail = false; throw new Error('Quota exceeded') }
    setItem(key, value)
  }
  assert.throws(() => s.api.updateSavedBackend(profile.id, { url: 'https://router.test', secret: 'new' }), (error) => error.code === 'storage')
  assert.deepEqual(Object.fromEntries(s.store), before)
  s.storage.getItem = () => { throw new Error('Storage blocked') }
  assert.throws(() => s.api.updateSavedBackend(profile.id, { url: profile.url, secret: 'new' }), (error) => error.code === 'storage')
})

test('повреждённое хранилище и недопустимые профили не ломают выбор сервера', () => {
  const s = session({
    'miboard.backends': [
      { url: 'https://good.test/', secret: '', id: '<untrusted>', name: {} }, null, 2,
      { url: 'https://good.test', secret: 'duplicate' },
      { url: 'javascript:alert(1)', secret: '' }, { url: 'https://u:p@host.test', secret: '' },
    ],
  })
  assert.equal(s.api.savedBackends().length, 1)
  assert.equal(s.api.savedBackends()[0].url, 'https://good.test')
  assert.notEqual(s.api.savedBackends()[0].id, '<untrusted>')
  for (const url of ['ftp://host.test', 'https://host.test?secret=x', 'https://host.test#route']) {
    s.api.saveBackend({ url, secret: 'invalid' })
  }
  assert.equal(s.api.savedBackends().length, 1)
  for (const raw of ['null', '"string"', '[1,2]', '{bad json']) {
    const broken = session({ 'miboard.backend': raw, 'miboard.secrets': raw, 'miboard.backends': raw })
    assert.deepEqual(plain(broken.api.savedBackends()), [])
    assert.equal(broken.api.initialBackend(), null)
  }
})

test('deep links выбирают явный сервер, secret-only /ui или последний успешный без перезаписи профиля', () => {
  const seed = {
    'miboard.backend': { url: 'https://remote.test', secret: 'saved', name: 'Remote' },
    'miboard.secrets': { 'https://remote.test': 'saved', 'https://dashboard.test': 'local' },
  }
  assert.equal(session(seed, 'https://dashboard.test/ui/').api.initialBackend().url, 'https://remote.test')
  const link = session(seed, 'https://dashboard.test/ui/#/overview?secret=deep&keep=1')
  assert.deepEqual(plain(link.api.initialBackend()), { url: 'https://dashboard.test', secret: 'deep' })
  assert.equal(link.location.hash, '#/overview?keep=1')
  assert.equal(JSON.parse(link.store.get('miboard.backend')).url, 'https://remote.test')
  const explicit = session(seed, 'https://dashboard.test/ui/?hostname=another.test&port=9090&protocol=http&secondaryPath=/api&secret=new&keep=1')
  assert.deepEqual(plain(explicit.api.initialBackend()), { url: 'http://another.test:9090/api', secret: 'new' })
  assert.equal(explicit.location.search, '?keep=1')
  assert.equal(JSON.parse(explicit.store.get('miboard.backend')).secret, 'saved')
  const local = session({}, 'https://dashboard.test/ui/')
  assert.equal(local.api.initialBackend().url, 'https://dashboard.test')
})

test('deep link с hostcase и default port находит сохранённые имя и secret канонического URL', () => {
  const s = session({
    'miboard.backends': [{ url: 'http://router.test/api', secret: 'working', name: 'Дом' }],
  }, 'https://dashboard.test/?hostname=ROUTER.TEST&port=80&protocol=http&secondaryPath=/a/../api/')
  const before = plain(s.api.savedBackends())
  assert.deepEqual(plain(s.api.initialBackend()), { url: 'http://router.test/api', secret: 'working', name: 'Дом' })
  assert.deepEqual(plain(s.api.savedBackends()), before)
  assert.equal(s.store.has('miboard.backend'), false)
  assert.equal(s.location.search, '')
})

test('ошибка авторизации Core сохраняет рабочий профиль и последний успешный secret', async () => {
  const s = session({}, 'https://dashboard.test/', async () => new Response(
    JSON.stringify({ message: 'Unauthorized' }), { status: 401, statusText: 'Unauthorized' },
  ))
  s.api.saveBackend({ url: 'http://router.test:9090', secret: 'working', name: 'Дом' })
  const before = Object.fromEntries(s.store)
  const core = s.core()
  assert.equal(await core.connect({ url: 'http://router.test:9090', secret: 'wrong', name: 'Изменено' }), false)
  assert.equal(core.status, 'setup')
  assert.equal(core.error, 'error.invalidSecret')
  assert.deepEqual(Object.fromEntries(s.store), before)
  assert.equal(s.requests[0].init.headers.Authorization, 'Bearer wrong')
  assert.equal(s.sockets.length, 0)
})

test('остановленный stream не меняет состояние; never-opened close не сообщает ложный disconnect', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test:9090', secret: 'token' })
  const states = []
  const stop = s.api.stream('/traffic', () => {}, { onState: (value) => states.push(value) })
  const socket = s.sockets[0]
  assert.equal(new URL(socket.url).searchParams.get('token'), 'token')
  socket.onopen()
  stop()
  socket.onclose()
  socket.onopen()
  assert.deepEqual(states, [true])
  assert.equal(s.timers.size, 0)

  const failedStates = []
  const stopFailed = s.api.stream('/traffic', () => {}, { onState: (value) => failedStates.push(value) })
  s.sockets[1].onclose()
  assert.deepEqual(failedStates, [])
  assert.equal(s.timers.size, 1)
  stopFailed()
  assert.equal(s.timers.size, 0)
})

test('failure hook handles rejected handshakes once and permits cleanup without retry', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test:9090', secret: 'token' })
  let failures = 0
  const stop = s.api.stream('/logs', () => {}, { onFailure: () => { failures++; stop() } })
  const socket = s.sockets[0]
  socket.onerror()
  socket.onclose()
  assert.equal(failures, 1)
  assert.equal(s.timers.size, 0)
  assert.equal(socket.closed, true)
})

test('поздний ответ старого сервера не заменяет новый профиль при переключении Core', async () => {
  let releaseOld
  const s = session({}, 'https://dashboard.test/', async (url) => {
    if (new URL(url).hostname === 'old.test') return new Promise((resolve) => { releaseOld = resolve })
    return new Response(JSON.stringify(new URL(url).pathname === '/version' ? { version: 'new' } : { mode: 'rule' }))
  })
  const core = s.core()
  const oldAttempt = core.connect({ url: 'http://old.test', secret: 'old' })
  assert.equal(await core.connect({ url: 'http://new.test', secret: 'new' }), true)
  releaseOld(new Response(JSON.stringify({ version: 'old' })))
  assert.equal(await oldAttempt, false)
  assert.equal(core.backend.url, 'http://new.test')
  assert.deepEqual(plain(s.api.savedBackends()).map((b) => b.url), ['http://new.test'])
  core.disconnect()
  assert.equal(s.timers.size, 0)
})

test('watchdog восстанавливает молча зависший поток; поздние кадры и другой current backend не вмешиваются', () => {
  const s = session()
  s.api.useBackend({ url: 'http://original.test', secret: 'original' })
  const states = [], values = []
  let stale = 0
  const stop = s.api.stream('/traffic', value => values.push(value), { onState: value => states.push(value), onStale: () => stale++ })
  const old = s.sockets[0]
  old.onopen()
  s.advance(10000)
  old.onmessage({ data: '{bad json' })
  s.advance(5000)
  assert.equal(old.closed, true)
  assert.deepEqual(states, [true, false])
  assert.equal(stale, 1)
  old.onmessage({ data: '{"down":999}' })
  assert.equal(values.length, 0)
  s.api.useBackend({ url: 'http://different.test', secret: 'different' })
  s.advance(1200)
  const replacement = s.sockets[1]
  assert.equal(new URL(replacement.url).hostname, 'original.test')
  assert.equal(new URL(replacement.url).searchParams.get('token'), 'original')
  replacement.onopen()
  replacement.onmessage({ data: '{"down":42}' })
  assert.deepEqual(plain(values), [{ down: 42 }])
  assert.deepEqual(states, [true, false, true])
  stop()
  s.advance(60000)
  assert.equal(s.sockets.length, 2)
  assert.equal(s.timers.size, 0)
})

test('таймаут подключения и backoff с jitter работают до первого корректного кадра', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test', secret: '' })
  const states = []
  let stale = 0
  const stop = s.api.stream('/memory', () => {}, { onState: value => states.push(value), onStale: () => stale++ })
  s.advance(10000)
  assert.equal(stale, 1)
  assert.deepEqual(states, [], 'never-opened timeout cannot decrement the open stream count')
  const firstWait = [...s.timers.values()][0].delay
  assert.ok(firstWait >= 800 && firstWait <= 1200)
  s.advance(firstWait)
  s.sockets[1].onopen()
  s.sockets[1].onclose()
  const secondWait = [...s.timers.values()][0].delay
  assert.ok(secondWait >= 1600 && secondWait <= 2400, 'handshake without data does not reset backoff')
  s.advance(secondWait)
  s.sockets[2].onopen()
  s.sockets[2].onmessage({ data: '{"inuse":42}' })
  s.sockets[2].onclose()
  const resetWait = [...s.timers.values()][0].delay
  assert.ok(resetWait >= 800 && resetWait <= 1200)
  stop()
  assert.equal(s.timers.size, 0)
})

test('тишина в logs нормальна; возвращение из сна проверяет периодический поток сразу', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test', secret: '' })
  const stopLogs = s.api.stream('/logs', () => {})
  s.sockets[0].onopen()
  s.advance(60000)
  assert.equal(s.sockets[0].closed, false)
  assert.equal(s.timers.size, 0)
  const stopTraffic = s.api.stream('/traffic', () => {})
  s.sockets[1].onopen()
  s.document.hidden = true
  s.dispatch('visibilitychange')
  s.advance(30000, false)
  assert.equal(s.sockets[1].closed, false, 'simulate throttled background timers')
  s.document.hidden = false
  s.dispatch('visibilitychange')
  assert.equal(s.sockets[1].closed, true)
  assert.equal(s.sockets[0].closed, false)
  stopTraffic(); stopLogs()
  assert.equal(s.timers.size, 0)
})

test('остановка stream внутри onData не оставляет watchdog или обработчики возобновления', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test', secret: '' })
  const stop = s.api.stream('/traffic', () => stop())
  s.sockets[0].onopen()
  s.sockets[0].onmessage({ data: '{}' })
  assert.equal(s.timers.size, 0)
  s.advance(30000)
  s.dispatch('visibilitychange')
  s.dispatch('online')
  assert.equal(s.sockets.length, 1)
})

test('запоздавший кадр после сна не маскирует пропуск до выполнения visibilitychange', () => {
  const s = session()
  s.api.useBackend({ url: 'http://router.test', secret: '' })
  const values = []
  let stale = 0
  const stop = s.api.stream('/connections', value => values.push(value), { onStale: () => stale++ })
  s.sockets[0].onopen()
  s.advance(20000, false)
  s.sockets[0].onmessage({ data: '{"connections":[]}' })
  assert.equal(stale, 1)
  assert.equal(values.length, 0, 'wait for a new observation baseline after the gap')
  assert.equal(s.sockets[0].closed, true)
  stop()
  assert.equal(s.timers.size, 0)
})

test('eco приостанавливает скрытую вкладку, сохраняет накопления и возобновляет скорости с новой базы', async () => {
  const s = session()
  const core = s.core()
  await core.connect({ url: 'http://router.test', secret: '' })
  const connection = download => ({ id: 'same', start: '2026-01-01T00:00:00Z', download, upload: 0, chains: ['DIRECT'], metadata: { host: 'example.com' } })
  const frame = (sockets, download) => {
    for (const socket of sockets) {
      const path = new URL(socket.url).pathname
      socket.onmessage({ data: JSON.stringify(path === '/traffic' ? { up: 10, down: 42 } : path === '/memory' ? { inuse: 1024 } : { uploadTotal: 0, downloadTotal: download, connections: [connection(download)] }) })
    }
  }
  const original = [...s.sockets]
  original.forEach(socket => socket.onopen())
  frame(original, 100)
  s.advance(1000)
  frame(original, 200)
  assert.equal(core.conns[0].dl, 100)
  assert.equal(core.analysis.totals.download, 100)
  core.setLiveUpdateMode('eco')
  assert.equal(s.store.get('miboard.live-update-mode'), 'eco')
  s.document.hidden = true
  s.dispatch('visibilitychange')
  assert.equal(core.updatesPaused, true)
  assert.equal(core.status, 'ok', 'an intentional pause does not report a controller failure')
  assert.equal(core.streamsOpen, 0)
  assert.ok(original.every(socket => socket.closed))
  assert.equal(core.connectionsFresh, false)
  frame(original, 999999)
  assert.equal(core.analysis.totals.download, 100)
  s.advance(20000)
  assert.equal(s.sockets.length, 3)
  s.document.hidden = false
  s.dispatch('visibilitychange')
  assert.equal(core.updatesPaused, false)
  assert.equal(core.updatesResuming, true)
  assert.equal(core.observationGapVersion, 1)
  const resumed = s.sockets.slice(3)
  assert.equal(resumed.length, 3)
  resumed.forEach(socket => socket.onopen())
  frame(resumed, 10000)
  assert.equal(core.updatesResuming, false)
  assert.equal(core.conns[0].dl, 0, 'paused bytes cannot become an instantaneous speed spike')
  assert.equal(core.analysis.totals.download, 9900, 'preserve the existing connection counters and session baseline')
  assert.equal(core.trafficHistory.snapshot(1800).download, 42, 'never integrate traffic over the hidden interval')
  s.advance(2000)
  frame(resumed, 12000)
  assert.equal(core.conns[0].dl, 1000, 'divide by the actual two-second interval')
  core.disconnect()
  assert.equal(s.timers.size, 0)
})

test('по умолчанию скрытая вкладка продолжает сбор; eco работает в памяти при запрете localStorage', async () => {
  const s = session()
  const core = s.core()
  await core.connect({ url: 'http://router.test', secret: '' })
  s.sockets.forEach(socket => socket.onopen())
  s.document.hidden = true
  s.dispatch('visibilitychange')
  assert.equal(core.liveUpdateMode, 'realtime')
  assert.equal(core.updatesPaused, false)
  assert.ok(s.sockets.every(socket => !socket.closed))
  s.storage.setItem = () => { throw new Error('blocked') }
  assert.equal(core.setLiveUpdateMode('eco'), false)
  assert.equal(core.liveUpdateSaved, false)
  assert.equal(core.liveUpdateMode, 'eco')
  assert.equal(core.updatesPaused, true)
  assert.equal(core.setLiveUpdateMode('invalid'), false)
  assert.equal(core.liveUpdateMode, 'eco')
  core.disconnect()
})

test('смена backend во время eco-паузы не запускает старые потоки и ждёт возвращения вкладки', async () => {
  const s = session({ 'miboard.live-update-mode': 'eco' })
  const core = s.core()
  await core.connect({ url: 'http://old.test', secret: 'old-secret' })
  const old = [...s.sockets]
  old.forEach(socket => socket.onopen())
  s.document.hidden = true
  s.dispatch('visibilitychange')
  await core.connect({ url: 'http://new.test', secret: 'new-secret' })
  assert.equal(core.updatesPaused, true)
  assert.equal(core.backend.url, 'http://new.test')
  assert.equal(s.sockets.length, 3, 'a new controller does not create hidden eco streams')
  old[0].onmessage({ data: '{"down":99999}' })
  old[0].onopen()
  assert.equal(core.down, 0)
  s.advance(30000)
  assert.equal(s.sockets.length, 3)
  s.document.hidden = false
  s.dispatch('visibilitychange')
  assert.equal(s.sockets.length, 6)
  for (const socket of s.sockets.slice(3)) {
    assert.equal(new URL(socket.url).hostname, 'new.test')
    assert.equal(new URL(socket.url).searchParams.get('token'), 'new-secret')
  }
  core.disconnect()
  s.advance(60000)
  assert.equal(s.sockets.length, 6)
  assert.equal(s.timers.size, 0)
})

test('смена сервера сбрасывает трафик и игнорирует поздние сообщения старых WebSocket', async () => {
  const s = session()
  const core = s.core()
  assert.equal(await core.connect({ url: 'http://old.test', secret: '' }), true)
  assert.equal(core.status, 'lost')
  const oldTraffic = s.sockets.find((socket) => new URL(socket.url).pathname === '/traffic')
  oldTraffic.onopen()
  assert.equal(core.status, 'ok')
  oldTraffic.onmessage({ data: JSON.stringify({ up: 10, down: 42 }) })
  assert.equal(core.down, 42)
  assert.equal(core.trafficHistory.size, 1)
  assert.equal(core.streamsOpen, 1)
  assert.equal(await core.connect({ url: 'http://new.test', secret: '' }), true)
  oldTraffic.onmessage({ data: JSON.stringify({ up: 999, down: 999 }) })
  oldTraffic.onclose()
  assert.equal(core.down, 0)
  assert.equal(core.up, 0)
  assert.equal(core.trafficHistory.size, 0)
  assert.equal(core.streamsOpen, 0)
  assert.equal(core.status, 'lost')
  assert.equal(core.backend.url, 'http://new.test')
  core.disconnect()
})

test('Prizrak API кодирует сегменты и использует явный backend с правильными HTTP методами', async () => {
  const s = session({}, 'https://dashboard.test/', async () => new Response(null, { status: 204 }))
  s.api.useBackend({ url: 'http://other.test', secret: 'other' })
  const backend = { url: 'https://prizrak.test/api', secret: 'prizrak-secret' }
  const name = 'Smart / Москва?#%'
  await s.api.api.smartWeights(backend)
  await s.api.api.smartGroupWeights(name, backend)
  await s.api.api.flushSmart(undefined, backend)
  await s.api.api.flushSmart(name, backend)
  await s.api.api.upgradeLightGBM(backend)
  await s.api.api.closeSmartConnection(name, backend)
  assert.deepEqual(s.requests.map(({ url, init }) => [url, init.method]), [
    ['https://prizrak.test/api/group/weights', 'GET'],
    [`https://prizrak.test/api/group/${encodeURIComponent(name)}/weights`, 'GET'],
    ['https://prizrak.test/api/cache/smart/flush', 'POST'],
    [`https://prizrak.test/api/cache/smart/flush/${encodeURIComponent(name)}`, 'POST'],
    ['https://prizrak.test/api/upgrade/lgbm', 'POST'],
    [`https://prizrak.test/api/connections/smart/${encodeURIComponent(name)}`, 'DELETE'],
  ])
  assert(s.requests.every(({ init }) => init.headers.Authorization === 'Bearer prizrak-secret'))
})

test('Prizrak API сохраняет PascalCase веса и сообщает error из неуспешного ответа', async () => {
  const ranking = { weights: [{ Name: 'Node A', Rank: 'MostUsed', Weight: 92.5 }] }
  const s = session({}, 'https://dashboard.test/', async (url) => (
    new URL(url).pathname === '/upgrade/lgbm'
      ? new Response(JSON.stringify({ error: 'Smart cache not available' }), { status: 503 })
      : new Response(JSON.stringify(ranking))
  ))
  s.api.useBackend({ url: 'http://prizrak.test', secret: '' })
  assert.deepEqual(plain(await s.api.api.smartGroupWeights('Smart')), ranking)
  await assert.rejects(s.api.api.upgradeLightGBM(), (error) => (
    error instanceof s.api.ApiError && error.status === 503 && error.message === 'Smart cache not available'
  ))
})

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)) }

test('Core определяет Prizrak по параметрам /configs или типу Smart без имени в версии и unsupported API запросов', async () => {
  for (const [config, proxies, expected] of [
    [{ mode: 'rule', 'lgbm-auto-update': false }, null, true],
    [{ mode: 'rule', 'smart-collector-size': 0 }, null, true],
    [{ mode: 'rule', 'lgbm-update-interval': 0 }, null, true],
    [{ mode: 'rule', 'lgbm-url': '' }, null, true],
    [{ mode: 'rule' }, { proxies: { Smart: { type: 'Smart' } } }, true],
    [{ mode: 'rule' }, { proxies: { Auto: { type: 'URLTest' } } }, false],
    [{ mode: 'rule' }, { proxies: { Invalid: null } }, false],
    [{ mode: 'rule' }, { mode: 'rule' }, false],
    [{ mode: 'rule' }, { proxies: [{ type: 'Smart' }] }, false],
    [{ mode: 'rule', 'lgbm-auto-update': 'true', 'smart-collector-size': '100' }, null, false],
    [{ mode: 'rule' }, null, false],
  ]) {
    const s = session({}, 'https://dashboard.test/', async (url) => {
      const pathname = new URL(url).pathname
      if (pathname === '/version') return new Response(JSON.stringify({ version: 'v1.19.33' }))
      if (pathname === '/configs') return new Response(JSON.stringify(config))
      return new Response(JSON.stringify(proxies))
    })
    const core = s.core()
    assert.equal(await core.connect({ url: 'http://core.test', secret: '' }), true)
    await settle()
    assert.equal(core.prizrak, expected, JSON.stringify({ config, proxies }))
    assert(s.requests.every(({ url }) => !new URL(url).pathname.includes('/weights')), 'Detection never requests an unsupported Smart endpoint')
    core.disconnect()
    assert.equal(core.prizrak, false, 'Disconnect clears advertised capabilities')
  }
})

test('поздние Prizrak config и capability ответы не включают функции на следующем mihomo', async () => {
  const pending = []
  const s = session({}, 'https://dashboard.test/', async (url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/version') return new Response(JSON.stringify({ version: 'v1.19.33' }))
    if (parsed.hostname === 'old.test') return new Promise((resolve) => pending.push({ path: parsed.pathname, resolve }))
    if (parsed.pathname === '/configs') return new Response(JSON.stringify({ mode: 'direct' }))
    return new Response(JSON.stringify({ proxies: {} }))
  })
  const core = s.core()
  assert.equal(await core.connect({ url: 'http://old.test', secret: '' }), true)
  await settle()
  assert(pending.length > 0, 'Old core has a pending configuration or capability response')
  assert.equal(await core.connect({ url: 'http://new.test', secret: '' }), true)
  await settle()
  assert.equal(core.prizrak, false)
  for (const request of pending) request.resolve(new Response(JSON.stringify(
    request.path === '/configs' ? { mode: 'rule', 'lgbm-auto-update': true } : { proxies: { Smart: { type: 'Smart' } } },
  )))
  await settle()
  assert.equal(core.prizrak, false)
  assert.equal(core.configs.mode, 'direct')
  assert.equal(core.backend.url, 'http://new.test')
  core.disconnect()
})
