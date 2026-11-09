// Fresh browser contexts and a private mock: never read the user's controller or local storage.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = await mkdtemp(path.join(os.tmpdir(), 'miboard-settings-transfer-'))
const errors = []
const external = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser
let mock
let output = ''
let origin
let base
async function poll(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(50) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No Chrome/Edge browser available')
}
const storage = page => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])))
const file = (page, object, name = 'miboard-settings.json') => page.getByTestId('settings-transfer').getByLabel(/Choose JSON file|Выбрать JSON-файл/, { exact: true }).setInputFiles({
  name, mimeType: 'application/json', buffer: Buffer.from(typeof object === 'string' ? object : JSON.stringify(object)),
})
const documentFile = extra => ({ format: 'miboard-settings', version: 1, servers: [], deviceAliases: [], proxySort: [], preferences: {}, ...extra })
async function download(page) {
  const downloading = page.waitForEvent('download')
  await page.getByTestId('settings-transfer').getByRole('button', { name: /Export JSON|Экспорт JSON/, exact: true }).click()
  const result = await downloading
  assert.match(result.suggestedFilename(), /^miboard-settings-\d{4}-\d{2}-\d{2}\.json$/)
  const chunks = []
  for await (const chunk of await result.createReadStream()) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function open(locale = 'en', theme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: theme, reducedMotion: 'reduce', acceptDownloads: true })
  await context.addInitScript(({ origin, locale, theme }) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', theme)
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test', name: 'Current mock' }))
    localStorage.setItem('miboard.backends', JSON.stringify([
      { url: origin, secret: 'test', name: 'Current mock' },
      { url: 'https://saved.invalid', secret: 'private-export-fixture', name: 'Spare' },
    ]))
    localStorage.setItem('miboard.groups', JSON.stringify({ Main: true, Keep: false }))
    localStorage.setItem('miboard.device-names.' + encodeURIComponent(origin), JSON.stringify({ '192.168.1.10': 'Laptop', '192.168.1.20': 'Phone' }))
    localStorage.setItem('unrelated.private', 'not-portable')
  }, { origin, locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  const sockets = []
  const apiRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('websocket', socket => {
    const item = { url: socket.url(), closed: false }
    sockets.push(item)
    socket.on('close', () => { item.closed = true })
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === origin && !url.pathname.startsWith('/ui/')) apiRequests.push({ path: url.pathname, method: request.method() })
  })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (/^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      external.push(url.href)
      return route.abort()
    }
    return route.continue()
  })
  const entry = new URL(base)
  entry.hash = '/settings'
  await page.goto(entry.href)
  await page.getByRole('heading', { name: locale === 'ru' ? 'Настройки' : 'Settings', exact: true }).waitFor()
  await page.getByTestId('settings-transfer').waitFor()
  await poll(() => sockets.length >= 3, 'live streams')
  await page.evaluate(() => document.fonts.ready)
  return { page, context, sockets, apiRequests }
}
async function noOverflow(page, label) {
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(size.scroll <= size.width, `${label}: horizontal overflow ${JSON.stringify(size)}`)
}

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  base = `${origin}/ui/`
  if (process.env.MIBOARD_TRANSFER_UI_URL) {
    const entry = new URL(process.env.MIBOARD_TRANSFER_UI_URL)
    entry.hash = ''
    for (const [key, value] of Object.entries({ hostname: '127.0.0.1', port, protocol: 'http', secret: 'test' })) entry.searchParams.set(key, String(value))
    base = entry.href
  }
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  mock.stdout.on('data', chunk => { output += chunk })
  mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(`Mock stopped: ${output}`)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated mock startup')
  browser = await launch()

  const main = await open()
  const { page, context, apiRequests, sockets } = main
  const section = page.getByTestId('settings-transfer')
  const checkbox = section.getByRole('checkbox', { name: 'Include server secrets in the exported file', exact: true })
  assert.equal(await checkbox.isChecked(), false)
  const original = await storage(page)
  const exported = await download(page)
  assert.equal(exported.format, 'miboard-settings')
  assert.equal(exported.servers.length, 2)
  assert.ok(exported.servers.every(server => !Object.hasOwn(server, 'secret')))
  assert.ok(!JSON.stringify(exported).includes('not-portable'))
  assert.deepEqual(await storage(page), original)
  await checkbox.check()
  const withSecrets = await download(page)
  assert.equal(withSecrets.servers.find(server => server.url === 'https://saved.invalid').secret, 'private-export-fixture')
  await checkbox.uncheck()
  console.log('PASS: default export omits secrets, explicit opt-in includes them, no arbitrary storage exported')

  const payload = documentFile({
    servers: [{ url: origin, name: 'Imported mock' }, { url: 'https://offline.invalid', name: 'Offline profile' }],
    deviceAliases: [{ backendUrl: origin, names: { '192.168.1.10': 'Imported laptop' } }],
    proxySort: [{ backendUrl: origin, group: 'Main', key: 'name', direction: 'desc' }],
    preferences: { locale: 'ru', theme: 'dark', groups: { Main: false } },
  })
  const stable = await storage(page)
  const versionsBefore = apiRequests.filter(request => request.path === '/version').length
  const socketCount = sockets.length
  const urlBefore = page.url()
  await file(page, payload)
  const preview = page.getByTestId('transfer-preview')
  await preview.waitFor()
  assert.equal(await preview.locator('[data-count="servers"]').textContent(), '2')
  assert.equal(await preview.locator('[data-count="aliases"]').textContent(), '1')
  assert.equal(await preview.locator('[data-count="secrets"]').textContent(), '0')
  await preview.getByText('Matching server addresses: 1', { exact: true }).waitFor()
  assert.deepEqual(await storage(page), stable, 'Choosing a file must only preview')
  await noOverflow(page, 'EN preview desktop')
  await page.screenshot({ path: path.join(out, 'transfer-en-light-1440-preview.png'), fullPage: true })
  await preview.getByRole('button', { name: 'Apply import', exact: true }).click()
  await page.getByTestId('transfer-saved').waitFor()
  assert.equal(page.url(), urlBefore, 'Apply must not navigate or reload')
  const after = await storage(page)
  const profiles = JSON.parse(after['miboard.backends'])
  assert.equal(profiles.find(server => server.url === origin).secret, 'test')
  assert.equal(profiles.find(server => server.url === origin).name, 'Imported mock')
  assert.equal(profiles.find(server => server.url === 'https://offline.invalid').secret, '')
  assert.equal(profiles.find(server => server.url === 'https://saved.invalid').secret, 'private-export-fixture')
  assert.equal(JSON.parse(after['miboard.backend']).url, origin)
  assert.deepEqual(JSON.parse(after['miboard.device-names.' + encodeURIComponent(origin)]), { '192.168.1.10': 'Imported laptop', '192.168.1.20': 'Phone' })
  assert.deepEqual(JSON.parse(after['miboard.groups']), { Main: false, Keep: false })
  assert.equal(after['miboard.locale'], 'ru')
  assert.equal(after['miboard.theme'], 'dark')
  assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'Reactive preferences wait for explicit reload')
  await section.getByRole('button', { name: 'Reload dashboard', exact: true }).waitFor()
  await pause(150)
  assert.equal(sockets.length, socketCount)
  assert.ok(sockets.every(socket => !socket.closed), 'Apply must not disconnect live streams')
  assert.equal(apiRequests.filter(request => request.path === '/version').length, versionsBefore)
  assert.ok(apiRequests.every(request => request.method === 'GET'), 'Import must not reconfigure the controller')
  console.log('PASS: read-only preview, explicit merge, credentials/other entries preserved, live connection unchanged, explicit reload offered')

  await file(page, documentFile({ servers: [{ url: 'https://valid.invalid' }, { url: 'https://bad.invalid', secret: 12 }] }), 'invalid.json')
  await preview.getByRole('alert').waitFor()
  assert.equal(await preview.getByRole('button', { name: 'Apply import', exact: true }).isDisabled(), true)
  assert.deepEqual(await storage(page), after)
  await file(page, Buffer.alloc(2 * 1024 * 1024 + 1, 32).toString(), 'too-large.json')
  await section.getByRole('alert').filter({ hasText: 'The file exceeds the 2 MiB limit' }).waitFor()
  assert.deepEqual(await storage(page), after)
  await context.close()
  console.log('PASS: invalid and oversized files never apply partial imports')

  for (const [locale, theme] of [['ru', 'dark'], ['en', 'light']]) {
    const state = await open(locale, theme)
    await file(state.page, documentFile({ servers: [{ url: 'https://offline.invalid', name: 'Offline' }], preferences: { theme: 'system' } }))
    await state.page.getByTestId('transfer-preview').waitFor()
    for (const width of [390, 320]) {
      await state.page.setViewportSize({ width, height: 844 })
      await noOverflow(state.page, `${locale}/${theme}/${width}`)
      if (width === 390) await state.page.screenshot({ path: path.join(out, `transfer-${locale}-${theme}-390-preview.png`), fullPage: true })
    }
    await state.context.close()
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  console.log(`PASS: EN/RU, light/dark, desktop/390/320, no page errors or external requests\nScreenshots: ${out}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const exit = once(mock, 'exit')
    mock.kill()
    await Promise.race([exit, pause(5000)])
  }
}
