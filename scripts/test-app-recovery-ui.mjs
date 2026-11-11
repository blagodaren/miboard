import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, readdir, mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { stubAppUpdates } from './app-update-fixture.mjs'

const dist = new URL('../dist/', import.meta.url)
const files = new Map()
async function readTree(base, prefix = '') {
  for (const entry of await readdir(base, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) await readTree(new URL(entry.name + '/', base), name + '/')
    else files.set(name, await readFile(new URL(entry.name, base)))
  }
}
await readTree(dist)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const fixtures = {
  '/controller/version': { version: '1.19.15-fixture', meta: true },
  '/controller/configs': { mode: 'rule', 'log-level': 'info', 'mixed-port': 7890, 'allow-lan': false, ipv6: false, tun: { enable: false, stack: 'system' } },
  '/controller/proxies': { proxies: {} },
  '/controller/providers/proxies': { providers: {} },
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (fixtures[url.pathname]) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixtures[url.pathname]))
  const name = url.pathname.replace(/^\/miboard\//, '') || 'index.html'
  const bytes = files.get(name)
  if (!bytes) return res.writeHead(404).end('Not found')
  res.writeHead(200, { 'Content-Type': types[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(bytes)
})
const sockets = new WebSocketServer({ server })
sockets.on('connection', (socket, req) => {
  const endpoint = new URL(req.url, 'http://localhost').pathname.split('/').pop()
  const value = endpoint === 'connections' ? { connections: [], uploadTotal: 0, downloadTotal: 0 }
    : endpoint === 'memory' ? { inuse: 0 } : { up: 0, down: 0 }
  const send = () => { if (socket.readyState === 1) socket.send(JSON.stringify(value)) }
  send()
  const timer = setInterval(send, 1000)
  socket.on('close', () => clearInterval(timer))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-recovery-'))
let browser
const errors = []
async function session(locale = 'en') {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale }) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin + '/controller', secret: '' }))
  }, { origin, locale })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  return { context, page }
}
async function go(page, route) { await page.evaluate(route => { location.hash = '/' + route }, route) }
try {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'A Chromium browser is available')
  const { context, page } = await session()
  const initialScripts = new Set()
  page.on('request', req => { if (req.resourceType() === 'script') initialScripts.add(new URL(req.url()).pathname.replace('/miboard/', '')) })
  await page.goto(`${origin}/miboard/#/setup`)
  await page.locator('#backend-url').waitFor()
  assert(![...initialScripts].some(name => /\/(Overview|Geography|Devices|Proxies|Connections|Rules|Logs|Settings)-/.test(name)), 'Setup does not load the other pages')
  const startupBytes = [...initialScripts].reduce((sum, name) => sum + (files.get(name)?.length ?? 0), 0)
  const startupGzipBytes = [...initialScripts].reduce((sum, name) => sum + (files.has(name) ? gzipSync(files.get(name)).length : 0), 0)
  assert(startupBytes < 600_000, `Setup JavaScript stays below 600 kB, got ${startupBytes}`)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor()

  // A throwing page component must preserve navigation, hide raw error data,
  // and mount again when the user selects Retry.
  await page.route('**/Geography-*.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export default function(anchor) {
      if (!globalThis.__renderRetried) { globalThis.__renderRetried = true; throw new Error('private-fixture-secret'); }
      const title = document.createElement('h1'); title.textContent = 'Recovered page'; anchor.before(title);
    }
  ` }))
  await go(page, 'geography')
  const recovery = page.getByTestId('page-recovery')
  await recovery.getByRole('heading', { name: 'This page stopped working' }).waitFor()
  assert(await page.getByRole('navigation').first().isVisible(), 'The shell survives a page render failure')
  assert(!(await page.locator('body').innerText()).includes('private-fixture-secret'))
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Recovery has no overflow at ${width}/${colorScheme}`)
      await page.screenshot({ path: path.join(screenshots, `render-${colorScheme}-${width}.png`), fullPage: true })
    }
  }
  await recovery.getByRole('button', { name: 'Try again' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Recovered page' }).waitFor()
  await go(page, 'logs')
  await page.getByRole('heading', { name: 'Logs', exact: true }).waitFor()
  await page.evaluate(() => dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new DOMException('cancelled', 'AbortError') })))
  assert.equal(await page.getByTestId('unexpected-error').count(), 0, 'Cancellation is silent')
  await page.evaluate(() => dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: new Error('private-fixture-secret') })))
  await page.getByTestId('unexpected-error').waitFor()
  assert(!(await page.getByTestId('unexpected-error').innerText()).includes('private-fixture-secret'))
  await context.close()

  // A network failure is distinct from a render failure. Reload remains available
  // even when the browser caches a failed module evaluation for this document.
  const failed = await session('ru')
  await failed.page.route('**/Geography-*.js', route => route.abort('failed'))
  await failed.page.goto(`${origin}/miboard/#/geography`)
  await failed.page.getByRole('heading', { name: 'Не удалось загрузить страницу' }).waitFor()
  await Promise.all([
    failed.page.waitForEvent('load'),
    failed.page.getByRole('button', { name: 'Перезагрузить панель' }).click(),
  ])
  await failed.page.getByRole('heading', { name: 'Не удалось загрузить страницу' }).waitFor()
  await failed.page.unroute('**/Geography-*.js')
  await failed.page.getByRole('button', { name: 'Перезагрузить панель' }).click()
  await failed.page.getByRole('heading', { name: 'География', exact: true }).waitFor()
  await failed.context.close()

  // Vite remembers failed CSS preloads within a document. A full reload must
  // retry the stylesheet too, rather than rendering an unstyled page.
  const css = await session()
  let cssReads = 0
  await css.page.route('**/Geography-*.css', route => {
    cssReads++
    return cssReads === 1 ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue()
  })
  await css.page.goto(`${origin}/miboard/#/geography`)
  await css.page.getByRole('heading', { name: 'Could not load this page' }).waitFor()
  await css.page.getByRole('button', { name: 'Reload app' }).click()
  await css.page.getByRole('heading', { name: 'Geography', exact: true }).waitFor()
  assert.equal(cssReads, 2, 'Reload retries a failed CSS preload')
  assert(await css.page.evaluate(() => [...document.styleSheets].some(sheet => /\/Geography-.*\.css$/.test(sheet.href ?? ''))), 'Map stylesheet is loaded')
  await css.context.close()

  // The outer boundary also recovers failures in the shared shell, both during
  // its first render and a later reactive update. Faults are confined to tests.
  for (const phase of ['mount', 'update']) {
    const shell = await session()
    await shell.context.addInitScript(phase => {
      window.__failNavigation = phase === 'mount'
      const setAttribute = Element.prototype.setAttribute
      Element.prototype.setAttribute = function(name, value) {
        if (window.__failNavigation && this.tagName === 'NAV' && name === 'aria-label') {
          window.__failNavigation = false
          throw new Error('private-fixture-secret')
        }
        return setAttribute.call(this, name, value)
      }
    }, phase)
    await shell.page.goto(`${origin}/miboard/#/${phase === 'mount' ? 'overview' : 'settings'}`)
    if (phase === 'update') {
      await shell.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
      await shell.page.evaluate(() => { window.__failNavigation = true })
      await shell.page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
    }
    await shell.page.getByTestId('page-recovery').waitFor()
    assert.equal(await shell.page.getByRole('navigation').count(), 0, 'A shell failure reaches the outer boundary')
    assert(!(await shell.page.locator('body').innerText()).includes('private-fixture-secret'))
    await shell.page.getByRole('button', { name: /^(Try again|Попробовать снова)$/ }).click()
    await shell.page.getByRole('heading', { name: phase === 'mount' ? 'Overview' : 'Настройки', exact: true }).waitFor()
    await shell.context.close()
  }

  // A late import from the previous route cannot replace the current screen.
  const rapid = await session()
  let releaseImport
  const held = new Promise(resolve => { releaseImport = resolve })
  let startedImport
  const started = new Promise(resolve => { startedImport = resolve })
  await rapid.page.route('**/Geography-*.js', async route => { startedImport(); await held; await route.continue() })
  await rapid.page.goto(`${origin}/miboard/#/geography`)
  await started
  await go(rapid.page, 'logs')
  await rapid.page.getByRole('heading', { name: 'Logs', exact: true }).waitFor()
  const loaded = rapid.page.waitForResponse(response => /\/Geography-.*\.js$/.test(response.url()))
  releaseImport()
  await loaded
  await rapid.page.waitForTimeout(100)
  assert(await rapid.page.getByRole('heading', { name: 'Logs', exact: true }).isVisible(), 'Late route result is ignored')
  await rapid.context.close()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Lazy routes and error recovery passed', startupBytes, startupGzipBytes, screenshots }))
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error(JSON.stringify({ url: page.url(), errors, body: (await page.locator('body').innerText()).slice(0, 2500) }))
    await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true })
  }
  throw error
} finally {
  await browser?.close()
  for (const client of sockets.clients) client.terminate()
  await new Promise(resolve => sockets.close(resolve))
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
