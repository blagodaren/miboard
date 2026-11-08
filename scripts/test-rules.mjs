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
const screenshotDir = await mkdtemp(path.join(os.tmpdir(), 'miboard-rules-'))
const errors = []
let browser
let mock
let mockOutput = ''
let base
let origin

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

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch({ headless: true, ...options })
    } catch {
      // Installed Chrome/Edge provide a fallback on Windows.
    }
  }
  throw new Error('No browser available. Run: npx playwright install chromium')
}

async function openRules(intercept, controlledConnections) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  if (intercept) await page.route(`${origin}/providers/rules`, intercept)
  let connectionsSocket
  const sendConnections = (connections) => connectionsSocket.send(JSON.stringify({
    connections,
    downloadTotal: connections.reduce((sum, connection) => sum + connection.download, 0),
    uploadTotal: connections.reduce((sum, connection) => sum + connection.upload, 0),
  }))
  if (controlledConnections) await page.routeWebSocket((url) => url.pathname === '/connections', (socket) => {
    connectionsSocket = socket
    sendConnections(controlledConnections)
  })
  await page.goto(`${base}#/rules?secret=test`)
  await page.getByRole('heading', { name: 'Rules', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Expand rule set ads', exact: true }).waitFor()
  return { context, page, sendConnections }
}

const expand = (page, name) => page.getByRole('button', { name: `Expand rule set ${name}`, exact: true })
const collapse = (page, name) => page.getByRole('button', { name: `Collapse rule set ${name}`, exact: true })
const region = (page, name) => page.getByRole('region', { name: `Rule set ${name}`, exact: true })

async function openSet(page, name) {
  await expand(page, name).click()
  const details = region(page, name)
  await details.waitFor()
  return details
}

async function setLanguage(page, locale) {
  await page.evaluate(() => { location.hash = '/settings' })
  await page.getByRole('combobox', { name: /^(Language|Язык)$/ }).selectOption(locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
  await page.evaluate(() => { location.hash = '/rules' })
  await page.getByRole('heading', { name: locale === 'ru' ? 'Правила' : 'Rules', exact: true }).waitFor()
}

async function checkColumns(page, width, columns, state) {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
  await page.waitForFunction((expected) => {
    const table = document.querySelector('table')
    const headers = [...table.querySelectorAll('thead th')].filter((cell) => cell.getBoundingClientRect().width > 0)
    return headers.length === expected && table.querySelector('tbody tr:not([hidden]) td[colspan]')?.colSpan === expected
  }, columns)
  const geometry = await page.locator('table').evaluate((table) => {
    const bounds = table.getBoundingClientRect()
    const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.width > 0)
    return {
      tableRight: bounds.right,
      tableWidth: bounds.width,
      destinationRight: headers.at(-1).right,
      conditionWidth: headers.at(-2).width,
    }
  })
  assert(Math.abs(geometry.tableRight - geometry.destinationRight) < 4, `${state}/${width}: ghost columns leave space after Destination`)
  if (width < 768) assert(geometry.conditionWidth / geometry.tableWidth > 0.4, `${state}/${width}: Condition has less than 40% of the table`)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state}/${width}: Rules page overflows the viewport`)
}

async function checkAnalytics() {
  const MB = 1024 ** 2
  const fixtureConnection = (id, host, rulePayload, policy, download, upload = 0) => ({
    id, rule: 'DomainSuffix', rulePayload, chains: policy === 'YouTube' ? ['Exit-A', policy] : ['Exit-B', 'Route-B', policy],
    download, upload, start: '2026-11-08T09:00:00Z',
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP: '1.1.1.1', destinationPort: '443', host,
    },
  })
  const fixture = [
    fixtureConnection('video-1', 'video.googlevideo.com', 'googlevideo.com', 'YouTube', 8 * MB, MB),
    fixtureConnection('video-2', 'static.googlevideo.com', 'googlevideo.com', 'YouTube', 2 * MB),
    fixtureConnection('github-1', 'github.com', 'github.com', 'Прокси', 4 * MB),
  ]
  const test = await openRules(undefined, fixture)
  const page = test.page
  const dashboard = page.locator('.rules-analytics')
  const total = dashboard.locator('.donut-center strong')
  await poll(async () => (await total.innerText()) === '15 MB', 'connection traffic in donut')
  assert.equal(await dashboard.locator('.donut circle[stroke-dasharray]').count(), 2, 'Distribution should include both matched rules')
  assert.equal(await dashboard.locator('.ranked-rule').count(), 2, 'Connections sharing a rule should share its traffic row')
  assert.equal(await dashboard.locator('.domain-row').count(), 2, 'Selected video rule should expose its two domains')
  assert.equal(await dashboard.locator('.chain-row').count(), 1, 'Selected rule should expose its aggregated route')

  await dashboard.locator('.pause-button').click()
  assert.equal(await dashboard.locator('.pause-button').getAttribute('aria-pressed'), 'true')
  const updated = [...fixture.map((connection, index) => index ? connection : { ...connection, download: 18 * MB }),
    fixtureConnection('github-2', 'api.github.com', 'github.com', 'Прокси', 0)]
  test.sendConnections(updated)
  await poll(async () => (await page.locator('.sidebar-link[href="#/connections"] .num').innerText()) === '4', 'new frame received while analytics is paused')
  assert.equal(await total.innerText(), '15 MB', 'Paused traffic must remain frozen while the shared stream updates')
  assert.equal(await dashboard.locator('.scope-count').innerText(), '3', 'Paused connection count must remain frozen')

  const github = dashboard.locator('.ranked-rule').filter({ has: page.locator('.rule-name', { hasText: /^github\.com$/ }) })
  await github.click()
  assert.equal(await github.getAttribute('aria-pressed'), 'true')
  assert.equal((await dashboard.locator('.domain-selection').innerText()).trim(), 'github.com', 'Selecting a rule updates domain chart context')
  assert.equal(await dashboard.locator('.domain-row').count(), 1)
  assert.equal(await dashboard.locator('.domain-name').innerText(), 'github.com')
  assert.equal(await dashboard.locator('.rule-node strong').innerText(), 'github.com', 'Selecting a rule updates the chain graph')
  assert.equal(await dashboard.locator('.policy-node strong').innerText(), 'Прокси')
  assert.equal(await dashboard.locator('.outbound-node strong').innerText(), 'Exit-B')
  assert.equal(await dashboard.locator('.node-via').innerText(), 'Route-B', 'Intermediate policy order must come from the connection route')

  await dashboard.locator('.panorama-button').click()
  assert.equal(await dashboard.locator('.panorama-button').getAttribute('aria-pressed'), 'true')
  assert.equal(await dashboard.locator('.chain-row').count(), 2, 'Panorama shows both rule routes')
  await dashboard.locator('.policy-filter select').selectOption('YouTube')
  assert.equal(await dashboard.locator('.chain-row').count(), 1, 'Policy filter narrows panorama routes')
  assert.equal(await dashboard.locator('.policy-node strong').innerText(), 'YouTube')
  await dashboard.locator('.policy-filter select').selectOption('')
  const initialTransform = await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform)
  await dashboard.getByRole('button', { name: 'Zoom in', exact: true }).click()
  assert.notEqual(await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform), initialTransform, 'Zoom in changes graph scale')
  await dashboard.getByRole('button', { name: 'Zoom out', exact: true }).click()
  assert.equal(await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform), initialTransform, 'Zoom out restores the previous scale')
  await dashboard.getByRole('button', { name: 'Fit to view', exact: true }).click()

  await dashboard.locator('.pause-button').click()
  assert.equal(await dashboard.locator('.pause-button').getAttribute('aria-pressed'), 'false')
  await poll(async () => (await total.innerText()) === '25 MB', 'resume shows latest connection traffic')
  assert.equal(await dashboard.locator('.scope-count').innerText(), '4')
  test.sendConnections([])
  await poll(async () => (await dashboard.locator('.ranked-rule').count()) === 0, 'closed connections leave analytics')
  assert.equal(await total.innerText(), '0 B')
  assert.equal(await dashboard.locator('.chain-row').count(), 0)
  assert(await dashboard.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(), 'Empty graph disables zoom')
  test.sendConnections(fixture)
  await poll(async () => (await dashboard.locator('.ranked-rule').count()) === 2, 'analytics recovers after an empty frame')
  await dashboard.locator('.pause-button').click()
  for (const width of [320, 390, 700, 1400]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `analytics/${width}: viewport overflow`)
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: path.join(screenshotDir, 'rules-analytics-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(screenshotDir, 'rules-analytics-mobile.png'), fullPage: true, animations: 'disabled' })
  await test.context.close()
  console.log('PASS: deterministic rule traffic/domains/routes, pause/resume, panorama, policy filter, zoom, empty/recovery and 320/390/700/1400px overflow')
}

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  base = `${origin}/ui/`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  mock.stdout.on('data', (chunk) => { mockOutput += chunk })
  mock.stderr.on('data', (chunk) => { mockOutput += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(`Mock exited: ${mockOutput}`)
    try {
      return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok
    } catch {
      return false
    }
  }, 'mock startup')
  browser = await launchBrowser()
  await checkAnalytics()

  let providerRequests = 0
  const main = await openRules(async (route) => {
    providerRequests++
    await route.continue()
  })
  const page = main.page
  assert.equal(providerRequests, 0, 'Provider metadata should load only after expanding a rule set')
  const adsButton = expand(page, 'ads')
  assert.equal(await adsButton.getAttribute('aria-expanded'), 'false')
  await adsButton.focus()
  await adsButton.press('Enter')
  const ads = region(page, 'ads')
  await ads.getByText(/^HTTP$/i).waitFor()
  const controls = await collapse(page, 'ads').getAttribute('aria-controls')
  assert(controls, 'Disclosure must expose aria-controls')
  assert.equal(await page.locator(`[id="${controls}"]`).count(), 1, 'Disclosure target must exist')
  assert.equal(await collapse(page, 'ads').getAttribute('aria-expanded'), 'true')
  assert.equal(await ads.getByRole('searchbox').count(), 0, 'Remote provider must not advertise payload search')
  await collapse(page, 'ads').press('Space')
  await ads.waitFor({ state: 'hidden' })
  console.log('PASS: provider metadata loads lazily; disclosure works with Enter/Space and ARIA state')

  const telegram = await openSet(page, 'telegram')
  await telegram.getByRole('listitem').filter({ hasText: 'DOMAIN-SUFFIX,telegram.org' }).waitFor()
  assert.equal(await telegram.getByRole('listitem').count(), 3)
  const search = telegram.getByRole('searchbox', { name: 'Find a rule in this set', exact: true })
  await search.fill('TELEGRAM.ORG')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 1, 'case-insensitive inline search')
  assert.match(await telegram.getByRole('listitem').innerText(), /telegram\.org/)
  await search.fill('no-such-domain.example')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 0, 'empty inline search result')
  await search.fill('149.154')
  await telegram.getByRole('listitem').filter({ hasText: '149.154.160.0/20' }).waitFor()
  await search.fill('')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 3, 'clearing inline search')
  await collapse(page, 'telegram').click()
  await openSet(page, 'telegram')
  await telegram.getByRole('listitem').first().waitFor()
  assert.equal(providerRequests, 1, 'All expanded rows must share the cached provider response')
  const file = await openSet(page, 'ru-domains')
  await file.getByText(/^File$/i).waitFor()
  assert.equal(await file.getByRole('searchbox').count(), 0)
  assert.equal(providerRequests, 1)
  console.log('PASS: inline domain/IP search, empty results, reset, File provider and shared cache')

  await setLanguage(page, 'ru')
  await page.getByRole('button', { name: 'Раскрыть набор telegram', exact: true }).click()
  const russian = page.getByRole('region', { name: 'Набор правил telegram', exact: true })
  await russian.getByRole('searchbox', { name: 'Найти правило в наборе', exact: true }).waitFor()
  await russian.getByRole('listitem').first().waitFor()
  await page.screenshot({ path: path.join(screenshotDir, 'rules-inline-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(screenshotDir, 'rules-inline-dark.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  const rulesSearch = page.getByRole('searchbox', { name: 'Домен, тип, прокси', exact: true })
  for (const [width, columns] of [[390, 2], [700, 3], [1400, 4]]) {
    await checkColumns(page, width, columns, 'expanded set')
    if (width === 390 || width === 700) {
      await page.screenshot({ path: path.join(screenshotDir, `rules-inline-${width === 390 ? 'mobile' : 'tablet'}.png`), fullPage: true, animations: 'disabled' })
    }
    await rulesSearch.fill('no-such-top-level-rule.example')
    await page.getByText('Ничего не найдено', { exact: true }).waitFor()
    await checkColumns(page, width, columns, 'no results')
    await rulesSearch.fill('')
    await russian.getByRole('listitem').first().waitFor()
  }
  await setLanguage(page, 'en')
  await expand(page, 'telegram').click()
  await region(page, 'telegram').getByRole('searchbox', { name: 'Find a rule in this set', exact: true }).waitFor()
  await main.context.close()
  console.log('PASS: Russian/English labels; 390/700/1400px columns fit expanded and no-results rows without ghost columns')

  let attempts = 0
  const failed = await openRules(async (route) => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: 'Provider temporarily unavailable' } })
    else await route.continue()
  })
  const failedDetails = await openSet(failed.page, 'telegram')
  await failedDetails.getByRole('alert').filter({ hasText: 'Provider temporarily unavailable' }).waitFor()
  await failed.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await failedDetails.getByRole('button', { name: 'Retry', exact: true }).click()
  await failedDetails.getByRole('listitem').first().waitFor()
  assert.equal(attempts, 2, 'Retry should refetch providers once')
  await failed.context.close()
  console.log('PASS: failed provider request preserves the rules table; Retry recovers inline details')

  const missing = await openRules((route) => route.fulfill({ json: { providers: {} } }))
  const missingDetails = await openSet(missing.page, 'ads')
  await missingDetails.getByText('The API did not return details for this rule set.', { exact: true }).waitFor()
  assert.equal(await missingDetails.getByRole('searchbox').count(), 0)
  await missing.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await missing.context.close()
  console.log('PASS: missing provider gets a local explanation and keeps ordinary rules visible')

  const unsupported = await openRules((route) => route.fulfill({ status: 404, json: { message: 'Not Found' } }))
  const unsupportedDetails = await openSet(unsupported.page, 'ads')
  await unsupportedDetails.getByRole('alert').filter({ hasText: 'This core does not provide rule set details.' }).waitFor()
  await unsupported.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await unsupported.context.close()

  for (const [ruleCount, expected] of [
    [0, 'This rule set is empty.'],
    [3, 'The API did not return the rules in this inline set.'],
  ]) {
    const inline = await openRules((route) => route.fulfill({ json: { providers: { telegram: {
      name: 'telegram', behavior: 'Classical', vehicleType: 'Inline', type: 'Rule', ruleCount,
    } } } }))
    const details = await openSet(inline.page, 'telegram')
    await details.getByText(expected, { exact: true }).waitFor()
    assert.equal(await details.getByRole('searchbox').count(), 0)
    assert.equal(await details.getByRole('listitem').count(), 0)
    await inline.context.close()
  }
  console.log('PASS: unsupported provider API; empty inline set differs from omitted inline payload')

  const payload = Array.from({ length: 275 }, (_, index) => `DOMAIN-SUFFIX,entry-${index}.example.com`)
  const large = await openRules((route) => route.fulfill({
    json: { providers: { telegram: {
      name: 'telegram', behavior: 'Classical', vehicleType: 'Inline', type: 'Rule',
      ruleCount: payload.length, updatedAt: '2026-11-08T09:00:00Z', payload,
    } } },
  }))
  const largeDetails = await openSet(large.page, 'telegram')
  await poll(async () => (await largeDetails.getByRole('listitem').count()) === 200, 'bounded rendering for large inline payload')
  await largeDetails.getByText(/first 200/i).waitFor()
  await largeDetails.getByRole('searchbox').fill('entry-274.example.com')
  await poll(async () => (await largeDetails.getByRole('listitem').count()) === 1, 'search reaches rules outside the render limit')
  assert.match(await largeDetails.getByRole('listitem').innerText(), /entry-274\.example\.com/)
  await large.context.close()
  console.log('PASS: large inline sets render at most 200 entries while search covers the complete payload')

  assert.deepEqual(errors, [], 'Unexpected browser runtime errors')
  console.log(`Screenshots: ${screenshotDir}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const stopped = once(mock, 'exit')
    mock.kill()
    await stopped
  }
}
