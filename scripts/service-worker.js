/* VERSION and STATIC_FILES are injected by pwa-build.mjs. */
const BASE = new URL(self.registration.scope)
const PREFIX = `miboard-static:${BASE.pathname}:`
const ACTIVE_PREFIX = PREFIX + 'active:'
const CACHE = PREFIX + VERSION.buildId
const INDEX = new URL('index.html', BASE).href
const ASSETS = new Set(STATIC_FILES.map(file => new URL(file.path, BASE).href))

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    try {
      // Hash checks reject partial deployments and HTML fallbacks for missing files.
      // A failed update leaves the previous active worker and its cache intact.
      for (let offset = 0; offset < STATIC_FILES.length; offset += 4) {
        const results = await Promise.allSettled(STATIC_FILES.slice(offset, offset + 4).map(async file => {
          const url = new URL(file.path, BASE).href
          const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }))
          if (!response.ok || response.redirected) throw new Error(`Cannot cache ${file.path}`)
          const bytes = await response.clone().arrayBuffer()
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map(byte => byte.toString(16).padStart(2, '0')).join('')
          if (hash !== file.sha256) throw new Error(`Incomplete deployment: ${file.path}`)
          await cache.put(url, response)
        }))
        const failed = results.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
      }
    } catch (error) {
      await caches.delete(CACHE)
      throw error
    }
    // An update waits for an explicit user action. First installation activates normally.
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    const previousActive = names.filter(name => name.startsWith(ACTIVE_PREFIX)).at(-1)?.slice(ACTIVE_PREFIX.length)
    const keep = new Set([CACHE, PREFIX + previousActive])
    // An empty cache records the active generation. A newer waiting worker must not
    // replace the previous *active* generation retained for other still-open tabs.
    await caches.open(ACTIVE_PREFIX + VERSION.buildId)
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && !keep.has(name) && name !== ACTIVE_PREFIX + VERSION.buildId)
      .map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', event => {
  if (event.data?.type === 'GET_VERSION') event.ports[0]?.postMessage(VERSION)
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || request.headers.has('authorization') || request.headers.has('range')) return
  const url = new URL(request.url)
  if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname)) return
  const navigation = request.mode === 'navigate' && (url.pathname === BASE.pathname || url.href.split('?')[0] === INDEX)
  const previousAsset = url.pathname.startsWith(new URL('assets/', BASE).pathname)
  // Navigation uses a clean index key; secret-bearing connection URLs are never stored.
  // All other query strings, version checks, API calls and cross-origin requests bypass SW.
  if (!navigation && (url.search || url.hash || (!ASSETS.has(url.href) && !previousAsset))) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const cached = await cache.match(navigation ? INDEX : url.href)
    if (cached) return cached
    if (previousAsset) {
      for (const name of (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE)) {
        const previous = await (await caches.open(name)).match(url.href)
        if (previous) return previous
      }
    }
    return fetch(request)
  })())
})
