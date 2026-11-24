import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFile, readdir } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const scope = '/controller/ui/miboard/'
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
const installed = JSON.parse(files.get('version.json'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const next = { version: '99.0.0', buildId: digest(`${installed.buildId}:hosted-update`).slice(0, 16) }
const nextFiles = new Map(files)
nextFiles.set('index.html', Buffer.from(files.get('index.html').toString()
  .replace('</head>', '<meta name="hosted-update-fixture" content="updated"></head>')))
nextFiles.set('version.json', Buffer.from(JSON.stringify(next)))
const nextAssets = [...nextFiles]
  .filter(([name]) => name !== 'sw.js' && name !== 'version.json')
  .map(([name, bytes]) => ({ path: name, sha256: digest(bytes) }))
  .sort((a, b) => a.path.localeCompare(b.path))
nextFiles.set('sw.js', Buffer.from(files.get('sw.js').toString()
  .replace(/^const VERSION = .*;$/m, `const VERSION = ${JSON.stringify(next)};`)
  .replace(/^const STATIC_FILES = .*;$/m, `const STATIC_FILES = ${JSON.stringify(nextAssets)};`)))

const formats = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const fixtures = {
  version: { version: '1.19.15-fixture', meta: true },
  configs: { mode: 'rule', 'log-level': 'info', 'mixed-port': 7890, 'allow-lan': false, ipv6: false, tun: { enable: false, stack: 'system' } },
  proxies: { proxies: {} },
  'providers/proxies': { providers: {} },
}
const secret = 'hosted-update-test-secret'
const posts = []
let upgradeMode = 'reject'
let published = false
let staleReadsAfterPost = 0

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

const server = http.createServer(async (req, res) => {
  const { pathname, search } = new URL(req.url, 'http://localhost')
  const prefix = [scope, '/miboard/'].find(value => pathname.startsWith(value))
  if (prefix) {
    const name = pathname.slice(prefix.length) || 'index.html'
    if (prefix === scope && name === 'version.json' && upgradeMode === 'hold' && posts.length >= 2 && !published) {
      staleReadsAfterPost++
    }
    const bytes = (published ? nextFiles : files).get(name)
    if (!bytes) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': formats[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    return res.end(bytes)
  }
  const controller = ['/controller/', '/other/'].find(value => pathname.startsWith(value))
  if (!controller) return res.writeHead(404).end()
  if (req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { message: 'Invalid fixture secret' })
  const name = pathname.slice(controller.length)
  if (name === 'upgrade/ui' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    posts.push({ pathname, search, authorization: req.headers.authorization, body })
    if (upgradeMode === 'reject') return json(res, 500, { message: 'Fixture download failed' })
    if (upgradeMode === 'publish') published = true
    return json(res, 200, { status: 'ok' })
  }
  return fixtures[name] ? json(res, 200, fixtures[name]) : json(res, 404, { message: 'Fixture endpoint unavailable' })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
let releaseVersion = installed.version
let browser
const errors = []

async function poll(check, label) {
  const deadline = Date.now() + 15000
  do {
    if (await check()) return
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

async function openPanel(prefix, controller, withWorker = false) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: withWorker ? 'allow' : 'block',
    reducedMotion: 'reduce',
  })
  await context.addInitScript(({ backend, secret, withWorker }) => {
    localStorage.setItem('miboard.locale', 'en')
    localStorage.setItem('miboard.backend', JSON.stringify({ url: backend, secret }))
    if (!withWorker) Object.defineProperty(window, 'isSecureContext', { value: false })
  }, { backend: `${origin}${controller}`, secret, withWorker })
  await context.route('https://api.github.com/repos/blagodaren/miboard/releases/latest', route => {
    const release = `v${releaseVersion}`
    return route.fulfill({
      json: {
        tag_name: release,
        html_url: `https://github.com/blagodaren/miboard/releases/tag/${release}`,
        draft: false,
        prerelease: false,
        assets: ['dist.zip', 'dist-cdn-fonts.zip'].map(name => ({
          name,
          browser_download_url: `https://github.com/blagodaren/miboard/releases/download/${release}/${name}`,
        })),
      },
    })
  })
  await context.routeWebSocket(/\/(?:controller|other)\/(?:traffic|connections|memory)(?:\?|$)/, socket => {
    const name = new URL(socket.url()).pathname.split('/').at(-1)
    const value = name === 'connections' ? { connections: [], uploadTotal: 0, downloadTotal: 0 }
      : name === 'memory' ? { inuse: 0 } : { up: 0, down: 0 }
    socket.send(JSON.stringify(value))
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}${prefix}#/settings?category=maintenance`)
  await page.getByTestId('app-settings').waitFor()
  return { context, page }
}

async function confirm(page) {
  const dialog = page.getByRole('alertdialog')
  await dialog.getByRole('button').filter({ hasNotText: /^Cancel$/ }).click()
}

try {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break }
    catch { /* Try an installed Chromium browser when Playwright's binary is unavailable. */ }
  }
  assert(browser, 'A Chromium browser is available')

  releaseVersion = next.version
  for (const [prefix, controller] of [['/miboard/', '/controller'], [scope, '/other']]) {
    const { context, page } = await openPanel(prefix, controller)
    await page.getByTestId('pwa-release').waitFor()
    assert.equal(await page.getByTestId('pwa-hosted-update').count(), 0)
    assert.equal(await page.getByTestId('pwa-hosted-auto').count(), 0)
    await context.close()
  }
  assert.equal(posts.length, 0, 'An unrelated controller or web installation never receives a mutation')

  const manual = await openPanel(scope, '/controller')
  const update = manual.page.getByTestId('pwa-hosted-update')
  await update.click()
  await manual.page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  assert.equal(posts.length, 0, 'Cancelling the confirmation leaves the controller untouched')

  await update.click()
  await confirm(manual.page)
  const status = manual.page.getByTestId('pwa-hosted-status')
  await status.waitFor()
  await poll(async () => posts.length === 1 && await update.isEnabled(), 'failed request is recoverable')
  assert.match(await status.innerText(), /(?:fail|could not|unable)/i, 'The failed update is visible')
  assert.equal(await manual.page.locator('meta[name="hosted-update-fixture"]').count(), 0)

  upgradeMode = 'hold'
  await manual.page.evaluate(() => { window.hostedUpdateFixtureTab = true })
  await update.click()
  await confirm(manual.page)
  await poll(() => staleReadsAfterPost > 0, 'deployment verification sees the old build after POST')
  assert.equal(await manual.page.evaluate(() => window.hostedUpdateFixtureTab), true, 'A successful POST alone cannot reload the UI')
  published = true
  await manual.page.locator('meta[name="hosted-update-fixture"]').waitFor({ state: 'attached' })
  assert.equal(posts.length, 2, 'The retry issues one POST')
  await manual.context.close()

  published = false
  releaseVersion = installed.version
  upgradeMode = 'publish'
  const automatic = await openPanel(scope, '/controller', true)
  await automatic.page.waitForFunction(() => !!navigator.serviceWorker.controller)
  const settings = automatic.page.getByTestId('app-settings')
  assert.equal(await settings.getByTestId('pwa-hosted-update').count(), 0, 'The current stable release needs no upgrade')
  const auto = settings.getByTestId('pwa-hosted-auto')
  assert.equal(await auto.getAttribute('aria-checked'), 'false', 'Automatic downloads are off by default')
  await auto.click()
  await automatic.page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await auto.getAttribute('aria-checked'), 'false', 'Cancelling leaves automatic downloads off')
  await auto.click()
  await confirm(automatic.page)
  await poll(async () => await auto.getAttribute('aria-checked') === 'true', 'consent enables automatic downloads')
  await automatic.page.evaluate(() => { window.hostedUpdateFixtureTab = true })
  releaseVersion = next.version
  await settings.getByTestId('pwa-check').click()
  await settings.getByTestId('pwa-apply').waitFor()
  assert.equal(await automatic.page.evaluate(() => window.hostedUpdateFixtureTab), true, 'Automatic updates prepare a worker without reloading the tab')
  assert.equal(await automatic.page.locator('meta[name="hosted-update-fixture"]').count(), 0)
  assert.equal(posts.length, 3, 'Automatic update sends exactly one request for the new version')
  await settings.getByTestId('pwa-apply').click()
  await automatic.page.locator('meta[name="hosted-update-fixture"]').waitFor({ state: 'attached' })
  assert.equal(await auto.getAttribute('aria-checked'), 'true', 'Consent survives reload for this installation')
  await automatic.context.close()

  assert.deepEqual(posts, Array.from({ length: 3 }, () => ({
    pathname: '/controller/upgrade/ui', search: '', authorization: `Bearer ${secret}`, body: '',
  })))
  assert.deepEqual(errors, [])
  console.log('PASS hosted dashboard update confirmation, verified reload, controller scope, and background preparation')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
