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
  await context.route('**/storage/**', async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().postDataJSON())
    await route.continue()
  })
  async function page(initial = 100) {
    const p = await context.newPage(); p.on('pageerror', error => errors.push(error.message)); p.setDefaultTimeout(12000)
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
  await poll(async () => (await read(first.page))[0]?.down === 50, 'first delta')
  const second = await page(150)
  await second.page.getByText('Another tab is recording; these tabs share one history', { exact: true }).waitFor()
  first.send(250); second.send(250)
  await poll(async () => (await read(first.page))[0]?.down === 150, 'single writer across two tabs')
  await second.page.close()
  first.initial(1000)
  await first.page.reload(); await first.page.getByTestId('long-history').waitFor(); await delay(200)
  await poll(async () => { first.send(1000); return (await first.page.getByText('Recording observed increments', { exact: true }).count()) === 1 }, 'recording after reload', 20000)
  assert.equal((await read(first.page))[0].down, 150, 'reload establishes a baseline')
  await delay(100); first.send(1050)
  await poll(async () => (await read(first.page))[0]?.down === 200, 'post-reload increment')
  await first.page.getByRole('button', { name: 'Read snapshot', exact: true }).click()
  await first.page.getByRole('button', { name: 'Publish this browser’s snapshot', exact: true }).click()
  await first.page.getByText('Snapshot saved and verified', { exact: true }).waitFor()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].days[0].down, 200)
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
  assert.deepEqual(errors, [])
  console.log(`PASS: real IndexedDB, two tabs, reload baseline, retention, shared snapshot, mobile and subscription forecast. Screenshots: ${out}`)
  await context.close()
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const closed = once(mock, 'exit').catch(() => {}); mock.kill(); await closed }
}
