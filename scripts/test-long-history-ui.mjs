// Fresh browser contexts and an ephemeral mock only; no saved controller is contacted.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = await mkdtemp(path.join(os.tmpdir(), 'miboard-history-'))
let browser, mock, origin, output = ''
const errors = []
const dayBoundary = (Math.floor(Date.now() / 86400000) + 1) * 86400000
const totalDownloaded = (rows, backend = origin) => rows.filter(row => row.backend === backend).reduce((sum, row) => sum + row.down, 0)
async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  do { if (await check()) return; await delay(50) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function port() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}
const conn = download => ({ id: 'history-fixture', download, upload: 10, start: '2026-11-13T00:00:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '', metadata: { network: 'tcp', type: 'HTTP', sourceIP: '192.168.1.20', sourcePort: '1000', destinationIP: '1.1.1.1', destinationPort: '443', host: 'history.example' } })
const snapshot = download => JSON.stringify({ uploadTotal: 10, downloadTotal: download, connections: [conn(download)] })
async function read(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('miboard-long-history', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('hours'), get = tx.objectStore('hours').getAll()
      get.onsuccess = () => { db.close(); resolve(get.result) }; get.onerror = () => reject(get.error)
    }
  }))
}
try {
  origin = `http://127.0.0.1:${await port()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', value => { output += value }); mock.stderr.on('data', value => { output += value })
  await poll(async () => { try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) { try { browser = await chromium.launch({ headless: true, ...options }); break } catch {} }
  if (!browser) throw new Error('No browser installed')
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' })
  await stubAppUpdates(context)
  await context.addInitScript(origin => { localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' })); localStorage.setItem('miboard.locale', 'en'); localStorage.setItem('miboard.live-updates', 'always') }, origin)
  const writes = []
  let clockInstalled = false
  await context.route('**/storage/**', async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON())
    await route.continue()
  })
  async function page(initial = 100) {
    const p = await context.newPage(); p.on('pageerror', error => errors.push(error.message)); p.setDefaultTimeout(12000)
    if (!clockInstalled) {
      // Playwright shares one clock across the context, including reloads and
      // new tabs. Install before navigation so timers keep their normal order.
      await p.clock.install({ time: dayBoundary - 1800000 })
      clockInstalled = true
    }
    let socket
    await p.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; ws.send(snapshot(initial)) })
    await p.goto(`${origin}/ui/#/history`)
    await p.getByTestId('long-history').waitFor()
    await poll(() => !!socket, 'connection socket')
    await delay(150)
    socket.send(snapshot(initial))
    return { page: p, initial: value => { initial = value }, send: value => socket.send(snapshot(value)) }
  }
  const first = await page()
  await poll(async () => (await read(first.page)).length === 1, 'baseline')
  first.send(150)
  await poll(async () => totalDownloaded(await read(first.page)) === 50, 'first delta')
  const second = await page(150)
  await second.page.getByText('Another tab is recording; these tabs share one history', { exact: true }).waitFor()
  first.send(250); second.send(250)
  await poll(async () => totalDownloaded(await read(first.page)) === 150, 'single writer across two tabs')
  await second.page.close()
  first.initial(1000)
  // Reproduce the CI race at the UTC hour/day boundary deterministically:
  // reloading establishes the baseline before midnight, then the next frame
  // crosses into a second bucket. Reading only row zero loses part of the sum.
  await first.page.clock.setFixedTime(dayBoundary - 1000)
  await first.page.reload(); await first.page.getByTestId('long-history').waitFor(); await delay(200)
  await poll(async () => { first.send(1000); return (await first.page.getByText('Recording observed increments', { exact: true }).count()) === 1 }, 'recording after reload', 20000)
  assert.equal(totalDownloaded(await read(first.page)), 150, 'reload establishes a baseline')
  await first.page.clock.setFixedTime(dayBoundary + 1000)
  first.send(1050)
  await poll(async () => totalDownloaded(await read(first.page)) === 200, 'post-reload increment across UTC midnight')
  assert.deepEqual((await read(first.page)).filter(row => row.backend === origin).map(({ hour, down }) => ({ hour, down })), [
    { hour: dayBoundary - 3600000, down: 175 },
    { hour: dayBoundary, down: 25 },
  ], 'the increment is split between hours without loss or duplication')
  await first.page.clock.setSystemTime(dayBoundary + 1000)
  await first.page.getByRole('button', { name: 'Read snapshot', exact: true }).click()
  await first.page.getByRole('button', { name: 'Publish this browser’s snapshot', exact: true }).click()
  await first.page.getByText('Snapshot saved and verified', { exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].days.reduce((sum, day) => sum + day.down, 0), 200)
  assert.deepEqual(writes[0].days.map(({ day, down }) => ({ day, down })), [
    { day: dayBoundary - 86400000, down: 175 },
    { day: dayBoundary, down: 25 },
  ], 'daily shares preserve both sides of UTC midnight')
  assert.ok(!JSON.stringify(writes[0]).includes(origin)); assert.ok(!JSON.stringify(writes[0]).includes('secret'))
  await first.page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('miboard-long-history', 1)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('hours', 'readwrite')
      const hour = Math.floor((Date.now() - 31 * 86400000) / 3600000) * 3600000
      tx.objectStore('hours').put({ backend: 'old-fixture', hour, down: 999, up: 0, observedMs: 0, gaps: 0, devices: [], domains: [] })
      tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
    }
  }))
  await first.page.reload(); await first.page.getByTestId('long-history').waitFor()
  await poll(async () => (await read(first.page)).every(row => row.backend !== 'old-fixture'), 'global retention prune')

  await first.page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('miboard-long-history', 1)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('hours', 'readwrite')
      const hour = Math.floor(Date.now() / 3600000) * 3600000
      tx.objectStore('hours').put({ backend: 'other-controller', hour, down: 777, up: 0, observedMs: 0, gaps: 0, devices: [], domains: [] })
      tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
    }
  }))
  const beforeClear = await read(first.page)
  const clearButton = first.page.getByTestId('long-history').getByRole('button', { name: 'Clear history', exact: true })
  await clearButton.click()
  const clearDialog = first.page.getByRole('alertdialog', { name: 'Clear history for this controller?' })
  await clearDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await clearDialog.waitFor({ state: 'hidden' })
  assert.deepEqual(await read(first.page), beforeClear, 'cancelling does not delete history')

  // Abort only the clear transaction; a failed deletion must keep the data and
  // remain retryable instead of announcing success or clearing only the UI.
  await first.page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args)
      if (Array.isArray(args[0]) && args[0][0] === 'hours' && args[0][1] === 'leases' && args[1] === 'readwrite') {
        IDBDatabase.prototype.transaction = transaction
        queueMicrotask(() => tx.abort())
      }
      return tx
    }
  })
  await clearButton.click()
  await clearDialog.getByRole('button', { name: 'Clear history', exact: true }).click()
  await first.page.getByText('Could not clear history. Saved data was not deleted; try again.', { exact: true }).waitFor()
  assert.deepEqual(await read(first.page), beforeClear, 'aborted clear preserves all buckets')
  await poll(async () => {
    first.send(1300)
    return (await first.page.getByText('Recording observed increments', { exact: true }).count()) === 1
  }, 'recording after an aborted clear', 20000)

  const clearingTab = await page(1300)
  await clearingTab.page.getByText('Another tab is recording; these tabs share one history', { exact: true }).waitFor()
  await clearingTab.page.getByRole('button', { name: 'Clear history', exact: true }).click()
  // A snapshot from the writer can already be in flight when another tab clears.
  const confirmedClear = clearingTab.page.getByRole('alertdialog').getByRole('button', { name: 'Clear history', exact: true }).click()
  first.send(5000)
  await confirmedClear
  await clearingTab.page.getByText('History for this controller was cleared. New observations continue to be recorded.', { exact: true }).waitFor()
  await poll(async () => (await read(first.page)).filter(row => row.backend === origin).length === 0, 'clear wins over an in-flight writer')
  await first.page.getByText('No history yet. Keep the panel connected to observe traffic.', { exact: true }).waitFor()
  await clearingTab.page.getByText('No history yet. Keep the panel connected to observe traffic.', { exact: true }).waitFor()
  assert.deepEqual(await read(first.page), beforeClear.filter(row => row.backend === 'other-controller'), 'other controllers are preserved')
  assert.equal(writes.length, 1, 'clearing browser history does not change shared snapshots')

  first.send(100000)
  await poll(async () => (await read(first.page)).filter(row => row.backend === origin).length === 1, 'fresh baseline after clear')
  assert.equal(totalDownloaded(await read(first.page)), 0, 'old counters do not return after clear')
  clearingTab.send(100000)
  await delay(100)
  first.send(100100); clearingTab.send(100100)
  await poll(async () => totalDownloaded(await read(first.page)) === 100, 'only new increments are recorded after clear')
  await clearingTab.page.close()
  first.initial(100100)
  await first.page.reload(); await first.page.getByTestId('long-history').waitFor()
  assert.equal(totalDownloaded(await read(first.page)), 100, 'cleared history stays cleared after reload')
  await first.page.setViewportSize({ width: 375, height: 900 })
  await first.page.screenshot({ path: path.join(out, 'history-mobile.png'), fullPage: true })
  assert.equal(await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile does not overflow')

  let providerTime = Date.now() - 86400000, used = 100
  await context.route('**/providers/proxies', route => route.fulfill({ json: { providers: { Fixture: { vehicleType: 'HTTP', proxies: [], updatedAt: new Date(providerTime).toISOString(), subscriptionInfo: { Download: used, Upload: 0, Total: 1000 } } } } }))
  await first.page.goto(`${origin}/ui/#/proxies?tab=providers`)
  await first.page.getByTestId('subscription-forecast').waitFor()
  assert.match(await first.page.getByTestId('subscription-forecast').textContent(), /Waiting for two/)
  providerTime += 86400000; used = 200
  await first.page.reload()
  await first.page.getByTestId('subscription-forecast').getByText(/About .* days at/).waitFor()

  await first.page.evaluate(() => { location.hash = '/settings?category=appearance' })
  await first.page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await first.page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
  await first.page.waitForFunction(() => document.documentElement.lang === 'ru')
  await first.page.evaluate(() => { location.hash = '/history' })
  await first.page.getByTestId('long-history').waitFor()
  const beforeEscape = await read(first.page)
  await first.page.getByRole('button', { name: 'Очистить историю', exact: true }).click()
  const ruClear = first.page.getByRole('alertdialog', { name: 'Очистить историю этого ядра?' })
  await ruClear.waitFor()
  await poll(() => ruClear.evaluate(element => element.contains(document.activeElement)), 'focus enters clear confirmation')
  if (await ruClear.evaluate(element => element === document.activeElement)) await first.page.keyboard.press('Tab')
  assert.equal(await ruClear.getByRole('button', { name: 'Отмена', exact: true }).evaluate(element => element === document.activeElement), true, 'Cancel is the first keyboard action')
  assert.equal(await first.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Russian clear dialog has no horizontal overflow')
  const bounds = await ruClear.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 375 && bounds.y + bounds.height <= 900, 'Russian clear dialog fits mobile viewport')
  await first.page.screenshot({ path: path.join(out, 'history-clear-ru-dark-375.png'), fullPage: true })
  await first.page.keyboard.press('Escape')
  await ruClear.waitFor({ state: 'hidden' })
  const afterEscape = await read(first.page)
  assert.equal(totalDownloaded(afterEscape), totalDownloaded(beforeEscape), 'Escape preserves controller history')
  assert.deepEqual(afterEscape.filter(row => row.backend === 'other-controller'), beforeEscape.filter(row => row.backend === 'other-controller'))
  assert.deepEqual(errors, [])
  console.log(`PASS: real IndexedDB, two tabs, reload across UTC midnight, hourly/daily totals, retention, confirmed isolated clear, failed-clear recovery, shared snapshot, RU dark mobile confirmation/Cancel/Escape and subscription forecast. Screenshots: ${out}`)
  await context.close()
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const closed = once(mock, 'exit').catch(() => {}); mock.kill(); await closed }
}
