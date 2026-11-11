// Own mock port and fresh browser storage: never touches the user's actual controller.
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
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-core-tools-'))
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
const copy = (revision, name = 'Remote laptop') => ({ format: 'miboard-sync', version: 1, revision, updatedAt: '2026-11-09T12:00:00Z', data: { deviceNames: { '192.168.1.10': name }, proxySort: [{ group: 'Main', key: 'latency', direction: 'desc' }], preferences: { theme: 'dark', groups: { Main: false }, connectionColumns: ['dnsMode', 'source'] }, providerAlertsEnabled: false, journalRetention: '1h' } })
async function open(locale = 'en', theme = 'light') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale, theme }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test', name: 'Fixture core' }))
    localStorage.setItem('miboard.backends', JSON.stringify([{ url: origin, secret: 'test' }, { url: 'https://private.invalid', secret: 'NEVER-UPLOAD' }]))
    localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme)
    localStorage.setItem('miboard.device-names.' + encodeURIComponent(origin), JSON.stringify({ '192.168.1.10': 'Local laptop', '192.168.1.20': 'Keep phone' }))
    localStorage.setItem('miboard.device-names.' + encodeURIComponent('https://private.invalid'), JSON.stringify({ '10.0.0.1': 'PRIVATE-DEVICE' }))
    localStorage.setItem('miboard.proxy-sort.v1' + JSON.stringify([origin, 'Main']), JSON.stringify({ key: 'name', direction: 'asc' }))
    localStorage.setItem('miboard.groups', JSON.stringify({ Main: true }))
  }, { origin, locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const state = { remote: null, status: 200, puts: [], reads: 0, overwrite: false, held: false, release: null, mutations: [] }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.href === APP_UPDATE_URL) return route.fallback()
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort()
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) state.mutations.push({ path: url.pathname, method: request.method() })
    if (url.pathname === '/configs' && request.method() === 'GET') {
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...await response.json(), ipv6: true, sniffing: false, 'find-process-mode': 'strict', 'tcp-concurrent': true, 'interface-name': 'eth0', 'bind-address': '*', 'routing-mark': 0,
        tun: { enable: true, device: 'Meta', stack: 'mixed', mtu: 9000, 'auto-route': true, 'auto-detect-interface': true, 'strict-route': false, 'dns-hijack': ['any:53'] },
        'geo-auto-update': true, 'geo-update-interval': 24, 'geodata-mode': true, 'geodata-loader': 'memconservative', 'geosite-matcher': 'succinct',
        'geox-url': { mmdb: 'https://user:PRIVATE-URL-PASSWORD@db.example/country.mmdb?token=PRIVATE-TOKEN' },
      } })
    }
    if (url.pathname === '/storage/miboard.settings.v1') {
      if (state.status !== 200) return route.fulfill({ status: state.status, json: { message: 'Unavailable fixture' } })
      if (request.method() === 'PUT') {
        state.puts.push(request.postDataJSON())
        state.remote = state.overwrite ? copy('overwritten-revision') : request.postDataJSON()
        return route.fulfill({ status: 204 })
      }
      state.reads++
      if (state.held) await new Promise(resolve => { state.release = resolve })
      try { return await route.fulfill({ json: state.remote }) } catch { return }
    }
    return route.continue()
  })
  await page.goto(`${origin}/ui/#/settings`)
  await chooseSettingsCategory(page, 'data')
  await page.getByTestId('settings-sync').waitFor()
  await page.evaluate(() => document.fonts.ready)
  return { page, context, state }
}
const names = page => page.evaluate(origin => JSON.parse(localStorage.getItem('miboard.device-names.' + encodeURIComponent(origin))), origin)
const credentials = page => page.evaluate(() => JSON.stringify([localStorage.getItem('miboard.backend'), localStorage.getItem('miboard.backends'), localStorage.getItem('miboard.secrets')]))

try {
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()
  const { page, context, state } = await open()
  const originalCredentials = await credentials(page)
  await chooseSettingsCategory(page, 'core')
  const status = page.getByTestId('core-status')
  await poll(async () => (await status.getByTestId('core-memory-value').textContent()) !== '—', 'memory stream')
  await poll(async () => (await status.locator('path').getAttribute('d'))?.includes('L'), 'memory chart has multiple real samples')
  await status.locator('summary').filter({ hasText: 'Network and TUN parameters' }).click()
  await status.getByText('eth0', { exact: true }).waitFor()
  await status.locator('summary').filter({ hasText: 'Core GeoIP / GeoSite databases' }).click()
  await status.getByText('https://db.example/country.mmdb', { exact: true }).waitFor()
  assert.ok(!(await status.textContent()).includes('PRIVATE-'))
  assert.equal(await status.locator('input,select,button').count(), 0, 'runtime configuration is read-only')
  assert.equal(state.mutations.length, 0)
  await status.screenshot({ path: path.join(screenshots, 'core-status-en-light.png') })
  console.log('PASS: live bounded memory graph and read-only runtime config, credential-free database source display')

  await chooseSettingsCategory(page, 'data')
  await page.getByTestId('sync-push').click()
  await page.getByTestId('sync-preview').waitFor()
  assert.equal(state.puts.length, 0)
  assert.equal(await page.getByTestId('sync-preview').evaluate(element => document.activeElement === element), true)
  await page.getByTestId('sync-apply').press('Enter')
  await page.getByTestId('sync-notice').filter({ hasText: 'Saved to this core' }).waitFor()
  assert.equal(state.puts.length, 1)
  assert.ok(state.reads >= 3, 'read before preview, reread before write, verification after write')
  const payload = JSON.stringify(state.puts[0])
  for (const forbidden of [origin, 'NEVER-UPLOAD', 'private.invalid', 'PRIVATE-DEVICE', 'servers', 'secret', 'backendUrl']) assert.ok(!payload.includes(forbidden), forbidden)
  assert.equal(await credentials(page), originalCredentials)
  console.log('PASS: explicit push uses preview/recheck/verification and excludes all controller profiles and secrets')

  state.remote = copy('remote-revision-one', 'First remote')
  await page.getByTestId('sync-pull').click()
  await page.getByTestId('sync-preview').getByText('First remote', { exact: true }).waitFor()
  await page.getByTestId('sync-preview').getByText('Subscription alerts', { exact: true }).waitFor()
  await page.getByTestId('sync-preview').getByText('Keep completed connections', { exact: true }).waitFor()
  assert.equal((await names(page))['192.168.1.10'], 'Local laptop')
  state.remote = copy('remote-revision-two', 'Latest remote')
  await page.getByTestId('sync-apply').click()
  await page.getByTestId('sync-notice').filter({ hasText: 'Preferences changed' }).waitFor()
  assert.equal((await names(page))['192.168.1.10'], 'Local laptop')
  await page.getByTestId('sync-preview').getByText('Latest remote', { exact: true }).waitFor()
  await page.getByTestId('sync-apply').click()
  await page.getByTestId('sync-notice').filter({ hasText: 'Preferences applied locally' }).waitFor()
  assert.deepEqual(await names(page), { '192.168.1.10': 'Latest remote', '192.168.1.20': 'Keep phone' })
  assert.equal(await credentials(page), originalCredentials)
  const importedPreferences = await page.evaluate(origin => ({
    columns: JSON.parse(localStorage.getItem('miboard.connection-columns.v1')),
    alerts: JSON.parse(localStorage.getItem('miboard.provider-alerts:' + encodeURIComponent(origin))).enabled,
    retention: localStorage.getItem('miboard.journal-retention.v1.' + encodeURIComponent(origin)),
  }), origin)
  assert.deepEqual(importedPreferences, { columns: ['dnsMode', 'source'], alerts: false, retention: '1h' })
  await page.evaluate(() => {
    const original = indexedDB.open.bind(indexedDB)
    indexedDB.open = () => { throw new DOMException('Blocked fixture', 'SecurityError') }
    window.restoreSyncIDB = () => { indexedDB.open = original }
  })
  await page.getByTestId('sync-push').click()
  await page.getByTestId('sync-preview').waitFor()
  await page.getByTestId('sync-cancel').click()
  await page.evaluate(() => { window.restoreSyncIDB(); delete window.restoreSyncIDB })
  console.log('PASS: remote changes require a new confirmation; pull merges local entries without touching credentials')

  await page.getByTestId('sync-push').click()
  await page.getByTestId('sync-preview').waitFor()
  await page.evaluate(() => localStorage.setItem('miboard.theme', 'light'))
  const writesBeforeLocal = state.puts.length
  await page.getByTestId('sync-apply').click()
  await page.getByTestId('sync-notice').filter({ hasText: 'Preferences changed' }).waitFor()
  assert.equal(state.puts.length, writesBeforeLocal)
  await page.getByTestId('sync-cancel').click()

  state.status = 404
  await page.getByTestId('sync-pull').click()
  await page.getByTestId('sync-error').filter({ hasText: 'does not support' }).waitFor()
  state.status = 200; state.remote = { ...copy('bad-remote-revision'), secret: 'INVALID-CREDENTIAL' }
  await page.getByTestId('sync-pull').click()
  await page.getByTestId('sync-error').filter({ hasText: 'unsupported format or invalid' }).waitFor()
  assert.equal(await credentials(page), originalCredentials)
  state.remote = null
  await page.getByTestId('sync-pull').click()
  await page.getByTestId('sync-error').filter({ hasText: 'no preferences saved' }).waitFor()
  console.log('PASS: changed local values, unsupported API, invalid schema and empty storage fail safely')

  await page.getByTestId('sync-push').click(); await page.getByTestId('sync-preview').waitFor()
  state.overwrite = true
  await page.getByTestId('sync-apply').click()
  await page.getByTestId('sync-error').filter({ hasText: 'changed during the write' }).waitFor()
  assert.equal(await page.getByTestId('sync-preview').count(), 0)
  console.log('PASS: concurrent overwrite detected by read-after-write; no false success')

  const beforeAbort = state.puts.length
  state.held = true
  await page.getByTestId('sync-push').click()
  await poll(() => typeof state.release === 'function', 'held read')
  await page.evaluate(() => { location.hash = '/overview' })
  state.release(); state.held = false
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
  assert.equal(state.puts.length, beforeAbort)
  await context.close()
  console.log('PASS: leaving Settings aborts pending reads without later writes')

  for (const theme of ['light', 'dark']) {
    const mobile = await open('ru', theme)
    await mobile.page.setViewportSize({ width: 375, height: 900 })
    mobile.state.remote = copy('mobile-preview-revision', 'Удалённый ноутбук с достаточно длинным названием')
    await mobile.page.getByTestId('sync-pull').click()
    await mobile.page.getByTestId('sync-preview').waitFor()
    const sizes = await mobile.page.evaluate(() => ({ inner: innerWidth, content: document.documentElement.scrollWidth }))
    assert.ok(sizes.content <= sizes.inner, `${theme}: horizontal overflow`)
    await mobile.page.getByTestId('settings-sync').screenshot({ path: path.join(screenshots, `sync-ru-${theme}-375.png`) })
    await chooseSettingsCategory(mobile.page, 'core')
    await mobile.page.getByTestId('core-status').screenshot({ path: path.join(screenshots, `core-ru-${theme}-375.png`) })
    await mobile.context.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS: Russian 375px preview in both themes, reduced motion, no browser errors')
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
