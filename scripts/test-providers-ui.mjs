// Provider fixtures use ephemeral local mocks and fresh contexts, never saved user controllers.
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
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-providers-'))
const providerName = 'HTTP / EU?key=#'
const sharedName = 'Duplicate / node?key=#'
const groupName = 'Provider test group'
const providerUrl = 'https://provider.example/health?region=eu'
const errors = []
let browser
let mock
let otherMock
let mockOutput = ''
async function poll(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  do {
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(`Mock stopped: ${mockOutput}`)
    if (await check()) return
    await delay(35)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No supported browser available')
}
const sample = delay => ({ time: '2026-11-09T12:00:00Z', delay })
const endpoint = (name, type = 'Vless', delay = 83) => ({
  name, type, udp: true, history: [sample(999)],
  extra: { [providerUrl]: { alive: delay !== 0, history: delay === null ? [] : [sample(delay)] }, 'https://unrelated.example/check': { alive: true, history: [sample(5)] } },
})

try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const base = process.env.MIBOARD_PROVIDERS_UI_URL ?? `${origin}/ui/`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  mock.stdout.on('data', chunk => { mockOutput += chunk })
  mock.stderr.on('data', chunk => { mockOutput += chunk })
  await poll(async () => { try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 'mock startup')
  browser = await launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(() => { if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en') })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  const failedRequests = []
  page.on('requestfailed', request => failedRequests.push(request.url()))
  let reads = 0
  let updated = 0
  let checked = 0
  let failBatch = false
  let heldOperation = null
  let releaseHeld = () => {}
  let activeOperations = 0
  let maximumOperations = 0
  const operations = []
  const manyNodes = () => Array.from({ length: 105 + updated }, (_, index) => endpoint(
    index === 0 ? sharedName : `Node ${String(index).padStart(3, '0')}`,
    index === 102 ? '' : index % 3 === 1 ? 'Trojan' : index % 3 === 2 ? 'Hysteria2' : 'Vless',
    checked ? 75 : index === 1 ? 0 : index === 2 ? null : 83 + index,
  ))
  const providerData = () => ({
    default: { vehicleType: 'HTTP', proxies: [endpoint('hidden default')] },
    compatible: { vehicleType: 'Compatible', proxies: [endpoint('hidden compatible')] },
    [providerName]: { name: providerName, vehicleType: 'HTTP', testUrl: providerUrl, expectedStatus: '200-299', updatedAt: updated ? '2026-11-09T14:00:00Z' : '2026-11-01T12:00:00Z', proxies: manyNodes(), subscriptionInfo: { Download: 1000, Upload: 500, Total: 10000, Expire: 1893456000 } },
    'File source': { name: 'File source', vehicleType: 'File', updatedAt: '2026-11-02T12:00:00Z', proxies: [{ name: sharedName, type: 'Trojan', history: [sample(901)] }] },
    'No quota': { name: 'No quota', vehicleType: 'HTTP', updatedAt: '0001-01-01T00:00:00Z', proxies: [] },
    'Partial quota': { name: 'Partial quota', vehicleType: 'File', proxies: [], subscriptionInfo: { Download: 500, Total: 10000, Expire: 0 } },
    'Expired source': { name: 'Expired source', vehicleType: 'HTTP', proxies: [], subscriptionInfo: { Download: 1200, Upload: 100, Total: 1000, Expire: 1609459200 } },
  })
  await page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies: {
    GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [groupName], now: groupName, history: [] },
    [groupName]: { name: groupName, type: 'Selector', all: [sharedName, 'local-node'], now: 'local-node', history: [] },
    'local-node': { name: 'local-node', type: 'Direct', history: [] },
  } } }))
  await page.route(`${origin}/providers/proxies`, route => { reads++; return route.fulfill({ json: { providers: providerData() } }) })
  await page.route(`${origin}/providers/proxies/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const match = url.pathname.match(/^\/providers\/proxies\/([^/]+)(\/healthcheck)?$/)
    assert(match, `Unexpected provider endpoint: ${url.pathname}`)
    const name = decodeURIComponent(match[1])
    const operation = match[2] ? 'health' : 'update'
    assert.equal(request.method(), operation === 'health' ? 'GET' : 'PUT')
    assert.equal(url.search, '', 'Provider healthcheck uses core settings, not panel URL or timeout parameters')
    assert.equal(url.pathname, `/providers/proxies/${encodeURIComponent(name)}${operation === 'health' ? '/healthcheck' : ''}`)
    operations.push({ operation, name, url: url.href })
    activeOperations++; maximumOperations = Math.max(maximumOperations, activeOperations)
    try {
      if (heldOperation === operation) await new Promise(resolve => { releaseHeld = resolve })
      else await delay(30)
      if (failBatch && operation === 'update' && name === 'File source') return route.fulfill({ status: 500, json: { message: 'fixture download failed' } }).catch(() => {})
      if (operation === 'health') checked++
      else if (name === providerName) updated++
      return route.fulfill({ status: 204, body: '' }).catch(() => {})
    } finally { activeOperations-- }
  })

  const entry = new URL(base)
  entry.search = ''
  entry.hash = `/proxies?tab=providers&hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
  await page.goto(entry.href)
  const providersTab = page.getByRole('tab', { name: 'Providers', exact: true })
  const groupsTab = page.getByRole('tab', { name: 'Groups', exact: true })
  const panel = page.getByTestId('proxy-providers')
  const provider = name => panel.locator('[data-provider]').filter({ has: page.getByRole('heading', { name, exact: true }) })
  const subscription = provider(providerName)
  const nodes = subscription.getByTestId('provider-node-list')
  const nodeRows = nodes.getByTestId('provider-node-row')
  await subscription.waitFor()
  assert.equal(await providersTab.getAttribute('aria-selected'), 'true')
  assert.equal(await panel.locator('[data-provider]').count(), 5, 'Default and Compatible are not external providers')
  assert.match(new URL(page.url()).hash, /tab=providers/)
  await page.reload()
  await subscription.waitFor()
  assert.equal(await providersTab.getAttribute('aria-selected'), 'true', 'The provider deep link survives reload')
  await groupsTab.click()
  await groupsTab.focus()
  await groupsTab.press('ArrowRight')
  await poll(async () => await providersTab.getAttribute('aria-selected') === 'true', 'keyboard switches to providers')
  await page.goBack()
  await poll(async () => await groupsTab.getAttribute('aria-selected') === 'true', 'history back restores Groups')
  await page.goForward()
  await poll(async () => await providersTab.getAttribute('aria-selected') === 'true', 'history forward restores Providers')

  await provider('No quota').getByText('Update time not reported', { exact: true }).waitFor()
  assert.equal(await provider('No quota').getByText('Allowance', { exact: true }).count(), 0)
  assert.equal(await provider('No quota').getByText('Remaining', { exact: true }).count(), 0)
  const partialRemaining = provider('Partial quota').locator('dl > div').filter({ has: page.getByText('Remaining', { exact: true }) })
  assert.equal((await partialRemaining.locator('dd').innerText()).trim(), 'Not reported', 'Missing upload cannot imply a known remaining allowance')
  assert.equal(await provider('Partial quota').getByText(/1970|^Expired/).count(), 0, 'A zero expiry cannot look like an expired subscription')
  await provider('Expired source').locator('dd').filter({ hasText: /^Expired / }).waitFor()
  const exhausted = provider('Expired source').locator('dl > div').filter({ has: page.getByText('Remaining', { exact: true }) })
  assert.match(await exhausted.innerText(), /0 B/, 'Exhausted quota is clamped to zero instead of becoming negative')
  await panel.getByTestId('providers-search').getByRole('searchbox').fill('File')
  assert.equal(await panel.locator('[data-provider]').count(), 2, 'Provider search includes the source type')
  await panel.getByTestId('providers-search').getByRole('searchbox').fill('')

  await subscription.getByTestId('provider-nodes').locator('summary').click()
  await poll(async () => await nodeRows.count() === 50, 'first node page contains 50 rows')
  await nodes.getByTestId('provider-nodes-next').click()
  assert.equal(await nodeRows.count(), 50)
  await nodes.getByTestId('provider-nodes-next').click()
  assert.equal(await nodeRows.count(), 5)
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill('Node 104')
  assert.equal(await nodeRows.count(), 1, 'Node search covers pages which have not been rendered')
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill('')
  assert.equal(await nodeRows.count(), 50)
  assert.match(await nodes.getByTestId('provider-nodes-page').innerText(), /1.*3/)
  await nodes.getByTestId('provider-nodes-protocol').selectOption('Trojan')
  assert.equal(await nodeRows.count(), 35)
  for (const row of await nodeRows.all()) assert.equal((await row.getByRole('cell').nth(1).innerText()).trim(), 'Trojan')
  await nodes.getByTestId('provider-nodes-protocol').selectOption('')
  assert.equal(await nodeRows.count(), 1, 'A missing protocol is distinct from All protocols')
  assert.equal((await nodeRows.first().getByRole('cell').nth(1).innerText()).trim(), 'Type not reported')
  await nodes.getByTestId('provider-nodes-protocol').selectOption('*')
  await nodes.getByTestId('provider-nodes-sort').selectOption('latency')
  assert.equal((await nodeRows.first().getByRole('cell').nth(3).innerText()).trim(), '83 ms')
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill(sharedName)
  const shared = nodeRows.first()
  assert.equal((await shared.getByRole('cell').nth(1).innerText()).trim(), 'Vless')
  assert.equal((await shared.getByRole('cell').nth(3).innerText()).trim(), '83 ms', 'Provider testUrl history overrides unrelated generic latency')
  const file = provider('File source')
  await file.getByTestId('provider-nodes').locator('summary').click()
  const fileShared = file.getByTestId('provider-node-row').first()
  assert.equal((await fileShared.getByRole('cell').nth(0).innerText()).trim(), sharedName)
  assert.equal((await fileShared.getByRole('cell').nth(1).innerText()).trim(), 'Trojan')
  assert.equal((await fileShared.getByRole('cell').nth(3).innerText()).trim(), '901 ms', 'Same-named nodes remain separate across providers')
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill('Node 002')
  assert.equal((await nodeRows.first().getByRole('cell').nth(2).innerText()).trim(), 'Unmeasured', 'alive=true without a matching measurement remains unknown')
  assert.equal((await nodeRows.first().getByRole('cell').nth(3).innerText()).trim(), '—', 'An empty matching history is not a successful measurement')
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill('Node 001')
  assert.equal((await nodeRows.first().getByRole('cell').nth(2).innerText()).trim(), 'No response')
  assert.equal((await nodeRows.first().getByRole('cell').nth(3).innerText()).trim(), '—', 'A failed matching history does not reuse unrelated success')
  console.log('PASS: tabs/deep-link/history/keyboard, honest quotas/expiry and provider-local node search, pagination, protocols and latency')

  await groupsTab.click()
  const groupPanel = page.getByRole('tabpanel', { name: 'Groups', exact: true })
  const groupCard = groupPanel.locator('section').filter({ has: page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true }) })
  await groupPanel.getByRole('searchbox').first().fill('Duplicate')
  const groupSort = groupCard.getByRole('combobox', { name: `Sort nodes in ${groupName}`, exact: true })
  await groupSort.selectOption('name')
  await providersTab.click(); await groupsTab.click()
  assert.equal(await groupPanel.getByRole('searchbox').first().inputValue(), 'Duplicate')
  assert.equal(await groupSort.inputValue(), 'name')
  await groupPanel.getByRole('searchbox').first().fill('')
  const toggle = groupCard.getByRole('button', { expanded: true }).first()
  await toggle.click()
  await providersTab.click(); await groupsTab.click()
  assert.equal(await groupCard.getByRole('button', { expanded: false }).count(), 1, 'Switching subtabs preserves a collapsed group')
  await providersTab.click()
  const beforeHealth = reads
  await subscription.getByTestId('provider-healthcheck').click()
  await poll(() => checked > 0 && reads > beforeHealth, 'core provider healthcheck followed by metadata reload')
  await subscription.getByTestId('provider-nodes').locator('summary').click()
  await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill(sharedName)
  await poll(async () => (await nodeRows.first().getByRole('cell').nth(3).innerText()).trim() === '75 ms', 'healthcheck displays fresh core data')
  assert(operations.some(call => call.operation === 'health' && call.name === providerName && call.url.endsWith(`${encodeURIComponent(providerName)}/healthcheck`)))
  await subscription.getByTestId('provider-update').click()
  await poll(async () => updated === 1 && (await subscription.innerText()).includes('106 nodes'), 'single provider update reloads its node count')

  for (const notice of await page.getByTestId('notification-viewport').getByRole('button', { name: 'Dismiss notification', exact: true }).all()) await notice.click().catch(() => {})
  for (const operation of ['health', 'update']) {
    heldOperation = operation
    const before = operations.length
    await subscription.getByTestId(operation === 'health' ? 'provider-healthcheck' : 'provider-update').click()
    await poll(() => operations.length === before + 1, `held ${operation} starts`)
    const url = operations.at(-1).url
    const beforeLeave = reads
    await groupsTab.click()
    await poll(() => failedRequests.includes(url), `${operation} request is aborted when Providers unmounts`)
    releaseHeld()
    await delay(60)
    assert.equal(reads, beforeLeave, 'A cancelled operation cannot refresh Groups metadata')
    assert.equal(await page.getByTestId('proxy-provider-notice').count(), 0, 'Cancelled operations post no late provider toast')
    heldOperation = null
    await providersTab.click()
    await subscription.getByTestId('provider-update').waitFor()
  }
  console.log('PASS: group state survives subtabs; encoded healthcheck/update reload metadata and abort cleanly on leaving Providers')

  for (const notice of await page.getByTestId('notification-viewport').getByRole('button', { name: 'Dismiss notification', exact: true }).all()) await notice.click().catch(() => {})
  operations.length = 0; maximumOperations = 0; failBatch = true
  const beforeBatch = reads
  await panel.getByTestId('providers-update-all').click()
  const batchToast = page.getByTestId('proxy-provider-batch-notice')
  await batchToast.waitFor()
  assert.equal(await batchToast.getAttribute('data-tone'), 'warning')
  assert.match(await batchToast.innerText(), /File source|failed|Failed/)
  assert.equal(await batchToast.count(), 1)
  assert.equal(operations.filter(call => call.operation === 'update').length, 5, 'Update all covers all external providers, excluding hidden defaults')
  assert.equal(new Set(operations.map(call => call.name)).size, 5)
  assert.equal(maximumOperations, 2, 'Batch updates use the shared two-request limit')
  assert.equal(reads, beforeBatch + 1, 'The batch reloads metadata once after all outcomes')
  assert.equal(await page.getByTestId('proxy-provider-notice').count(), 0, 'Batch members do not produce individual toasts')
  console.log('PASS: partial batch failure completes other providers, reloads once and produces one aggregate toast')

  const otherPort = await freePort()
  const otherOrigin = `http://127.0.0.1:${otherPort}`
  otherMock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(otherPort), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  otherMock.stdout.on('data', () => {})
  otherMock.stderr.on('data', () => {})
  await poll(async () => { try { return (await fetch(`${otherOrigin}/version`, { headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 'second isolated mock starts')
  for (const notice of await page.getByTestId('notification-viewport').getByRole('button', { name: 'Dismiss notification', exact: true }).all()) await notice.click().catch(() => {})
  heldOperation = 'health'
  const beforeSwitch = operations.length
  await subscription.getByTestId('provider-healthcheck').click()
  await poll(() => operations.length > beforeSwitch, 'pending provider check before switching backend')
  const readsBeforeSwitch = reads
  const connectBackend = async address => {
    await page.evaluate(() => { location.hash = '#/setup' })
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.locator('#backend-url').fill(address)
    await page.locator('#backend-secret').fill('test')
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
    await page.evaluate(() => { location.hash = '#/proxies?tab=providers' })
  }
  await connectBackend(otherOrigin)
  await provider('mock-nodes').waitFor()
  releaseHeld()
  heldOperation = null
  await delay(80)
  assert.equal(reads, readsBeforeSwitch, 'The departed backend check cannot reload old provider metadata')
  assert.equal(await subscription.count(), 0, 'Old provider cards cannot replace the new backend')
  assert.equal(await page.getByTestId('proxy-provider-notice').count(), 0, 'The old backend posts no completion toast')
  await connectBackend(origin)
  await subscription.waitFor()
  console.log('PASS: a pending check cannot update metadata or post a toast after changing to another isolated backend')

  for (const locale of ['en', 'ru']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ locale, theme }) => { localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme) }, { locale, theme })
    await page.reload()
    await page.getByRole('tab', { name: locale === 'ru' ? 'Провайдеры' : 'Providers', exact: true }).waitFor()
    await subscription.getByTestId('provider-nodes').locator('summary').click()
    await nodes.getByTestId('provider-nodes-search').getByRole('searchbox').fill(sharedName)
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.evaluate(() => { window.scrollTo(0, 0) })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}/${theme} Providers fit ${width}px`)
      await page.screenshot({ path: path.join(screenshots, `providers-${locale}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.getByRole('tab', { name: 'Провайдеры', exact: true }).focus()
    await page.evaluate(() => { window.scrollTo(0, 0) })
    await page.screenshot({ path: path.join(screenshots, `providers-ru-dark-viewport-${width}.png`), animations: 'disabled' })
  }
  await panel.getByTestId('providers-search').getByRole('searchbox').fill('No quota')
  assert.equal(await panel.locator('[data-provider]').count(), 1, 'Russian provider search filters the entire list')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`PASS: RU/EN, 320/390/1440px, light/dark layouts\nScreenshots: ${screenshots}`)
  await context.close()
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error('PAGE:', (await page.locator('body').textContent()).slice(0, 2800))
    await page.screenshot({ path: path.join(screenshots, 'providers-failure.png'), fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  for (const child of [mock, otherMock]) if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
}
