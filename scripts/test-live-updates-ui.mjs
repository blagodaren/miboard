// Own mock controller and browser profile. No traffic reaches a user's controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-live-updates-'))
let mock, browser, origin, output = ''
const errors = []
async function poll(check, name, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(50) } while (Date.now() < end)
  throw new Error(`Timed out: ${name}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No Chromium browser available')
}
async function open(locale = 'en', theme = 'light', width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale, theme }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test', name: 'Live fixture' }))
    localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme)
    // Controlled visibility events avoid depending on the headless browser's tab focus policy.
    window.__testHidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__testHidden })
  }, { origin, locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const state = { sockets: [], blocked: new Set(), mutations: [] }
  page.on('request', request => {
    if (new URL(request.url()).origin === origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) state.mutations.push(request.url())
  })
  await page.routeWebSocket(`${origin.replace('http:', 'ws:')}/**`, ws => {
    const server = ws.connectToServer()
    const record = { path: new URL(ws.url()).pathname, closed: false, forwarded: 0 }
    state.sockets.push(record)
    server.onMessage(message => {
      if (!record.closed && !state.blocked.has(record.path)) { record.forwarded++; ws.send(message) }
    })
    ws.onClose(() => { record.closed = true; void server.close().catch(() => {}) })
  })
  await page.goto(`${origin}/ui/#/settings?category=data`)
  await page.getByTestId('live-update-settings').waitFor()
  await poll(() => state.sockets.length === 3 && state.sockets.every(socket => socket.forwarded > 0), 'initial telemetry frames')
  return { context, page, state }
}
async function hidden(page, value) {
  await page.evaluate(value => { window.__testHidden = value; document.dispatchEvent(new Event('visibilitychange')) }, value)
}

try {
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()

  const { context, page, state } = await open()
  const mode = page.getByTestId('live-update-mode')
  assert.equal(await mode.getByRole('radio', { name: 'Continuous', exact: true }).getAttribute('aria-checked'), 'true')
  await hidden(page, true)
  await pause(1200)
  assert.ok(state.sockets.every(socket => !socket.closed), 'continuous mode keeps background capture')
  await hidden(page, false)
  await mode.getByRole('radio', { name: 'Economy', exact: true }).click()
  assert.equal(await page.evaluate(() => localStorage.getItem('miboard.live-update-mode')), 'eco')
  await page.getByTestId('live-update-settings').screenshot({ path: path.join(screenshots, 'economy-en-light.png') })
  await hidden(page, true)
  await poll(() => state.sockets.every(socket => socket.closed), 'eco closes all telemetry sockets')
  assert.match(await page.getByTestId('live-update-notice').textContent(), /collection is paused/i)
  assert.equal(await page.locator('aside [data-on="true"]').count(), 1, 'intentional pause is not a false offline status')
  const pausedCount = state.sockets.length
  await pause(1200)
  assert.equal(state.sockets.length, pausedCount, 'paused transports do not retry')
  await hidden(page, false)
  await poll(() => state.sockets.length === pausedCount + 3 && state.sockets.slice(pausedCount).every(socket => socket.forwarded > 0), 'eco resumes all telemetry')
  await poll(async () => /gaps in observation/.test(await page.getByTestId('live-update-notice').textContent()), 'observation gap is disclosed')
  await page.getByRole('button', { name: 'Dismiss the observation gap notice' }).click()
  assert.equal(await page.getByTestId('live-update-notice').count(), 0)
  await page.reload()
  await page.getByTestId('live-update-settings').waitFor()
  assert.equal(await mode.getByRole('radio', { name: 'Economy', exact: true }).getAttribute('aria-checked'), 'true')
  console.log('PASS: default continuous capture, explicit eco pause/resume, truthful status, persisted mode and observation gap notice')

  await mode.getByRole('radio', { name: 'Continuous', exact: true }).click()
  const trafficBefore = state.sockets.filter(socket => socket.path === '/traffic').length
  state.blocked.add('/traffic')
  await poll(() => state.sockets.filter(socket => socket.path === '/traffic').length > trafficBefore, 'silent traffic stall reconnects without close/error', 22000)
  assert.match(await page.getByTestId('live-update-notice').textContent(), /Restoring live updates/)
  assert.equal(await page.getByTestId('sidebar-download').textContent(), '—', 'stale speed is not presented as live')
  state.blocked.delete('/traffic')
  await poll(async () => (await page.getByTestId('sidebar-download').textContent()) !== '—', 'replacement stream receives data')
  await poll(async () => /gaps in observation/.test(await page.getByTestId('live-update-notice').textContent()), 'successful reconnect clears stale status')
  assert.equal(state.mutations.length, 0)
  console.log('PASS: actual browser WebSocket silent-stall watchdog, reconnect and stale speed display; no controller writes')
  await context.close()

  const mobile = await open('ru', 'dark', 320)
  await chooseSettingsCategory(mobile.page, 'data')
  await mobile.page.getByTestId('live-update-mode').getByRole('radio', { name: 'Экономно', exact: true }).click()
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await mobile.page.getByTestId('live-update-settings').screenshot({ path: path.join(screenshots, 'economy-ru-dark-320.png') })
  await mobile.page.evaluate(() => {
    const save = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'miboard.live-update-mode') throw new DOMException('Blocked for this fixture', 'SecurityError')
      return save.call(this, key, value)
    }
  })
  await mobile.page.getByTestId('live-update-mode').getByRole('radio', { name: 'Непрерывно', exact: true }).click()
  await mobile.page.getByTestId('live-update-settings').getByRole('status').filter({ hasText: 'Хранилище браузера недоступно' }).waitFor()
  await mobile.page.getByTestId('live-update-mode').getByRole('radio', { name: 'Экономно', exact: true }).click()
  await hidden(mobile.page, true)
  await poll(() => mobile.state.sockets.every(socket => socket.closed), 'memory-only eco still controls live capture')
  assert.equal(mobile.state.mutations.length, 0)
  await mobile.context.close()
  assert.deepEqual(errors, [])
  console.log('PASS: Russian mobile layout at 320px, blocked-storage session mode, zero browser errors')
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { mock.kill(); await once(mock, 'exit') }
}
