// Isolated controller and browser profile; never reaches a user's controller.
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
import { stubAppUpdates, APP_UPDATE_URL } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-logs-'))
let mock, browser, origin, output = ''
const errors = []
async function poll(check, name, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(40) } while (Date.now() < end)
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
const event = { time: '04:05:06', level: 'warn', message: 'Connection warning', fields: [{ key: 'host', value: 'example.org' }, { key: 'process', value: 'browser' }, { key: 'route', value: 'long-route-'.repeat(40) }] }
async function open({ mode = 'structured', locale = 'en', width = 1440, theme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale, theme }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test', name: 'Log fixture' }))
    localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme)
  }, { origin, locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const sockets = [], mutations = []
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.href === APP_UPDATE_URL) return route.fallback()
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url())
    return route.continue()
  })
  await page.routeWebSocket(/\/logs(?:\?|$)/, ws => {
    const socket = { ws, url: new URL(ws.url()), closed: false }
    sockets.push(socket)
    ws.onClose(() => { socket.closed = true })
    if (mode === 'reject' && socket.url.searchParams.has('format')) {
      socket.closed = true
      void ws.close({ code: 1008, reason: 'Unsupported format' })
      return
    }
    ws.send('not-json')
    ws.send(JSON.stringify({ message: 'Invalid event without level' }))
    ws.send(JSON.stringify(mode === 'structured' ? event : { type: 'info', payload: 'Legacy fixture event' }))
    if (mode === 'structured') ws.send(JSON.stringify({ time: '05:06:07', level: 'info', message: 'Healthy connection', fields: [] }))
  })
  await page.goto(`${origin}/ui/#/logs`)
  await page.getByTestId('log-event').first().waitFor()
  return { context, page, sockets, mutations }
}

try {
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()

  const { context, page, sockets, mutations } = await open()
  assert.equal(sockets[0].url.searchParams.get('format'), 'structured')
  assert.equal(await page.getByTestId('log-event').count(), 2)
  assert.match(await page.getByTestId('logs-format').textContent(), /Structured logs/)
  const warning = page.getByTestId('log-event').filter({ hasText: 'Connection warning' })
  assert.match(await warning.locator('summary').textContent(), /04:05:06/)
  assert.match(await warning.locator('summary').textContent(), /Warning/)
  await warning.locator('summary').focus(); await page.keyboard.press('Enter')
  await warning.getByText('Event fields', { exact: true }).waitFor()
  await page.getByRole('searchbox').fill('EXAMPLE.ORG')
  assert.equal(await page.getByTestId('log-event').count(), 1)
  await page.getByTestId('logs-field-filter').selectOption('process')
  assert.equal(await page.getByTestId('log-event').count(), 0)
  await page.getByRole('searchbox').fill('browser')
  assert.equal(await page.getByTestId('log-event').count(), 1)
  await page.screenshot({ path: path.join(screenshots, 'structured-en-light.png'), fullPage: true })
  await page.getByRole('searchbox').fill('')
  await page.getByTestId('logs-field-filter').selectOption('')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  sockets[0].ws.send(JSON.stringify({ ...event, message: 'While paused' }))
  await pause(100)
  assert.equal(await page.getByTestId('log-event').count(), 2)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  sockets[0].ws.send(JSON.stringify({ ...event, message: 'After resume' }))
  await poll(async () => await page.getByTestId('log-event').count() === 3, 'resume receives a new event')
  for (let index = 0; index < 1025; index++) sockets[0].ws.send(JSON.stringify({ level: 'info', message: `Burst ${index}` }))
  await poll(async () => await page.getByTestId('log-event').count() === 1000 && (await page.getByTestId('log-event').first().textContent()).includes('Burst 1024'), 'bounded burst renders the newest 1000 logs')
  assert.match(await page.getByTestId('log-event').last().textContent(), /Burst 25/)
  sockets[0].ws.send(JSON.stringify({ ...event, message: 'Pending before clear' }))
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  assert.equal(await page.getByTestId('log-event').count(), 0)
  await pause(200)
  assert.equal(await page.getByTestId('log-event').count(), 0, 'Clear also discards a pending render batch')
  await page.evaluate(() => { location.hash = '/overview' })
  await poll(() => sockets.every(socket => socket.closed), 'unmount disposes log stream')
  assert.deepEqual(mutations, [])
  await context.close()
  console.log('PASS: structured time, warning alias, field search, keyboard details, pause/resume, cleanup and no API mutations')

  const legacy = await open({ mode: 'legacy' })
  assert.match(await legacy.page.getByTestId('logs-format').textContent(), /Text logs/)
  assert.equal(await legacy.page.getByTestId('logs-field-filter').count(), 0)
  await legacy.page.getByTestId('log-event').locator('summary').click()
  assert.equal(await legacy.page.getByText('Core time', { exact: true }).count(), 0)
  await legacy.page.getByText('Received by this browser', { exact: true }).waitFor()
  assert.equal(legacy.sockets.length, 1, 'ignoring format requires no reconnect')
  await legacy.context.close()

  const rejected = await open({ mode: 'reject' })
  assert.equal(rejected.sockets.length, 2)
  assert.equal(rejected.sockets[1].url.searchParams.has('format'), false)
  assert.match(await rejected.page.getByTestId('logs-format').textContent(), /Text logs/)
  await pause(1300)
  assert.equal(rejected.sockets.length, 2, 'failed structured stream does not keep retrying')
  await rejected.context.close()
  console.log('PASS: legacy cores that ignore or reject structured format both display logs without duplicate retries')

  const mobile = await open({ locale: 'ru', width: 390, theme: 'dark' })
  const mobileWarning = mobile.page.getByTestId('log-event').filter({ hasText: 'Connection warning' })
  await mobileWarning.locator('summary').click()
  await mobileWarning.getByText('Поля события', { exact: true }).waitFor()
  await mobile.page.screenshot({ path: path.join(screenshots, 'structured-ru-mobile-dark.png'), fullPage: true })
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no page overflow at 390px')
  assert.equal(await mobileWarning.locator('summary').evaluate(element => element.getBoundingClientRect().height >= 44), true)
  assert.match(await mobile.page.getByTestId('logs-format').textContent(), /Структурированные логи/)
  await mobile.context.close()
  assert.deepEqual(errors, [])
  console.log('PASS: Russian mobile dark layout, long field wrapping and touch target')
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { mock.kill(); await once(mock, 'exit').catch(() => {}) }
}
