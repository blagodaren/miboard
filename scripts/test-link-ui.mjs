// A zashboard-style link connects a fresh browser without manual input; UI flags hide only their controls.
// Own mock port and fresh browser storage: never touches the user's actual controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
let browser, mock, origin, port
let output = ''
const errors = []
async function poll(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(40) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const free = server.address().port; await new Promise(resolve => server.close(resolve)); return free
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No browser available')
}
async function open(flags) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/ui/#/setup?http=true&hostname=127.0.0.1&port=${port}&secret=test&label=Prizrak-Box${flags}`)
  await page.waitForURL(url => url.hash === '#/overview')
  return { context, page }
}
async function controls(page) {
  await page.evaluate(() => { location.hash = '/settings' })
  await chooseSettingsCategory(page, 'core')
  await page.getByRole('switch', { name: 'Allow LAN' }).waitFor()
  const tun = await page.getByRole('switch', { name: 'TUN' }).count()
  await chooseSettingsCategory(page, 'maintenance')
  await page.getByTestId('core-upgrade-geo').waitFor()
  return { tun, core: await page.getByTestId('core-upgrade-core').count(), ui: await page.getByTestId('core-upgrade-ui').count() }
}

try {
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()

  const linked = await open('&disableUpgradeCore=1&disableTunMode=tun')
  const profiles = await linked.page.evaluate(() => JSON.parse(localStorage.getItem('miboard.backends')))
  assert.deepEqual(profiles.map(({ url, secret, name }) => ({ url, secret, name })), [{ url: origin, secret: 'test', name: 'Prizrak-Box' }])
  assert.ok(!linked.page.url().includes('secret'), 'the secret leaves the address bar')
  assert.deepEqual(await controls(linked.page), { tun: 0, core: 0, ui: 1 })
  await linked.context.close()
  console.log('PASS: link connects a fresh browser, saves the labelled profile and hides core update and TUN')

  const plain = await open('')
  assert.deepEqual(await controls(plain.page), { tun: 1, core: 1, ui: 1 })
  await plain.context.close()
  console.log('PASS: without flags the TUN switch and core update stay available')
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
