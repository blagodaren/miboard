import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.scenes-sites-check')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, mock, output = ''
async function poll(check, label) { const end = Date.now() + 12000; do { if (await check()) return; await pause(40) } while (Date.now() < end); throw new Error(label) }
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }
const leaf = name => ({ name, type: 'Vless', history: [] })
const group = (name, all, now = all[0], extra = {}) => ({ name, type: 'Selector', all, now, history: [], ...extra })
try {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  mock.stdout.on('data', chunk => output += chunk); mock.stderr.on('data', chunk => output += chunk)
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'Mock did not start')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) { try { browser = await chromium.launch({ headless: true, ...options }); break } catch {} }
  if (!browser) throw new Error('No Chromium browser')
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' }))
    localStorage.setItem('miboard.locale', 'en')
    localStorage.setItem('miboard.theme', 'dark')
  }, { origin })
  const page = await context.newPage(); page.setDefaultTimeout(12000)
  const errors = [], writes = [], checks = []
  page.on('pageerror', error => errors.push(error.message))
  let remote = null
  const targetGroup = 'Video / Europe & 東京'
  const proxies = { GLOBAL: group('GLOBAL', ['A', 'Auto', targetGroup]), A: group('A', ['one', 'two']), Auto: group('Auto', ['one', 'two'], 'one', { type: 'URLTest', fixed: '' }), [targetGroup]: group(targetGroup, ['one', 'two']), one: leaf('one'), two: leaf('two') }
  const providers = { 'subscription / one': { vehicleType: 'HTTP', proxies: [leaf('provider-leaf')] } }
  await page.route(`${origin}/**`, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    if (url.pathname === '/proxies') return route.fulfill({ json: { proxies } })
    if (url.pathname === '/providers/proxies') return route.fulfill({ json: { providers } })
    if (url.pathname === '/storage/miboard.scenes.v1') {
      if (method === 'PUT') { remote = request.postDataJSON(); writes.push({ path: url.pathname, method }); return route.fulfill({ status: 204 }) }
      return route.fulfill({ json: remote })
    }
    if (/\/delay$|\/healthcheck$/.test(url.pathname)) { checks.push({ path: url.pathname, url: url.searchParams.get('url') }); return route.fulfill({ json: { delay: 37 } }) }
    if (url.pathname.startsWith('/proxies/') && ['PUT', 'DELETE'].includes(method)) {
      const name = decodeURIComponent(url.pathname.slice('/proxies/'.length)); writes.push({ path: url.pathname, method, name })
      if (method === 'DELETE') proxies[name].fixed = ''
      else { proxies[name].now = request.postDataJSON().name; if (proxies[name].type === 'URLTest') proxies[name].fixed = proxies[name].now }
      return route.fulfill({ status: 204 })
    }
    return route.fallback()
  })
  await page.goto(`${origin}/ui/#/proxies?${new URLSearchParams({ group: targetGroup })}`)
  const linked = page.locator('section.proxy-group').filter({ has: page.getByTitle(targetGroup, { exact: true }) })
  await poll(async () => (await linked.locator('[data-proxy-node]').count()) === 2, 'Deep link did not open target group')
  const scenes = page.getByTestId('proxy-scenes'); await scenes.locator('summary').first().click()
  await scenes.getByTestId('scene-name').fill('Work')
  await scenes.getByRole('button', { name: 'Save current choices', exact: true }).click()
  await poll(async () => await scenes.getByText('Scene saved in this browser', { exact: true }).count() > 0, 'Scene not saved')
  proxies.A.now = 'two'; proxies.Auto.fixed = 'two'
  await scenes.getByRole('button', { name: 'Preview changes', exact: true }).click()
  await scenes.getByTestId('scene-apply').click()
  await poll(async () => proxies.A.now === 'one' && proxies.Auto.fixed === '', 'Scene did not restore selection and automatic state')
  assert.ok(writes.some(write => write.name === 'Auto' && write.method === 'DELETE'))
  await poll(async () => await scenes.getByRole('button', { name: 'Preview changes', exact: true }).isEnabled(), 'Scene controls remained busy')
  await scenes.getByText('Share scenes through the core', { exact: true }).click()
  await scenes.getByRole('button', { name: 'Preview push to core', exact: true }).click()
  await scenes.getByRole('button', { name: 'Replace core copy', exact: true }).click()
  await poll(async () => remote?.scenes?.[0]?.name === 'Work', 'Scenes were not pushed')
  await poll(async () => await scenes.getByText('Scene transfer verified', { exact: true }).count() > 0, 'Scene write was not verified')
  await scenes.getByRole('button', { name: 'Delete scene', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete scene', exact: true }).click()
  assert.equal(await scenes.getByTestId('scene-select').locator('option').textContent(), 'No saved scenes')
  await scenes.getByRole('button', { name: 'Preview pull from core', exact: true }).click()
  await scenes.getByRole('button', { name: 'Replace browser copy', exact: true }).click()
  await poll(async () => await scenes.getByTestId('scene-select').locator('option').textContent() === 'Work', 'Scenes were not pulled')
  await scenes.locator('summary').first().click()
  const sites = page.getByTestId('site-checks'); await sites.locator('summary').click()
  await sites.getByTestId('site-urls').fill('https://example.com/\nhttps://example.org/')
  await sites.getByRole('checkbox', { name: 'one', exact: true }).check()
  await sites.getByRole('checkbox', { name: 'provider-leaf · subscription / one', exact: true }).check()
  await sites.getByRole('button', { name: 'Run checks', exact: true }).click()
  await poll(async () => await sites.getByText('RTT: 37 ms', { exact: true }).count() === 4, 'URL matrix did not complete')
  assert.equal(checks.length, 4)
  assert.ok(checks.some(check => check.path === '/providers/proxies/subscription%20%2F%20one/provider-leaf/healthcheck'))
  assert.deepEqual([...new Set(checks.map(check => check.url))].sort(), ['https://example.com/', 'https://example.org/'])
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, 'Mobile page overflows horizontally')
  await mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, 'matrix-mobile.png'), fullPage: true })
  await page.evaluate(() => history.replaceState(null, '', location.pathname + '?secret=canary' + location.hash))
  await linked.getByRole('button', { name: `Copy link to ${targetGroup}`, exact: true }).click()
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  const copiedUrl = new URL(copied)
  assert.equal(copiedUrl.search, '')
  assert.equal(new URLSearchParams(copiedUrl.hash.split('?')[1]).get('group'), targetGroup)
  assert.deepEqual(errors, [])
  await context.close()
  console.log('Scenes/sites UI: capture, preview, apply, auto restore, sync, provider matrix, deep link, clipboard privacy and mobile layout passed')
} finally { await browser?.close(); mock?.kill() }
