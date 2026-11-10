// Isolated mock controller and browser storage; never reads a configured user controller.
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
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-core-details-'))
const fixture = {
  'log-level': 'warning', 'disable-keep-alive': false, 'keep-alive-idle': 0, 'keep-alive-interval': 15,
  'inbound-tfo': true, 'inbound-mptcp': false, 'global-ua': 'mihomo fixture', 'etag-support': true,
  'allow-lan': false, 'lan-allowed-ips': ['192.168.1.0/24', 'fd00::/8'], 'lan-disallowed-ips': [],
  'skip-auth-prefixes': ['127.0.0.0/8'], authentication: ['alice', 'bob:PRIVATE-PASSWORD'],
  'ss-config': 'PRIVATE-SS', 'vmess-config': 'PRIVATE-VMESS', 'tuic-server': { token: 'PRIVATE-TUIC' },
  tun: {
    enable: true, device: 'Meta', stack: 'mixed', 'auto-route': true,
    'inet4-address': ['198.18.0.1/30'], 'inet6-address': ['fdfe:dcba:9876::1/126'],
    'route-address': Array.from({ length: 20 }, (_, i) => `10.${i}.0.0/16`),
    'route-exclude-address': ['192.168.0.0/16'], 'route-address-set': ['routes'], 'route-exclude-address-set': ['bypass'],
    'include-interface': ['br-lan'], 'exclude-interface': [], 'include-uid': [0, 1000], 'exclude-uid-range': ['2000:3000'],
    'include-package': ['org.example.application.with.a.very.long.name.that.must.wrap.on.mobile'],
    'exclude-package': ['org.example.excluded'], 'include-mac-address': ['00:11:22:33:44:55'],
    'exclude-dst-port': [53, 123], 'exclude-src-port-range': ['8000:9000'],
    'auto-redirect': false, 'auto-redirect-input-mark': 0, 'iproute2-table-index': 2022,
    'udp-timeout': 300, 'icmp-timeout': 10, 'disable-icmp-forwarding': true, 'gso': false, 'gso-max-size': 65536,
  },
}
let browser, mock, origin
let output = ''
const errors = []
async function poll(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(40) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No browser available')
}
async function open({ locale = 'en', theme = 'light', width = 1440, config = fixture } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale, theme }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test', name: 'Fixture' }))
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', theme)
  }, { origin, locale, theme })
  const page = await context.newPage()
  const mutations = []
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.href === APP_UPDATE_URL) return route.fallback()
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(url.pathname)
    if (url.pathname === '/configs' && request.method() === 'GET') {
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...await response.json(), ...config } })
    }
    return route.continue()
  })
  await page.goto(`${origin}/ui/#/settings`)
  await chooseSettingsCategory(page, 'core')
  await page.getByTestId('core-details-runtime').waitFor()
  await page.evaluate(() => document.fonts.ready)
  return { page, context, mutations }
}

try {
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()
  const desktop = await open()
  const status = desktop.page.getByTestId('core-status')
  const runtime = desktop.page.getByTestId('core-details-runtime')
  assert.equal(await runtime.evaluate(element => element.open), false)
  await runtime.locator(':scope > summary').press('Enter')
  assert.equal(await runtime.evaluate(element => element.open), true, 'keyboard opens diagnostics')
  await runtime.locator('[data-field="log-level"] dd').filter({ hasText: 'warning' }).waitFor()
  assert.equal((await runtime.locator('[data-field="keep-alive-idle"] dd').textContent()).trim(), '0')
  assert.equal((await runtime.locator('[data-field="disable-keep-alive"] dd').textContent()).trim(), 'Enabled')
  for (const section of ['lan', 'tun-routes', 'tun-filters', 'tun-transport']) await desktop.page.getByTestId(`core-details-${section}`).locator(':scope > summary').click()
  assert.equal((await status.locator('[data-field="disable-icmp-forwarding"] dd').textContent()).trim(), 'Disabled')
  assert.equal((await status.locator('[data-field="lan-disallowed-ips"] dd').textContent()).trim(), 'None configured')
  assert.ok(!(await status.textContent()).includes('PRIVATE'))
  assert.deepEqual(await status.locator('[data-field="authentication"] li').allTextContents(), ['alice', 'bob'])
  const routes = status.locator('[data-field="route-address"]')
  assert.equal(await routes.getByText('10.19.0.0/16', { exact: true }).isVisible(), false)
  await routes.getByText('Show 15 more', { exact: true }).click()
  assert.equal(await routes.getByText('10.19.0.0/16', { exact: true }).isVisible(), true)
  assert.equal(await status.locator('input,select').count(), 0)
  assert.deepEqual(desktop.mutations, [])
  await status.screenshot({ path: path.join(screenshots, 'core-details-en-light.png') })
  await desktop.context.close()
  console.log('PASS: read-only runtime/LAN/TUN details, keyboard disclosure, full route lists and credential exclusion')

  const legacy = await open({ config: { 'log-level': 'info', tun: { enable: false }, authentication: null, 'lan-allowed-ips': null } })
  assert.equal(await legacy.page.getByTestId('core-details-tun-routes').count(), 0)
  assert.equal(await legacy.page.getByTestId('core-details-tun-filters').count(), 0)
  assert.equal(await legacy.page.getByTestId('core-details-tun-transport').count(), 0)
  assert.equal(await legacy.page.locator('[data-field="keep-alive-idle"]').count(), 0)
  assert.equal(await legacy.page.locator('[data-field="authentication"]').count(), 0)
  await legacy.context.close()
  console.log('PASS: old cores do not show unsupported fields as disabled values')

  for (const theme of ['light', 'dark']) {
    const mobile = await open({ locale: 'ru', theme, width: 375 })
    const mobileStatus = mobile.page.getByTestId('core-status')
    for (const section of ['runtime', 'lan', 'tun-routes', 'tun-filters', 'tun-transport']) {
      const summary = mobile.page.getByTestId(`core-details-${section}`).locator(':scope > summary')
      assert.ok((await summary.boundingBox()).height >= 44, 'touch target')
      await summary.click()
    }
    await mobileStatus.getByText('Показать ещё 15', { exact: true }).click()
    const size = await mobile.page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }))
    assert.ok(size.content <= size.viewport, `${theme}: horizontal overflow`)
    await mobileStatus.getByText('Уровень логирования ядра', { exact: true }).waitFor()
    assert.ok(!(await mobileStatus.textContent()).includes('PRIVATE'))
    await mobileStatus.screenshot({ path: path.join(screenshots, `core-details-ru-${theme}-375.png`) })
    await mobile.context.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS: Russian 375px layout in both themes; no browser errors')
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
