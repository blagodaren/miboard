import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const cachePrefix = scope => `miboard-static:${new URL(scope).pathname}:`
const cacheName = (scope, id) => cachePrefix(scope) + id
const stateName = (scope, id) => cachePrefix(scope) + 'active:' + id
const keyUrl = request => typeof request === 'string' ? new URL(request).href : new URL(request.url ?? request.href).href

/** Real Response cloning/body consumption, with deterministic CacheStorage creation order. */
class MemoryCacheStorage {
  caches = new Map()
  puts = []
  opens = []
  async open(name) {
    this.opens.push(name)
    if (!this.caches.has(name)) {
      const records = new Map()
      const cache = {
        async match(request) {
          const value = records.get(keyUrl(request))
          return value ? new Response(value.body, { status: value.status, headers: value.headers }) : undefined
        },
        put: async (request, response) => {
          const key = keyUrl(request)
          this.puts.push({ name, key })
          records.set(key, { body: Buffer.from(await response.clone().arrayBuffer()), status: response.status, headers: [...response.headers] })
        },
        async keys() { return [...records.keys()].map(url => new Request(url)) },
        async delete(request) { return records.delete(keyUrl(request)) },
      }
      this.caches.set(name, cache)
    }
    return this.caches.get(name)
  }
  async keys() { return [...this.caches.keys()] }
  async delete(name) { return this.caches.delete(name) }
}

function createWorker({ id = 'aaaaaaaaaaaaaaaa', scope = 'https://dashboard.test/ui/', storage = new MemoryCacheStorage(), files, network } = {}) {
  const version = { version: '1.2.3', buildId: id }
  files ??= new Map([
    ['index.html', Buffer.from(`<title>MIBoard ${id[0]}</title>`)],
    [`assets/app-${id[0]}.js`, Buffer.from(`console.log('${id[0]}')`)],
    ['manifest.webmanifest', Buffer.from('{}')],
  ])
  const urls = new Map([...files].map(([name, bytes]) => [new URL(name, scope).href, bytes]))
  const calls = []
  const handlers = new Map()
  let claimed = 0
  let skipped = 0
  const self = {
    registration: { scope },
    clients: { async claim() { claimed++ } },
    async skipWaiting() { skipped++ },
    addEventListener(type, listener) { assert(!handlers.has(type), `Duplicate ${type} handler`); handlers.set(type, listener) },
  }
  const fetcher = async input => {
    const url = keyUrl(input)
    calls.push({ url, method: input.method ?? 'GET', authorization: input.headers?.get('authorization') ?? null })
    if (network) return network(url, input, urls)
    const body = urls.get(url)
    return new Response(body ?? 'Not found', { status: body ? 200 : 404 })
  }
  const source = `const VERSION = ${JSON.stringify(version)};\nconst STATIC_FILES = ${JSON.stringify([...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes) })))};\n${template}`
  vm.runInNewContext(source, { self, caches: storage, fetch: fetcher, URL, Request, Response, crypto: webcrypto }, { filename: 'service-worker-fixture.js' })
  return {
    id, scope, storage, calls, version,
    get claimed() { return claimed }, get skipped() { return skipped },
    async lifecycle(type) {
      const waits = []
      handlers.get(type)({ waitUntil(promise) { waits.push(Promise.resolve(promise)) } })
      await Promise.all(waits)
    },
    async message(data, ports = []) {
      const waits = []
      handlers.get('message')({ data, ports, waitUntil(promise) { waits.push(Promise.resolve(promise)) } })
      await Promise.all(waits)
    },
    async request(input, { navigation = false, ...options } = {}) {
      const request = typeof input === 'string' ? new Request(new URL(input, scope), options) : input
      const eventRequest = navigation ? { url: request.url, method: request.method, headers: request.headers, mode: 'navigate' } : request
      let response
      handlers.get('fetch')({ request: eventRequest, respondWith(value) { assert.equal(response, undefined, 'respondWith may only be called once'); response = Promise.resolve(value) } })
      return { intercepted: response !== undefined, response: response ? await response : undefined }
    },
  }
}

test('install verifies static bytes and never activates an update without an explicit message', async () => {
  const worker = createWorker()
  await worker.lifecycle('install')
  assert.equal(worker.calls.length, 3)
  assert(worker.calls.every(call => call.method === 'GET' && !call.authorization))
  assert.equal(worker.claimed, 0)
  assert.equal(worker.skipped, 0, 'Installation must not call skipWaiting')
  assert.deepEqual(await worker.storage.keys(), [cacheName(worker.scope, worker.id)])
  const posted = []
  await worker.message({ type: 'GET_VERSION' }, [{ postMessage(value) { posted.push(JSON.parse(JSON.stringify(value))) } }])
  assert.deepEqual(posted, [worker.version])
  assert.equal(worker.skipped, 0)
  await worker.message({ type: 'SKIP_WAITING' })
  assert.equal(worker.skipped, 1)
  await worker.lifecycle('activate')
  assert.equal(worker.claimed, 1)
  assert.deepEqual((await (await worker.storage.open(stateName(worker.scope, worker.id))).keys()), [], 'The activation sentinel contains no user or app data')
})

test('A active → B waiting → C applied retains A and C, never the newer but inactive B cache', async () => {
  const storage = new MemoryCacheStorage()
  const a = createWorker({ id: 'aaaaaaaaaaaaaaaa', storage })
  await a.lifecycle('install'); await a.lifecycle('activate')
  const b = createWorker({ id: 'bbbbbbbbbbbbbbbb', storage })
  await b.lifecycle('install')
  const c = createWorker({ id: 'cccccccccccccccc', storage })
  await c.lifecycle('install')
  assert((await storage.keys()).includes(cacheName(b.scope, b.id)), 'B really was downloaded after A activated')
  await c.lifecycle('activate')
  assert.deepEqual(new Set(await storage.keys()), new Set([
    cacheName(a.scope, a.id), cacheName(c.scope, c.id), stateName(c.scope, c.id),
  ]))
  assert.equal(b.claimed, 0)
  const before = c.calls.length
  const previousAsset = await c.request('assets/app-a.js')
  assert.equal(previousAsset.intercepted, true)
  assert.equal(await previousAsset.response.text(), "console.log('a')", 'An already-open A tab can still load its previous chunk')
  assert.equal(c.calls.length, before, 'Previous chunks do not need the network')
  const d = createWorker({ id: 'dddddddddddddddd', storage })
  await d.lifecycle('install'); await d.lifecycle('activate')
  assert.deepEqual(new Set(await storage.keys()), new Set([
    cacheName(c.scope, c.id), cacheName(d.scope, d.id), stateName(d.scope, d.id),
  ]), 'A later activation still bounds storage to two active generations plus an empty marker')
})

test('cache cleanup is isolated between root, GitHub Pages and nested mihomo UI scopes', async () => {
  const storage = new MemoryCacheStorage()
  await storage.open('another-application-cache')
  const scopes = ['https://dashboard.test/', 'https://dashboard.test/miboard/', 'https://dashboard.test/ui/', 'https://dashboard.test/ui/custom/']
  for (const scope of scopes) {
    const worker = createWorker({ scope, storage })
    await worker.lifecycle('install'); await worker.lifecycle('activate')
  }
  const otherNames = (await storage.keys()).filter(name => !name.startsWith(cachePrefix(scopes[1])))
  const update = createWorker({ id: 'bbbbbbbbbbbbbbbb', scope: scopes[1], storage })
  await update.lifecycle('install'); await update.lifecycle('activate')
  assert.deepEqual((await storage.keys()).filter(name => !name.startsWith(cachePrefix(scopes[1]))), otherNames)
  for (const scope of [scopes[0], scopes[2], scopes[3]]) {
    assert((await storage.keys()).includes(stateName(scope, 'aaaaaaaaaaaaaaaa')))
    assert((await storage.keys()).includes(cacheName(scope, 'aaaaaaaaaaaaaaaa')))
  }
})

test('API, WebSocket, version, authorization, range and non-GET requests bypass the worker entirely', async () => {
  const worker = createWorker()
  await worker.lifecycle('install'); await worker.lifecycle('activate')
  const count = worker.calls.length
  const operations = worker.storage.opens.length
  const requests = [
    ['connections'], ['configs'], ['dns/query?name=example.test'], ['version.json'], ['version.json?reload=1'],
    ['assets/app-a.js?secret=fixture'], ['assets/app-a.js?v=1'], ['assets/app-a.js', { method: 'POST', body: 'fixture' }],
    ['assets/app-a.js', { method: 'HEAD' }], ['assets/app-a.js', { headers: { Authorization: 'Bearer fixture-secret' } }],
    ['assets/app-a.js', { headers: { Range: 'bytes=0-9' } }], ['https://unpkg.com/font.woff2'],
    ['https://another-origin.test/ui/assets/app-a.js'], ['https://dashboard.test/outside-ui/'],
  ]
  for (const [url, options] of requests) assert.equal((await worker.request(url, options)).intercepted, false, url)
  const socket = { url: 'wss://dashboard.test/ui/connections?token=fixture', method: 'GET', mode: 'websocket', headers: new Headers() }
  assert.equal((await worker.request(socket)).intercepted, false)
  assert.equal(worker.calls.length, count, 'Bypassed requests must be left to the browser, not fetched by the worker')
  assert.equal(worker.storage.opens.length, operations, 'Bypassed requests must not touch caches')
})

test('offline navigation uses the clean index key and never stores query credentials', async () => {
  const worker = createWorker()
  await worker.lifecycle('install'); await worker.lifecycle('activate')
  const before = worker.calls.length
  const puts = worker.storage.puts.length
  for (const url of ['./?hostname=127.0.0.1&secret=fixture', 'index.html?secret=fixture']) {
    const result = await worker.request(url, { navigation: true })
    assert.equal(result.intercepted, true)
    assert.match(await result.response.text(), /MIBoard a/)
  }
  assert.equal((await worker.request('unexpected-page?secret=fixture', { navigation: true })).intercepted, false)
  assert.equal(worker.calls.length, before)
  assert.equal(worker.storage.puts.length, puts, 'Navigation never writes request URLs to a cache')
  for (const name of await worker.storage.keys()) {
    const keys = await (await worker.storage.open(name)).keys()
    assert(keys.every(request => !new URL(request.url).search && !request.url.includes('fixture')))
  }
})

test('static cache hits work offline and network fallbacks never become runtime cache entries', async () => {
  const worker = createWorker()
  await worker.lifecycle('install'); await worker.lifecycle('activate')
  const puts = worker.storage.puts.length
  const before = worker.calls.length
  const cached = await worker.request('assets/app-a.js')
  assert.equal(cached.intercepted, true)
  assert.equal(await cached.response.text(), "console.log('a')")
  assert.equal(worker.calls.length, before)
  const unknown = await worker.request('assets/unknown.js')
  assert.equal(unknown.intercepted, true)
  assert.equal(unknown.response.status, 404)
  assert.equal(worker.calls.length, before + 1)
  assert.equal(worker.storage.puts.length, puts)
  assert.equal(await (await worker.storage.open(cacheName(worker.scope, worker.id))).match(new URL('assets/unknown.js', worker.scope).href), undefined)
})

test('corrupt, redirected, missing and failed downloads remove only the failed install and preserve active A', async () => {
  for (const failure of ['hash', 'redirect', 'missing', 'network']) {
    const storage = new MemoryCacheStorage()
    const a = createWorker({ storage })
    await a.lifecycle('install'); await a.lifecycle('activate')
    const before = new Set(await storage.keys())
    const update = createWorker({ id: 'bbbbbbbbbbbbbbbb', storage, network(url, _request, files) {
      if (url.endsWith('app-b.js')) {
        if (failure === 'network') throw new Error('Fixture network failure')
        if (failure === 'missing') return new Response('Not found', { status: 404 })
        const response = new Response(failure === 'hash' ? 'Partial deployment' : files.get(url))
        if (failure === 'redirect') Object.defineProperty(response, 'redirected', { value: true })
        return response
      }
      return new Response(files.get(url))
    } })
    await assert.rejects(update.lifecycle('install'), /cache|deployment|Fixture/)
    assert.deepEqual(new Set(await storage.keys()), before, failure)
    const index = await (await storage.open(cacheName(a.scope, a.id))).match(new URL('index.html', a.scope).href)
    assert.match(await index.text(), /MIBoard a/)
    assert.equal(update.skipped, 0)
    assert.equal(update.claimed, 0)
  }
})

test('failed installation settles in-flight downloads before cleanup and never starts another batch', async () => {
  const storage = new MemoryCacheStorage()
  const a = createWorker({ storage })
  await a.lifecycle('install'); await a.lifecycle('activate')
  let finishSlow
  const slow = new Promise(resolve => { finishSlow = resolve })
  const files = new Map([
    ['index.html', Buffer.from('new index')], ['assets/broken.js', Buffer.from('expected bytes')],
    ['assets/fast.js', Buffer.from('fast')], ['assets/slow.js', Buffer.from('slow')],
    ['assets/never-requested.js', Buffer.from('next batch')],
  ])
  const worker = createWorker({ id: 'bbbbbbbbbbbbbbbb', storage, files, async network(url, _request, available) {
    if (url.endsWith('/broken.js')) return new Response('Missing deployment asset', { status: 404 })
    if (url.endsWith('/slow.js')) await slow
    return new Response(available.get(url))
  } })
  let settled = false
  const installed = worker.lifecycle('install')
  const rejected = assert.rejects(installed, /Cannot cache/)
  installed.then(() => { settled = true }, () => { settled = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(worker.calls.length, 4)
    assert.equal(settled, false, 'Installation waits for the pending sibling download instead of abandoning it')
  } finally { finishSlow() }
  await rejected
  assert.equal(worker.calls.length, 4, 'A failed batch cannot schedule later assets')
  assert.deepEqual(new Set(await storage.keys()), new Set([cacheName(a.scope, a.id), stateName(a.scope, a.id)]))
})
