// Isolated mocks only. No saved controllers, real upgrades, or OS notifications.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.panel-tools-check')
const children = [], errors = [], writes = []
const socketTimers = new Set()
let browser, output = ''
async function poll(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await delay(40) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function launchMock() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const child = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child); child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value)
  const origin = `http://127.0.0.1:${port}`
  await poll(async () => { try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  return origin
}
async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) try { return await chromium.launch({ headless: true, ...options }) } catch {}
  throw new Error('No browser')
}
try {
  await mkdir(out, { recursive: true })
  const origin = await launchMock(), second = await launchMock()
  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, second }) => {
    if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en')
    localStorage.setItem('miboard.backends', JSON.stringify([{ url: origin, secret: 'test', name: 'Fixture A' }, { url: second, secret: 'test', name: 'Fixture B' }]))
    window.__notices = []
    class FixtureNotification {
      static permission = 'default'
      static async requestPermission() { this.permission = 'granted'; return 'granted' }
      constructor(title, options) { window.__notices.push({ title, ...options }) }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: FixtureNotification })
  }, { origin, second })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push({ url: request.url(), method: request.method(), body: request.postDataJSON() }) })
  await page.goto(`${origin}/ui/#/settings?category=core&secret=test`)
  await page.getByTestId('core-runtime-settings').waitFor()
  await poll(() => page.getByTestId('core-log-level').isEnabled(), 'runtime ready')
  await page.getByTestId('core-log-level').selectOption('debug')
  await page.getByTestId('core-runtime-save').click()
  await page.getByText('Settings applied and read back from the core.', { exact: true }).waitFor()
  assert.equal(writes.find(w => w.method === 'PATCH')?.body['log-level'], 'debug')
  await page.getByTestId('core-runtime-settings').locator('summary').click()
  await page.getByTestId('core-port-port').fill('70000')
  await page.getByTestId('core-port-port').blur()
  await page.getByText('Enter a whole number from 0 to 65535.', { exact: true }).waitFor()
  const beforeInvalid = writes.length
  await page.getByTestId('core-runtime-save').click()
  assert.equal(writes.length, beforeInvalid)
  await page.getByTestId('core-port-port').fill('7891')
  await page.getByTestId('core-runtime-save').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Apply settings', exact: true }).click()
  await poll(() => page.getByTestId('core-runtime-save').isDisabled(), 'port saved')
  assert(writes.some(w => w.method === 'PATCH' && w.body?.port === 7891))
  await chooseSettingsCategory(page, 'maintenance')
  for (const action of ['geo', 'ui', 'core']) {
    const button = page.getByTestId(`core-upgrade-${action}`)
    await button.click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: await button.innerText(), exact: true }).click()
    await poll(() => button.isEnabled(), `${action} upgrade completed`)
    assert.equal(writes.filter(w => w.url === origin + '/upgrade' + (action === 'core' ? '' : '/' + action)).length, 1)
  }
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click()
  await page.getByRole('button', { name: 'Send test notification', exact: true }).click()
  await poll(() => page.evaluate(() => window.__notices.some(n => n.title === 'MIBoard notifications work')), 'notification mock')
  await page.getByRole('button', { name: 'Disable notifications', exact: true }).click()
  console.log('PASS runtime validation/readback/port confirmation, three upgrades, opt-in browser notifications')

  await page.evaluate(() => { location.hash = '/fleet' })
  await page.getByTestId('core-fleet-check').click()
  await poll(async () => (await page.getByTestId('core-fleet-profile').filter({ hasText: 'Responding' }).count()) === 2, 'two controllers online')
  await page.getByTestId('core-fleet-select-all').check()
  await page.getByTestId('core-fleet').getByRole('combobox').selectOption('global')
  await page.getByTestId('core-fleet-mode').click()
  await page.getByRole('alertdialog').getByRole('button').last().click()
  await poll(async () => (await page.getByTestId('core-fleet-result').innerText()).includes('2'), 'fleet applied')
  for (const server of [origin, second]) assert(writes.some(w => w.url === server + '/configs' && w.body?.mode === 'global'))
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('miboard.backend')).url), origin, 'Fleet does not switch active core')
  console.log('PASS fleet reads and writes explicitly selected controllers without switching active core')

  let connections = Array.from({ length: 360 }, (_, index) => ({
    id: `fixture-${index}`, start: new Date(Date.now() - 60000).toISOString(), upload: index * 10, download: index * 100,
    metadata: { type: 'Tun', network: 'tcp', sourceIP: index < 320 ? '192.168.1.2' : '192.168.1.3', sourcePort: '1234', destinationIP: '192.0.2.1', destinationPort: '443', host: index === 0 ? '=malicious()' : `host${index}.example`, process: 'fixture' }, chains: ['Fixture node', 'Fixture group'], rule: 'MATCH', rulePayload: '',
  }))
  const closed = []
  await page.route(`${origin}/connections/**`, route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1))
    closed.push(id)
    if (id === 'fixture-5') return route.fulfill({ status: 503, json: { message: 'Fixture failure' } })
    connections = connections.filter(c => c.id !== id)
    return route.fulfill({ status: 204 })
  })
  await page.routeWebSocket('**/connections*', socket => {
    const send = () => socket.send(JSON.stringify({ connections, uploadTotal: 10000, downloadTotal: 100000 }))
    send(); const timer = setInterval(send, 100); socketTimers.add(timer)
    socket.onClose(() => { clearInterval(timer); socketTimers.delete(timer) })
  })
  await page.goto(`${origin}/ui/#/connections?secret=test`)
  await page.reload()
  await page.getByTestId('active-connection-row').first().waitFor()
  await poll(async () => (await page.locator('table').getAttribute('aria-rowcount')) === '361', 'all 360 connections')
  assert(await page.getByTestId('active-connection-row').count() < 50)
  const table = page.getByTestId('connections-table')
  await table.evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.getByTestId('active-connection-row').filter({ hasText: '=malicious()' }).waitFor()
  const rowHeights = await page.getByTestId('active-connection-row').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))
  assert(rowHeights.every(height => Math.abs(height - 64) < 1), JSON.stringify(rowHeights))
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click()
  const download = await downloadPromise
  const csv = await readFile(await download.path(), 'utf8')
  assert.equal(csv.trim().split('\r\n').length, 361)
  assert(csv.includes("'=malicious()"))
  await page.getByRole('combobox', { name: 'Filter by', exact: true }).selectOption('device')
  await page.getByRole('textbox', { name: 'Exact filter value', exact: true }).fill('192.168.1.2')
  await page.getByRole('button', { name: 'Close filtered', exact: true }).click()
  await page.getByRole('alertdialog').waitFor()
  connections.push({ ...connections[0], id: 'late-connection', metadata: { ...connections[0].metadata, host: 'late.example' } })
  await page.getByRole('alertdialog').getByRole('button', { name: 'Close filtered', exact: true }).click()
  await page.getByText('Closed: 319. Failed: 1. Not confirmed: 0.', { exact: true }).waitFor()
  assert.equal(closed.length, 320)
  assert(!closed.includes('late-connection'))
  assert(!closed.some(id => Number(id.split('-')[1]) >= 320))
  console.log('PASS virtual scrolling to last row, full filtered CSV, frozen bulk targets and partial failures')

  await page.locator('h1').click()
  await page.keyboard.press('/')
  assert.equal(await page.locator('input[type="search"]').evaluate(el => el === document.activeElement), true)
  await page.locator('input[type="search"]').fill('typing')
  await page.keyboard.press('Alt+8')
  assert(page.url().includes('/connections'))
  await page.locator('h1').click(); await page.keyboard.press('Alt+8')
  await page.getByRole('heading', { name: 'Logs', exact: true }).waitFor()
  await page.getByTestId('log-event').first().waitFor()
  const logDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export TXT', exact: true }).click()
  assert((await readFile(await (await logDownload).path(), 'utf8')).length > 10)
  await page.locator('h1').click(); await page.keyboard.press('?')
  await page.getByRole('dialog').getByRole('heading', { name: 'Keyboard shortcuts' }).waitFor()
  await page.keyboard.press('Escape')
  console.log('PASS log export and shortcuts respect editing/modal focus')
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    for (const route of ['settings?category=core', 'settings?category=maintenance', 'fleet', 'connections', 'history']) {
      await page.evaluate(route => { location.hash = '/' + route }, route)
      await delay(160)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} overflows ${width}px`)
    }
  }
  await page.screenshot({ path: path.join(out, 'history-mobile.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Panel tools UI passed', screenshots: out }))
} catch (error) { console.error(output.slice(-1500)); throw error }
finally { for (const timer of socketTimers) clearInterval(timer); await browser?.close(); for (const child of children) child.kill() }
