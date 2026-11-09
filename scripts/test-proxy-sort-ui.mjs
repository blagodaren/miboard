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
const base = process.env.MIBOARD_PROXY_SORT_URL
const out = path.join(root, '.proxy-sort-check')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const errors = []
const writes = []
let browser
let mock
let mockOutput = ''
async function poll(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  do { if (await check()) return; await delay(50) } while (Date.now() < deadline)
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
  throw new Error('No Chrome/Edge available')
}
const node = (name, type = 'Vless', delay = 100) => ({ name, type, history: [{ time: '2026-11-08T00:00:00Z', delay }] })
const providerNodes = [node('node-z', 'Vless', 300), node('node-a', 'Trojan', 100), node('node-m', 'Vless', 200), node('extra-z'), node('extra-a')]
const group = (name, all, extra = {}) => ({ name, type: 'Selector', all, now: all[0], history: [], ...extra })
const proxies = {
  GLOBAL: group('GLOBAL', ['Select', 'Video', 'Closed', 'Search hidden', 'Hidden']),
  Select: group('Select', ['Manual', 'Compatible only', 'node-z', 'node-a', 'node-m']),
  Video: group('Video', ['node-m', 'node-z', 'node-a']),
  Closed: group('Closed', ['node-z', 'node-m', 'node-a']),
  'Search hidden': group('Search hidden', ['extra-z', 'extra-a']),
  Hidden: group('Hidden', ['node-z', 'node-a'], { hidden: true }),
  Manual: node('Manual'),
  'Compatible only': node('Compatible only'),
  // Older controllers expose provider members through /proxies as well.
  ...Object.fromEntries(providerNodes.map(proxy => [proxy.name, proxy])),
}
const card = (page, group) => page.locator('section').filter({ has: page.getByRole('button', { name: `Test latency for ${group}`, exact: true }) })
const control = (page, group) => page.getByRole('combobox', { name: `Sort nodes in ${group}`, exact: true })
const displayed = (page, group) => card(page, group).locator('[data-proxy-node]').evaluateAll(nodes => nodes.map(node => node.dataset.proxyNode))
const preferences = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('miboard.proxy-sort.v1'))))
async function expectOrder(page, group, expected) {
  await poll(async () => JSON.stringify(await displayed(page, group)) === JSON.stringify(expected), `${group}: ${expected.join(', ')}`)
}

try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  mock.stdout.on('data', chunk => { mockOutput += chunk })
  mock.stderr.on('data', chunk => { mockOutput += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(mockOutput)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated mock startup')
  browser = await launch()
  await mkdir(out, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
  await stubAppUpdates(context)
  await context.addInitScript(() => { localStorage.setItem('miboard.locale', 'en'); localStorage.setItem('miboard.theme', 'light') })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()) })
  await page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies } }))
  await page.route(`${origin}/providers/proxies`, route => route.fulfill({ json: { providers: {
    fixture: { vehicleType: 'HTTP', proxies: providerNodes },
    compatible: { vehicleType: 'Compatible', proxies: [proxies.Manual, proxies['Compatible only']] },
  } } }))
  const entry = new URL(base ?? `${origin}/ui/`)
  entry.hash = `/proxies?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
  await page.goto(entry.href)
  await control(page, 'Select').waitFor()
  await expectOrder(page, 'Select', ['Manual', 'Compatible only', 'node-z', 'node-a', 'node-m'])
  await control(page, 'Select').selectOption('name')
  await expectOrder(page, 'Select', ['Manual', 'Compatible only', 'node-a', 'node-m', 'node-z'])
  assert.equal(await control(page, 'Video').inputValue(), 'config')
  await expectOrder(page, 'Video', ['node-m', 'node-z', 'node-a'])
  console.log('PASS: individual sorting changes provider nodes duplicated in /proxies, keeps manual nodes pinned and leaves other groups unchanged')
  await card(page, 'Closed').locator('button[aria-expanded]').click()
  assert.equal(await control(page, 'Closed').inputValue(), 'config')
  await control(page, 'Video').selectOption('protocol')
  await expectOrder(page, 'Video', ['node-a', 'node-m', 'node-z'])
  const stored = await preferences(page)
  assert.deepEqual(JSON.parse(stored['miboard.proxy-sort.v1' + JSON.stringify([origin, 'Select'])]), { key: 'name', direction: 'asc' })
  assert.deepEqual(JSON.parse(stored['miboard.proxy-sort.v1' + JSON.stringify([origin, 'Video'])]), { key: 'protocol', direction: 'asc' })
  assert.equal(Object.keys(stored).length, 2, 'Sorting preferences stay per group')
  await card(page, 'Select').getByRole('button', { name: 'Change sort direction in Select. Current: A → Z', exact: true }).click()
  await expectOrder(page, 'Select', ['Manual', 'Compatible only', 'node-z', 'node-m', 'node-a'])
  await expectOrder(page, 'Video', ['node-a', 'node-m', 'node-z'])
  await control(page, 'Select').selectOption('config')
  await expectOrder(page, 'Select', ['Manual', 'Compatible only', 'node-z', 'node-a', 'node-m'])
  assert.equal(await control(page, 'Video').inputValue(), 'protocol')
  console.log('PASS: direction and configuration reset affect only the chosen group')
  await page.getByRole('searchbox').fill('node-')
  await control(page, 'Select').selectOption('latency')
  await expectOrder(page, 'Select', ['node-a', 'node-m', 'node-z'])
  await page.getByRole('searchbox').fill('')
  await card(page, 'Search hidden').locator('button[aria-expanded]').click()
  assert.equal(await control(page, 'Search hidden').inputValue(), 'config')
  await expectOrder(page, 'Search hidden', ['extra-z', 'extra-a'])
  await page.reload()
  await control(page, 'Video').waitFor()
  assert.equal(await control(page, 'Video').inputValue(), 'protocol')
  assert.equal(await control(page, 'Select').inputValue(), 'latency')
  await expectOrder(page, 'Select', ['Manual', 'Compatible only', 'node-a', 'node-m', 'node-z'])
  await expectOrder(page, 'Video', ['node-a', 'node-m', 'node-z'])
  console.log('PASS: filtered sorting preserves independent preferences after reload')
  await page.screenshot({ path: path.join(out, 'individual-sorting-light-1440.png'), fullPage: true })
  assert.deepEqual(errors, [], 'No browser errors')
  assert.deepEqual(writes, [], 'Sorting is local; no write API requests')
  console.log(`PASS: individual sorting has no browser errors or controller writes; screenshots ${out}`)
  await context.close()
} catch (error) {
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {})
      console.error('Sorting diagnostic:', await page.locator('select[id^="sort-"]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, value: node.value }))).catch(() => []))
    }
  }
  throw error
} finally {
  await browser?.close()
  if (mock?.exitCode === null) {
    const exit = once(mock, 'exit')
    mock.kill()
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000).unref())])
  }
}
