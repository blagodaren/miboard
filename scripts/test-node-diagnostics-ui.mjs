// Isolated fixtures only: never read browser profiles or contact a user controller.
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
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-node-diagnostics-'))
const errors = [], writes = [], tests = []
let browser, mock, output = ''
const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
const port = server.address().port; await new Promise(resolve => server.close(resolve))
const origin = `http://127.0.0.1:${port}`
const base = process.env.MIBOARD_NODE_DIAGNOSTICS_UI_URL ?? `${origin}/ui/`
const groupName = 'Diagnostics fixture'
const nodeName = 'Region / A'
const providerName = 'Subscription / primary'
const urlA = 'https://check-a.example/204', urlB = 'https://check-b.example/204'
const sample = (delay, second) => ({ time: new Date(Date.UTC(2026, 10, 10, 12, 0, second)).toISOString(), delay })
const node = { name: nodeName, type: 'Vless', udp: true, uot: false, xudp: true, tfo: false, mptcp: true, smux: false, interface: 'eth0', 'routing-mark': 42, 'dialer-proxy': 'upstream', history: [sample(999, 0)], extra: { [urlA]: { alive: true, history: [sample(61, 1), sample(0, 2), sample(73, 3)] }, [urlB]: { alive: true, history: [sample(220, 1)] } } }
let reads = 0
async function poll(check, label, timeout = 15000) {
  const until = Date.now() + timeout
  do { if (await check()) return; await delay(50) } while (Date.now() < until)
  throw new Error(`Timed out: ${label}`)
}

try {
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 'mock startup')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) { try { browser = await chromium.launch({ headless: true, ...options }); break } catch {} }
  assert(browser, 'Browser available')
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(() => { if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en'); if (!localStorage.getItem('miboard.theme')) localStorage.setItem('miboard.theme', 'light') })
  const page = await context.newPage()
  await page.clock.install()
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().startsWith(origin) && request.method() !== 'GET') writes.push(request.url()); if (request.url().startsWith(origin) && /healthcheck|\/delay(?:\?|$)/.test(request.url())) tests.push(request.url()) })
  await page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies: { [groupName]: { name: groupName, type: 'Selector', all: [nodeName, 'Region B'], now: 'Region B', history: [] }, [nodeName]: node, 'Region B': { name: 'Region B', type: 'Trojan', history: [] } } } }))
  const expiry = Math.floor(Date.now() / 1000) + 2 * 86400
  await page.route(`${origin}/providers/proxies`, route => {
    reads++
    return route.fulfill({ json: { providers: {
      [providerName]: { name: providerName, vehicleType: 'HTTP', testUrl: urlA, expectedStatus: '204', proxies: [node], subscriptionInfo: { Download: 91, Upload: 0, Total: 100, Expire: expiry } },
      'Second provider': { vehicleType: 'File', proxies: [{ name: nodeName, type: 'Trojan', history: [sample(444, 0)] }] },
    } } })
  })
  await page.goto(`${base}?hostname=127.0.0.1&port=${port}&secret=test#/proxies`)
  const groupOpener = page.locator(`[data-testid="node-diagnostics-open"][data-node="${nodeName}"]`)
  const primary = page.locator(`[data-provider="${providerName}"]`)
  const opener = primary.getByTestId('provider-node-diagnostics')
  async function openPrimaryDiagnostics() {
    await groupOpener.click()
    await page.getByTestId('proxy-providers').waitFor()
    assert.equal(await page.getByTestId('node-diagnostics').count(), 0, 'Ambiguous group metadata requires an explicit provider choice')
    await primary.locator('summary').click()
    await opener.click()
  }
  await groupOpener.waitFor()
  const notice = page.getByTestId('provider-subscription-alert')
  await notice.waitFor()
  assert.match(await notice.innerText(), /Less than 10%/)
  assert.match(await notice.innerText(), /within the next 3 days/)
  await notice.getByRole('button', { name: 'Dismiss notification' }).click()
  await openPrimaryDiagnostics()
  const dialog = page.getByTestId('node-diagnostics')
  await dialog.waitFor()
  assert.equal(await page.getByTestId('node-history-source').inputValue(), `url:${urlA}`)
  assert.deepEqual(await dialog.locator('[data-history-delay]').evaluateAll(rows => rows.map(row => Number(row.dataset.historyDelay))), [73, 0, 61])
  assert.match(await dialog.getByTestId('node-capabilities').innerText(), /UDP[\s\S]*Enabled/)
  assert.match(await dialog.getByTestId('node-capabilities').innerText(), /UOT[\s\S]*Disabled/)
  assert.match(await dialog.innerText(), /eth0/)
  assert.match(await dialog.innerText(), /Expected HTTP status[\s\S]*204/)
  await page.getByTestId('node-history-source').selectOption(`url:${urlB}`)
  assert.deepEqual(await dialog.locator('[data-history-delay]').evaluateAll(rows => rows.map(row => Number(row.dataset.historyDelay))), [220])
  await page.getByTestId('node-history-source').selectOption('generic')
  assert.deepEqual(await dialog.locator('[data-history-delay]').evaluateAll(rows => rows.map(row => Number(row.dataset.historyDelay))), [999])
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert(await opener.evaluate(element => element === document.activeElement), 'Escape restores opener focus')
  assert.equal(await page.locator('[data-proxy-node="Region B"] > button').first().getAttribute('aria-pressed'), 'true', 'Inspecting does not select another node')
  assert.deepEqual(writes, []); assert.deepEqual(tests, [])

  await page.getByRole('tab', { name: 'Providers', exact: true }).click()
  const secondary = page.locator('[data-provider="Second provider"]')
  await secondary.locator('summary').click()
  await secondary.getByTestId('provider-node-diagnostics').click()
  await dialog.waitFor()
  assert.match(await dialog.innerText(), /Trojan/)
  assert.deepEqual(await dialog.locator('[data-history-delay]').evaluateAll(rows => rows.map(row => Number(row.dataset.historyDelay))), [444], 'Provider-specific duplicate names retain their own metadata')
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByTestId('proxy-providers').waitFor()
  await delay(300)
  assert.equal(await page.getByTestId('provider-subscription-alert').count(), 0, 'Warnings remain deduplicated after reload')

  await page.goto(`${base}#/settings`)
  await chooseSettingsCategory(page, 'proxies')
  const toggle = page.getByTestId('provider-alert-toggle').getByRole('switch')
  await toggle.waitFor(); await toggle.click()
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  await page.evaluate(origin => {
    const key = 'miboard.provider-alerts:' + encodeURIComponent(origin)
    const state = JSON.parse(localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify({ ...state, seen: {} }))
  }, origin)
  const beforeDisabledReload = reads
  await page.reload(); await toggle.waitFor(); await delay(250)
  assert.equal(reads, beforeDisabledReload + 1, 'Forecast sampling still reads metadata once when subscription warnings are disabled')
  assert.equal(await page.getByTestId('provider-subscription-alert').count(), 0, 'Opt-out suppresses even previously unseen warnings')
  const beforeEnabled = reads
  await toggle.click()
  await poll(() => reads > beforeEnabled, 'Opt-in refreshes metadata for warnings')
  await page.getByTestId('provider-subscription-alert').waitFor()
  await page.getByTestId('provider-subscription-alert').getByRole('button', { name: 'Dismiss notification', exact: true }).click()
  const beforePolling = reads
  await page.clock.fastForward(9 * 60000)
  assert.equal(reads, beforePolling, 'No metadata polling before 10 minutes')
  await page.clock.fastForward(60000)
  await poll(() => reads > beforePolling, 'Metadata poll at 10 minutes')
  assert.equal(await page.getByTestId('provider-subscription-alert').count(), 0, 'Repeated metadata poll does not repeat unchanged warnings')
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  const beforeHidden = reads
  await page.clock.fastForward(10 * 60000)
  assert.equal(reads, beforeHidden, 'Hidden panel does not poll metadata')
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  await poll(() => reads > beforeHidden, 'Visible panel refreshes overdue metadata')

  for (const locale of ['en', 'ru']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ locale, theme }) => { localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme) }, { locale, theme })
    await page.goto(`${base}#/proxies`)
    await page.reload()
    await openPrimaryDiagnostics()
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `No horizontal overflow at ${width}`)
      assert(await dialog.evaluate(element => element.getBoundingClientRect().left >= 0 && element.getBoundingClientRect().right <= innerWidth), `Dialog fits ${width}`)
      await page.screenshot({ path: path.join(screenshots, `${locale}-${theme}-${width}.png`), animations: 'disabled' })
    }
    await page.keyboard.press('Escape')
  }
  assert.deepEqual(writes, []); assert.deepEqual(tests, []); assert.deepEqual(errors, [])
  console.log(`PASS: isolated URL histories, capabilities, provider duplicates, no writes/tests, warning dedup and opt-out, responsive dialog. Screenshots: ${screenshots}`)
  await context.close()
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error((await page.locator('body').textContent()).slice(0, 2500))
    await page.screenshot({ path: path.join(screenshots, 'failure.png'), fullPage: true }).catch(() => {})
  }
  if (!browser) console.error(output)
  throw error
} finally {
  await browser?.close()
  if (mock?.exitCode === null) { const closed = once(mock, 'exit'); mock.kill(); await closed }
}
