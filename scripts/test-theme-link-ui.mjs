// theme= link: the CSS URL is stored, re-checked on every start, kept on failures and stays under custom CSS.
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
  await page.route(THEME, route => route.fulfill(theme.status === 200 ? { status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: `:root { --accent: ${theme.accent}; }` } : { status: theme.status, headers: { 'access-control-allow-origin': '*' }, body: '' }))
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/ui/#/setup?http=true&hostname=127.0.0.1&port=${port}&secret=test&label=Prizrak-Box${flags}`)
  await page.waitForURL(url => url.hash === '#/overview')
  return { context, page }
}
const THEME = 'https://theme.fixture.example/miboard.css'
const theme = { status: 200, accent: '#7c5cff' }
const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
const stored = () => JSON.parse(localStorage.getItem('miboard.theme-source') ?? 'null')

try {
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()

  const { context, page } = await open(`&theme=${encodeURIComponent(THEME)}`)
  await poll(async () => await page.evaluate(accent) === '#7c5cff', 'link theme applied')
  assert.equal((await page.evaluate(stored)).url, THEME)
  assert.ok(!page.url().includes('theme='), 'theme leaves the address bar with the connection parameters')

  theme.accent = '#00aa77'
  await page.reload()
  await poll(async () => await page.evaluate(accent) === '#00aa77', 'changed provider CSS is picked up on the next start')

  theme.status = 500
  await page.reload()
  await page.evaluate(() => { location.hash = '/settings' })
  await chooseSettingsCategory(page, 'appearance')
  const source = page.getByTestId('theme-source-settings')
  await source.getByText(/Could not load the theme: HTTP 500/).waitFor()
  assert.equal(await page.evaluate(accent), '#00aa77', 'a failed check keeps the saved copy')

  const custom = page.getByTestId('custom-css-settings')
  await custom.locator('textarea').fill(':root { --accent: #ff0000; }')
  await custom.getByRole('button', { name: 'Apply', exact: true }).click()
  assert.equal(await page.evaluate(accent), '#ff0000', 'custom CSS applies on top of the link theme')
  await custom.getByRole('button', { name: 'Reset', exact: true }).click()
  assert.equal(await page.evaluate(accent), '#00aa77')

  await source.getByRole('switch', { name: 'Use theme from link' }).click()
  assert.notEqual(await page.evaluate(accent), '#00aa77', 'switching the link theme off restores the palette')
  assert.equal((await page.evaluate(stored)).enabled, false)
  await source.getByRole('switch', { name: 'Use theme from link' }).click()
  assert.equal(await page.evaluate(accent), '#00aa77')
  console.log('PASS: link theme applies, updates on start, survives failures and stays under custom CSS')

  await page.goto(`${origin}/ui/?theme=off#/overview`)
  await poll(async () => await page.evaluate(stored) === null, 'theme=off clears the saved theme')
  assert.notEqual(await page.evaluate(accent), '#00aa77')
  await context.close()
  console.log('PASS: theme=off removes the link theme')
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
