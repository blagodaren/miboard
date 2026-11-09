import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-proxy-tools-'))
const errors = []
const providerName = 'Subscription / EU?key=#'
const providerNode = 'Node / source?key=#'
const preferences = { mode: 'core', url: 'https://example.org/check?region=eu', timeout: 7123, yellow: 400, red: 800, ipv6: true, independent: true }
let browser
let mock
let mockOutput = ''

async function poll(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 35))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No browser available')
}

try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  let base = `${origin}/ui/`
  if (process.env.MIBOARD_PROXY_TOOLS_UI_URL) {
    const entry = new URL(process.env.MIBOARD_PROXY_TOOLS_UI_URL)
    entry.hash = ''
    for (const [key, value] of Object.entries({ hostname: '127.0.0.1', port, protocol: 'http', secret: 'test' })) entry.searchParams.set(key, String(value))
    base = entry.href
  }
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mock.stdout.on('data', (chunk) => { mockOutput += chunk })
  mock.stderr.on('data', (chunk) => { mockOutput += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(mockOutput)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated mock startup')
  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
  await context.addInitScript((preferences) => {
    if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en')
    localStorage.setItem('miboard.latency.v1', JSON.stringify(preferences))
  }, preferences)
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(10_000)
  const node = (name) => ({ name, type: 'Vless', history: [] })
  let providerVersion = 0
  let providerReads = 0
  let providerUnavailable = false
  const providers = () => ({
    default: { vehicleType: 'HTTP', proxies: [node('hidden-default')] },
    compatible: { vehicleType: 'Compatible', proxies: [node('hidden-compatible')] },
    [providerName]: { name: providerName, vehicleType: 'HTTP', updatedAt: providerVersion ? '2026-11-09T14:00:00Z' : '2026-11-01T12:00:00Z', proxies: [node(providerNode), ...(providerVersion ? [node('newly-loaded')] : [])], subscriptionInfo: { Download: 1024, Upload: 512, Total: 4096, Expire: 1893456000 } },
    'No quota': { vehicleType: 'File', proxies: [], updatedAt: '0001-01-01T00:00:00Z' },
  })
  await page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
    GLOBAL: { name: 'GLOBAL', type: 'Selector', all: ['Test group'], history: [] },
    'Test group': { name: 'Test group', type: 'Selector', all: ['local-node', providerNode], now: 'local-node', history: [] },
    'local-node': node('local-node'),
  } } }))
  await page.route(`${origin}/providers/proxies`, (route) => {
    providerReads++
    return providerUnavailable ? route.fulfill({ status: 404, json: { message: 'Unsupported endpoint' } }) : route.fulfill({ json: { providers: providers() } })
  })

  let seriesCalls = []
  let activeRequests = 0
  let maximumRequests = 0
  let hold = false
  let releaseHeld = () => {}
  let failUpdate = true
  let holdUpdate = false
  let releaseUpdate = () => {}
  let updateCalls = 0
  const providerPath = `/providers/proxies/${encodeURIComponent(providerName)}`
  await page.route(`${origin}/providers/proxies/**`, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'PUT') {
      updateCalls++
      assert.equal(url.pathname, providerPath)
      if (holdUpdate) await new Promise((resolve) => { releaseUpdate = resolve })
      if (failUpdate) return route.fulfill({ status: 500, json: { message: 'Download failed' } }).catch(() => {})
      providerVersion++
      return route.fulfill({ status: 204, body: '' }).catch(() => {})
    }
    assert.equal(url.pathname, `${providerPath}/${encodeURIComponent(providerNode)}/healthcheck`)
    seriesCalls.push({ url: url.searchParams.get('url'), timeout: url.searchParams.get('timeout') })
    const attempt = seriesCalls.length
    activeRequests++
    maximumRequests = Math.max(maximumRequests, activeRequests)
    if (hold) await new Promise((resolve) => { releaseHeld = resolve })
    else await new Promise((resolve) => setTimeout(resolve, 25))
    activeRequests--
    if (attempt === 3 && !hold) return route.fulfill({ status: 504, json: { message: 'Timeout' } }).catch(() => {})
    return route.fulfill({ json: { delay: attempt === 8 && !hold ? 0 : 80 + attempt * 20 } }).catch(() => {})
  })

  await page.goto(`${base}#/proxies?secret=test`)
  const stability = page.getByTestId('proxy-stability')
  const providerPanel = page.getByTestId('proxy-providers')
  await stability.locator('summary').click()
  await providerPanel.locator('summary').click()
  await stability.getByRole('combobox', { name: 'Node to test' }).selectOption({ label: providerNode })
  await stability.getByRole('button', { name: 'Run 10 checks' }).click()
  await poll(() => stability.getByText('Completed 10/10 checks', { exact: true }).isVisible(), 'ten-check series completes')
  assert.equal(seriesCalls.length, 10)
  assert.equal(maximumRequests, 1)
  assert(seriesCalls.every((call) => call.url === preferences.url && call.timeout === '7123'), 'Series uses full timeout and no extra IPv6 probes')
  assert.equal(await stability.locator('[data-stat="median"]').innerText(), '190 ms')
  assert.equal(await stability.locator('[data-stat="p95"]').innerText(), '280 ms')
  assert.equal(await stability.locator('[data-stat="failed"]').innerText(), '2/10')
  assert.equal(await stability.locator('ol > li').count(), 10)
  assert.equal(await providerPanel.locator('[data-provider]').count(), 2)
  const subscription = providerPanel.locator('[data-provider]').filter({ has: page.getByRole('heading', { name: providerName, exact: true }) })
  const noQuota = providerPanel.locator('[data-provider]').filter({ has: page.getByRole('heading', { name: 'No quota', exact: true }) })
  await subscription.getByText('Remaining', { exact: true }).waitFor()
  assert.equal(await noQuota.getByText('Remaining', { exact: true }).count(), 0)
  assert.equal(await noQuota.getByText('Allowance', { exact: true }).count(), 0)
  await noQuota.getByText('Update time not reported').waitFor()
  const updateButton = subscription.getByRole('button', { name: `Update provider ${providerName}`, exact: true })
  await updateButton.click()
  await subscription.getByRole('alert').waitFor()
  assert.match(await subscription.getByRole('alert').innerText(), /Download failed/)
  failUpdate = false
  await updateButton.click()
  await subscription.getByText('Provider updated', { exact: true }).waitFor()
  await subscription.getByText('HTTP · 2 nodes', { exact: true }).waitFor()
  assert.equal(updateCalls, 2)
  assert.equal(await subscription.getByRole('alert').count(), 0)
  assert(providerReads >= 3, 'Metadata is reloaded after a successful update')
  console.log('PASS: ten sequential checks, correct statistics, provider encoding, optional quotas, update error and retry')

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Proxy tools fit ${width}px`)
    await page.screenshot({ path: path.join(screenshots, `proxy-tools-${width}.png`), fullPage: true, animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  seriesCalls = []
  hold = true
  await stability.getByRole('button', { name: 'Run 10 checks' }).click()
  await poll(() => seriesCalls.length === 1, 'first cancellable request starts')
  assert.equal(await page.getByRole('button', { name: 'Test all', exact: true }).isEnabled(), false)
  assert.equal(await updateButton.isEnabled(), false)
  await stability.getByRole('button', { name: 'Cancel series' }).click()
  await stability.getByText('Cancelled after 0/10 checks', { exact: true }).waitFor()
  releaseHeld()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(seriesCalls.length, 1)
  assert.equal(await stability.locator('[data-stat="failed"]').innerText(), '0/0')
  await stability.getByRole('button', { name: 'Run 10 checks' }).click()
  await poll(() => seriesCalls.length === 2, 'second cancellable series starts')
  await page.goto(`${base}#/overview`)
  releaseHeld()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(seriesCalls.length, 2, 'Leaving Proxies cancels the series and all future attempts')
  console.log('PASS: explicit cancellation and navigation stop queued stability checks without counting an error')

  await page.goto(`${base}#/proxies`)
  await providerPanel.locator('summary').click()
  holdUpdate = true
  await updateButton.click()
  await poll(() => updateCalls === 3, 'pending provider update starts')
  const readsBeforeVisible = providerReads
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(providerReads, readsBeforeVisible, 'Returning to a busy page does not race the provider metadata refresh')
  const readsBeforeLeave = providerReads
  await page.goto(`${base}#/overview`)
  releaseUpdate()
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(providerReads, readsBeforeLeave, 'A cancelled provider update does not refresh a departed page')
  providerUnavailable = true
  await page.goto(`${base}#/proxies`)
  await providerPanel.locator('summary').click()
  await providerPanel.getByText('Provider information is unavailable from this core', { exact: true }).waitFor()
  providerUnavailable = false
  await providerPanel.getByRole('button', { name: 'Reload providers', exact: true }).click()
  await subscription.getByText('HTTP · 2 nodes', { exact: true }).waitFor()
  console.log('PASS: provider update cancellation, unsupported metadata and retry')
  await page.evaluate(() => {
    localStorage.setItem('miboard.locale', 'ru')
    localStorage.setItem('miboard.theme', 'dark')
  })
  hold = false
  holdUpdate = false
  seriesCalls = []
  await page.reload()
  await stability.locator('summary').click()
  await providerPanel.locator('summary').click()
  await stability.getByRole('combobox', { name: 'Нода для проверки' }).selectOption({ label: providerNode })
  await stability.getByRole('button', { name: 'Запустить 10 проверок' }).click()
  await stability.getByText('Завершено 10/10 проверок', { exact: true }).waitFor()
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Russian proxy tools fit ${width}px`)
    await page.screenshot({ path: path.join(screenshots, `proxy-tools-ru-dark-${width}.png`), fullPage: true, animations: 'disabled' })
  }
  console.log('PASS: expanded Russian tools and results fit 320/390px in the dark theme')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`Screenshots: ${screenshots}`)
  await context.close()
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const stopped = once(mock, 'exit')
    mock.kill()
    await stopped
  }
}
