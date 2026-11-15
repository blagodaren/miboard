// Custom CSS from Settings → Appearance overrides palette variables, survives reload and resets.
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
async function open(flags = '') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/ui/#/setup?http=true&hostname=127.0.0.1&port=${port}&secret=test&label=Prizrak-Box${flags}`)
  await page.waitForURL(url => url.hash === '#/overview')
  return { context, page }
}
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()

try {
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()

  const { context, page } = await open()
  const original = await page.evaluate(accent)
  await page.evaluate(() => { location.hash = '/settings' })
  await chooseSettingsCategory(page, 'appearance')
  const section = page.getByTestId('custom-css-settings')
  await section.locator('textarea').fill(':root { --accent: #7c5cff; }')
  await section.getByRole('button', { name: 'Apply', exact: true }).click()
  await poll(async () => await page.evaluate(accent) === '#7c5cff', 'custom accent applied')
  await page.reload()
  await section.waitFor()
  assert.equal(await page.evaluate(accent), '#7c5cff', 'custom CSS applies before the app renders after reload')
  assert.equal(await section.locator('textarea').inputValue(), ':root { --accent: #7c5cff; }')
  await section.getByRole('button', { name: 'Reset', exact: true }).click()
  await poll(async () => await page.evaluate(accent) === original, 'reset restores the palette')
  assert.equal(await page.evaluate(() => localStorage.getItem('miboard.custom-css')), null)
  await context.close()
  console.log('PASS: custom CSS overrides palette variables, survives reload and resets')
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
