import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir, mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const dist = new URL('../dist/', import.meta.url)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = new Map()
async function readTree(base, prefix = '') {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await readTree(new URL(entry.name + '/', base), name + '/')
    else files.set(name, await readFile(new URL(entry.name, base)))
  }
}
await readTree(dist)
const original = JSON.parse(files.get('version.json'))
const next = { ...original, buildId: digest(`${original.buildId}:ui-test`).slice(0, 16) }
const nextFiles = new Map(files)
nextFiles.set('index.html', Buffer.from(files.get('index.html').toString().replace('</head>', '<meta name="pwa-test-build" content="updated"></head>')))
nextFiles.set('version.json', Buffer.from(JSON.stringify(next)))
const nextAssets = [...nextFiles].filter(([name]) => !['sw.js', 'version.json'].includes(name))
  .map(([name, bytes]) => ({ path: name, sha256: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path))
nextFiles.set('sw.js', Buffer.from(files.get('sw.js').toString()
  .replace(/^const VERSION = .*;$/m, `const VERSION = ${JSON.stringify(next)};`)
  .replace(/^const STATIC_FILES = .*;$/m, `const STATIC_FILES = ${JSON.stringify(nextAssets)};`)))

const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
let stage = 'original'
let networkRequests = []
const prefixes = ['/ui/custom/', '/miboard/', '/']
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  networkRequests.push({ path: url.pathname, search: url.search, authorization: !!req.headers.authorization })
  if (url.pathname.startsWith('/controller/')) {
    const fixtures = {
      '/controller/version': { version: '1.19.15-fixture', meta: true },
      '/controller/configs': { mode: 'rule', 'log-level': 'info', 'mixed-port': 7890, 'allow-lan': false, ipv6: false, tun: { enable: false, stack: 'system' } },
      '/controller/proxies': { proxies: {} },
      '/controller/providers/proxies': { providers: {} },
    }
    const fixture = fixtures[url.pathname]
    res.writeHead(fixture ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture ?? { message: 'Fixture endpoint unavailable' }))
    return
  }
  if (url.pathname.endsWith('/api-fixture')) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"secret":"fixture-api-response"}')
    return
  }
  const prefix = prefixes.find(prefix => url.pathname.startsWith(prefix))
  const name = url.pathname.slice(prefix.length) || 'index.html'
  let bytes = (stage === 'original' ? files : nextFiles).get(name)
  if (stage === 'broken' && name === 'index.html') bytes = Buffer.from('<h1>Partial deployment</h1>')
  if (!bytes) { res.writeHead(404).end('Not found'); return }
  res.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(bytes)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-pwa-'))
let browser
let context
const errors = []
const socketTimers = new Set()
async function poll(check, name, timeout = 15000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 60)) } while (Date.now() < end)
  throw new Error(`Timed out: ${name}`)
}
async function workerVersion(page) {
  return page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.getRegistration())?.active
    if (!worker) return null
    return new Promise(resolve => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(null), 2000)
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data) }
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2])
    })
  })
}
try {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'miboard-pwa-browser-'))
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      context = await chromium.launchPersistentContext(profile, { headless: true, ...options,
        viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
      browser = context.browser()
      break
    } catch { /* Installed browser fallback. */ }
  }
  assert(context, 'A Chromium browser is available')
  await context.addInitScript(() => { if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en') })
  let releaseVersion = original.version
  let releaseFailure = false
  let releaseRequests = 0
  await context.route('https://api.github.com/repos/blagodaren/miboard/releases/latest', async route => {
    releaseRequests++
    if (releaseFailure === 'rate') return route.fulfill({ status: 403,
      headers: { 'X-RateLimit-Remaining': '0', 'Access-Control-Expose-Headers': 'X-RateLimit-Remaining' },
      json: { message: 'API rate limit exceeded' } })
    if (releaseFailure) return route.fulfill({ status: 403, json: { message: 'rate limit' } })
    await route.fulfill({ json: { tag_name: `v${releaseVersion}`, html_url: `https://github.com/blagodaren/miboard/releases/tag/v${releaseVersion}`, draft: false, prerelease: false } })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  const scope = '/miboard/'
  await page.goto(`${origin}${scope}#/settings`)
  await page.getByTestId('app-settings').waitFor()
  await poll(async () => (await workerVersion(page))?.buildId === original.buildId, 'first worker activation')
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await poll(async () => /available offline|ready offline|saved|offline launch/i.test(await page.getByTestId('pwa-offline').innerText()), 'offline readiness')
  const cdp = await context.newCDPSession(page)
  const manifest = await cdp.send('Page.getAppManifest')
  assert.equal(manifest.errors.length, 0, 'Browser parses manifest without errors')
  assert.equal(new URL(manifest.url).pathname, `${scope}manifest.webmanifest`)
  assert.equal(JSON.parse(manifest.data).display, 'standalone')
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'Chrome considers the application installable')

  // A controlled page must never cache API requests, secrets or update metadata.
  await page.evaluate(async () => {
    await fetch('./api-fixture?token=fixture-token', { headers: { Authorization: 'Bearer fixture-header' } })
    await fetch('./version.json', { cache: 'no-store' })
    await fetch('./favicon.svg?secret=fixture-query')
  })
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys()
    return (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat()
  })
  assert(cached.some(url => url.endsWith('/index.html')))
  assert(!cached.some(url => /(?:api-fixture|version\.json|sw\.js|[?#])/.test(url)), 'Only clean static asset keys enter the cache')
  assert(networkRequests.some(request => request.path.endsWith('/api-fixture') && request.authorization))

  await context.setOffline(true)
  await page.reload()
  await page.getByTestId('app-settings').waitFor()
  await poll(async () => /saved/i.test(await page.getByTestId('pwa-offline').innerText()), 'offline readiness survives a disconnected restart')
  assert.match(await page.getByTestId('app-settings').innerText(), new RegExp(original.version.replaceAll('.', '\\.')))
  await page.goto(`${origin}${scope}?secret=fixture-link#/settings`)
  await page.getByTestId('app-settings').waitFor()
  assert.equal(new URL(page.url()).search, '', 'Connection credentials are removed even after an offline navigation')
  const secretKeys = await page.evaluate(async () => {
    const urls = (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat()
    return urls.filter(url => new URL(url).search)
  })
  assert.deepEqual(secretKeys, [], 'Offline navigation never stores credential-bearing URLs')
  await context.setOffline(false)

  // Install UI consumes the browser event only in response to a user click.
  await page.evaluate(() => {
    window.__installCalls = 0
    const event = new Event('beforeinstallprompt', { cancelable: true })
    event.prompt = async () => { window.__installCalls++; return { outcome: 'accepted', platform: 'web' } }
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' })
    dispatchEvent(event)
  })
  await page.getByTestId('pwa-install').click()
  assert.equal(await page.evaluate(() => window.__installCalls), 1)
  await page.evaluate(() => dispatchEvent(new Event('appinstalled')))
  await page.getByTestId('pwa-installed').waitFor()

  releaseVersion = '99.0.0'
  await page.getByTestId('pwa-check').click()
  await page.getByTestId('pwa-release').waitFor()
  assert.match(await page.getByTestId('pwa-release').getAttribute('href'), /releases\/tag\/v99\.0\.0$/)
  assert.equal(await page.getByTestId('pwa-apply').count(), 0, 'An upstream release alone is not an applicable host update')
  releaseFailure = true
  await page.getByTestId('pwa-check').click()
  await poll(async () => /could not finish/i.test(await page.getByTestId('app-settings').innerText()), 'honest check error')
  releaseFailure = false

  // Simulate a truncated deployment: a changed worker must never replace the good cache.
  stage = 'broken'
  await page.getByTestId('pwa-check').click()
  await poll(async () => await page.getByTestId('pwa-check').isEnabled(), 'broken update check completes', 25000)
  await poll(async () => await page.evaluate(async () => !(await navigator.serviceWorker.getRegistration())?.installing), 'broken update finishes')
  assert.equal((await workerVersion(page)).buildId, original.buildId)
  assert.equal(await page.getByTestId('pwa-apply').count(), 0)

  const other = await context.newPage()
  await other.goto(`${origin}${scope}#/settings`)
  await other.getByTestId('app-settings').waitFor()
  await other.evaluate(() => { window.__keptTab = true })
  await page.evaluate(() => { window.__keptTab = true })
  stage = 'updated'
  await page.getByTestId('pwa-check').click()
  await page.getByTestId('pwa-apply').waitFor()
  assert.equal(await page.evaluate(() => window.__keptTab), true, 'Waiting update never reloads the current page')
  assert.equal(await page.locator('meta[name="pwa-test-build"]').count(), 0)

  for (const locale of ['en', 'ru']) {
    await page.getByRole('combobox', { name: /^(Language|Язык)$/ }).selectOption(locale)
    for (const scheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 })
        await page.getByTestId('app-settings').scrollIntoViewIfNeeded()
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${locale}/${scheme}/${width}`)
        await page.screenshot({ path: path.join(screenshots, `${locale}-${scheme}-${width}.png`), fullPage: true })
      }
    }
  }
  releaseFailure = 'rate'
  await page.getByTestId('pwa-check').click()
  await poll(async () => /GitHub.*(?:ограничил|limited)/i.test(await page.getByTestId('app-settings').innerText()), 'specific GitHub rate-limit feedback')
  assert(await page.getByTestId('pwa-apply').isEnabled(), 'GitHub rate limit does not block a prepared local update')
  await page.getByTestId('pwa-apply').click()
  await page.waitForFunction(() => document.querySelector('meta[name="pwa-test-build"]')?.getAttribute('content') === 'updated')
  assert.equal((await workerVersion(page)).buildId, next.buildId)
  assert.equal(await other.evaluate(() => window.__keptTab), true, 'Applying in one tab does not reload another')

  // Root, GitHub Pages and named external-ui deployments each keep their own scope/cache.
  stage = 'original'
  for (const prefix of ['/', '/ui/custom/']) {
    const scoped = await context.newPage()
    await scoped.goto(`${origin}${prefix}#/setup`)
    await poll(async () => await scoped.evaluate(async prefix => {
      const registration = await navigator.serviceWorker.getRegistration()
      return registration?.active?.state === 'activated' && new URL(registration.scope).pathname === prefix
    }, prefix), `${prefix} worker active`)
    assert.equal(await scoped.evaluate(async () => new URL((await navigator.serviceWorker.getRegistration()).scope).pathname), prefix)
    await context.setOffline(true)
    await scoped.reload()
    await scoped.locator('input#backend-url').waitFor()
    await context.setOffline(false)
    await scoped.close()
  }
  const cacheNames = await page.evaluate(() => caches.keys())
  assert(cacheNames.some(name => name.startsWith('miboard-static:/:')))
  assert(cacheNames.some(name => name.startsWith('miboard-static:/miboard/:')))
  assert(cacheNames.some(name => name.startsWith('miboard-static:/ui/custom/:')))

  // Use a connected dashboard to verify the toast opens the actual maintenance
  // category, rather than merely preserving a hash on the standalone setup page.
  releaseFailure = false
  await page.evaluate(origin => localStorage.setItem('miboard.backend', JSON.stringify({ url: `${origin}/controller`, secret: '' })), origin)
  const settingsPage = await context.newPage()
  settingsPage.on('pageerror', error => errors.push(error.message))
  await settingsPage.routeWebSocket(/\/controller\/(traffic|connections|memory)(?:\?|$)/, socket => {
    const name = new URL(socket.url()).pathname.split('/').pop()
    const value = name === 'connections' ? { connections: [], uploadTotal: 0, downloadTotal: 0 } : name === 'memory' ? { inuse: 0 } : { up: 0, down: 0 }
    const send = () => socket.send(JSON.stringify(value))
    send()
    const timer = setInterval(send, 1000)
    timer.unref()
    socketTimers.add(timer)
    socket.onClose(() => { clearInterval(timer); socketTimers.delete(timer) })
  })
  await settingsPage.goto(`${origin}${scope}#/settings?category=appearance`)
  await settingsPage.getByTestId('settings-category-panel-appearance').waitFor()
  await chooseSettingsCategory(settingsPage, 'maintenance')
  await settingsPage.getByTestId('pwa-check').click()
  const updateAction = settingsPage.getByTestId('pwa-check-result').getByRole('link')
  await updateAction.waitFor()
  await chooseSettingsCategory(settingsPage, 'appearance')
  await updateAction.click()
  await settingsPage.waitForURL(url => url.hash === '#/settings?category=maintenance')
  await settingsPage.getByTestId('settings-category-panel-maintenance').waitFor()
  assert(await settingsPage.getByTestId('pwa-check').isVisible(), 'Update action reveals the app update control')
  assert.equal(await settingsPage.getByTestId('settings-category-panel-appearance').isVisible(), false)
  await settingsPage.close()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'PWA UI passed', scopes: prefixes, releaseRequests, screenshots }))
  await context.close()
} finally {
  for (const timer of socketTimers) clearInterval(timer)
  socketTimers.clear()
  await context?.close()
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
