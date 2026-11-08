import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshotDir = path.join(root, '.prizrak-check')
const runtimeErrors = []
const mocks = []
let browser

async function poll(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function startMock(prizrak) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test', PRIZRAK: prizrak ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mocks.push(child)
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  await poll(async () => {
    if (child.exitCode !== null) throw new Error(`Mock exited: ${output}`)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'mock startup')
  return { origin, base: `${origin}/ui/` }
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch { /* Windows browser fallback */ }
  }
  throw new Error('No browser available. Run: npx playwright install chromium')
}

async function session({ locale = 'en', width = 1440, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme })
  await context.addInitScript((locale) => localStorage.setItem('miboard.locale', locale), locale)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  const requests = []
  page.on('request', (request) => requests.push(request))
  return { context, page, requests }
}

const section = (page) => page.locator('section[aria-labelledby="prizrak-heading"]')
const apiPath = (request) => new URL(request.url()).pathname
const historyRequests = (requests) => requests.filter((request) => request.method() === 'POST' && apiPath(request).startsWith('/cache/smart/flush'))
const modelRequests = (requests) => requests.filter((request) => request.method() === 'POST' && apiPath(request) === '/upgrade/lgbm')

async function open(page, server, route, heading) {
  await page.goto(`${server.base}#/${route}?secret=test`)
  await page.getByRole('heading', { name: heading, exact: true }).waitFor()
}

try {
  await mkdir(screenshotDir, { recursive: true })
  const [vanilla, prizrak] = await Promise.all([startMock(false), startMock(true)])
  browser = await launchBrowser()

  const ordinary = await session()
  await open(ordinary.page, vanilla, 'settings', 'Settings')
  await ordinary.page.getByRole('switch', { name: 'TUN', exact: true }).waitFor()
  assert.equal(await section(ordinary.page).count(), 0, 'Ordinary mihomo has no Prizrak settings')
  await open(ordinary.page, vanilla, 'proxies', 'Proxies')
  await ordinary.page.getByRole('button', { name: 'Test all groups', exact: true }).waitFor()
  assert.equal(await ordinary.page.getByRole('button', { name: 'Node weights', exact: true }).count(), 0)
  await open(ordinary.page, vanilla, 'connections', 'Connections')
  assert.equal(await ordinary.page.getByRole('button', { name: /^Switch node for / }).count(), 0)
  assert.equal(historyRequests(ordinary.requests).length, 0)
  assert.equal(modelRequests(ordinary.requests).length, 0)
  await ordinary.context.close()
  console.log('PASS: ordinary mihomo keeps its existing interface without Prizrak actions')

  const main = await session()
  const { page, requests } = main
  await open(page, prizrak, 'settings', 'Settings')
  const settings = section(page)
  await settings.getByRole('heading', { name: 'Prizrak-Core', exact: true }).waitFor()
  for (const text of ['Automatic model updates', '72 h', 'https://example.test/Model.bin', '100 MB']) {
    await settings.getByText(text, { exact: true }).waitFor()
  }
  assert.equal(await settings.getByRole('switch').count(), 0, 'Unsupported PATCH parameters are read-only')
  await settings.getByText(/These parameters are read-only in the API/).waitFor()
  const config = settings.getByLabel('Configuration name (optional)', { exact: true })
  const clear = settings.getByRole('button', { name: 'Clear history', exact: true })
  await clear.click()
  const dialog = page.getByRole('alertdialog', { name: 'Clear Smart history' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(historyRequests(requests).length, 0, 'Cancel does not clear learned history')

  const configName = 'Москва / сеть?#%'
  await config.fill(configName)
  await clear.click()
  assert((await dialog.innerText()).includes(configName))
  await dialog.getByRole('button', { name: 'Clear history', exact: true }).click()
  await settings.getByRole('status').filter({ hasText: 'Smart history cleared' }).waitFor()
  assert.equal(historyRequests(requests).length, 1)
  assert.equal(apiPath(historyRequests(requests)[0]), `/cache/smart/flush/${encodeURIComponent(configName)}`)

  await config.fill('')
  await clear.click()
  await dialog.getByText(/all configurations/).waitFor()
  await dialog.getByRole('button', { name: 'Clear history', exact: true }).click()
  await poll(() => historyRequests(requests).length === 2, 'global history reset')
  assert.equal(apiPath(historyRequests(requests)[1]), '/cache/smart/flush')
  await settings.getByRole('status').filter({ hasText: 'Smart history cleared' }).waitFor()

  const update = settings.getByRole('button', { name: 'Update model', exact: true })
  await update.click()
  await settings.getByRole('status').filter({ hasText: 'LightGBM model updated' }).waitFor()
  assert.equal(modelRequests(requests).length, 1)
  await page.route(`${prizrak.origin}/upgrade/lgbm`, (route) => route.fulfill({ status: 503, json: { error: 'Model download failed' } }))
  await update.click()
  await settings.getByRole('alert').filter({ hasText: 'Model download failed' }).waitFor()
  await update.waitFor({ state: 'visible' })
  assert(await update.isEnabled(), 'Model update can be retried after an API error')
  await page.screenshot({ path: path.join(screenshotDir, 'settings-light.png'), fullPage: true, animations: 'disabled' })
  console.log('PASS: readonly parameters, cancelled/config/global history resets, LightGBM update and errors')

  await open(page, prizrak, 'proxies', 'Proxies')
  const smartParameters = page.locator('section[aria-label="Smart parameters: Smart"]')
  for (const text of ['LightGBM', 'Collect training data', 'Sampling rate', '100%', 'Prefer matching ASN', 'Latency tolerance', '0 ms']) {
    await smartParameters.getByText(text, { exact: true }).waitFor()
  }
  const weights = page.getByRole('button', { name: 'Node weights', exact: true })
  await weights.waitFor()
  await weights.click()
  await page.getByRole('columnheader', { name: 'Weight', exact: true }).waitFor()
  await page.getByRole('cell', { name: '95', exact: true }).waitFor()
  await page.getByRole('cell', { name: 'Frequent', exact: true }).waitFor()
  await page.screenshot({ path: path.join(screenshotDir, 'proxies-smart-light.png'), fullPage: true, animations: 'disabled' })
  const groupRequests = requests.filter((request) => apiPath(request) === '/group/Smart/weights')
  assert.equal(groupRequests.length, 1, 'Rankings load on demand from the group endpoint')
  assert.equal(groupRequests[0].headers().authorization, 'Bearer test')
  const refresh = page.getByRole('button', { name: 'Refresh weights', exact: true })
  await page.route(`${prizrak.origin}/group/Smart/weights`, (route) => route.fulfill({ json: { weights: [] } }))
  await refresh.click()
  await page.getByText('No weight data yet', { exact: true }).waitFor()
  await page.route(`${prizrak.origin}/group/Smart/weights`, (route) => route.fulfill({ status: 503, json: { error: 'Smart cache not available' } }))
  await refresh.click()
  await page.getByRole('alert').filter({ hasText: 'Smart cache not available' }).waitFor()
  assert(await refresh.isEnabled())
  console.log('PASS: Smart node weight rankings, empty data and server error feedback')

  await open(page, prizrak, 'connections', 'Connections')
  const switchNode = page.getByRole('button', { name: 'Switch node for smart.miboard.example.com', exact: true })
  await switchNode.waitFor()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await page.route(/\/connections\/smart\//, (route) => route.fulfill({ status: 503, json: { error: 'Smart unavailable' } }))
  await switchNode.click()
  await page.getByRole('alert').filter({ hasText: 'Could not switch node for smart.miboard.example.com: Smart unavailable' }).waitFor()
  await page.unroute(/\/connections\/smart\//)
  await switchNode.click()
  await page.getByRole('status').filter({ hasText: 'Node switch requested for smart.miboard.example.com; reconnect to the site' }).waitFor()
  assert(requests.some((request) => request.method() === 'DELETE' && apiPath(request).startsWith('/connections/smart/')))
  await poll(() => switchNode.isDisabled(), 'a closed frozen connection cannot switch nodes again')
  console.log('PASS: Smart connections switch node through the dedicated API, report failures and disable stale frozen rows')
  await main.context.close()

  const mobile = await session({ locale: 'ru', width: 375 })
  await open(mobile.page, prizrak, 'settings', 'Настройки')
  await section(mobile.page).getByRole('button', { name: 'Обновить модель', exact: true }).waitFor()
  assert(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Settings fit the 375px viewport')
  await mobile.page.screenshot({ path: path.join(screenshotDir, 'settings-ru-mobile.png'), fullPage: true, animations: 'disabled' })
  await mobile.context.close()
  const mobileProxies = await session({ locale: 'ru', width: 375, colorScheme: 'dark' })
  await open(mobileProxies.page, prizrak, 'proxies', 'Прокси')
  await mobileProxies.page.getByRole('button', { name: 'Веса узлов', exact: true }).click()
  await mobileProxies.page.getByRole('columnheader', { name: 'Вес', exact: true }).waitFor()
  assert(await mobileProxies.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Smart weights fit the 375px viewport')
  await mobileProxies.page.screenshot({ path: path.join(screenshotDir, 'proxies-smart-ru-mobile-dark.png'), fullPage: true, animations: 'disabled' })
  await mobileProxies.context.close()
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors')
  console.log(`PASS: Russian mobile settings; screenshots: ${screenshotDir}`)
} finally {
  await browser?.close()
  await Promise.all(mocks.map(async (child) => {
    if (child.exitCode !== null) return
    const stopped = once(child, 'exit')
    child.kill()
    await stopped
  }))
}
