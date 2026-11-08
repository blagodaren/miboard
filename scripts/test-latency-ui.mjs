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
const screenshotDir = await mkdtemp(path.join(os.tmpdir(), 'miboard-latency-'))
const storageKey = 'miboard.latency.v1'
const errors = []
const expectedFailures = new Set()
let browser
let mock
let mockOutput = ''
let origin
let base

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

async function session({ locale = 'en', settings, unified = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: 'light' })
  await context.addInitScript(({ locale, settings, storageKey }) => {
    if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', locale)
    if (settings && !localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(settings))
  }, { locale, settings, storageKey })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (expectedFailures.has(message.location().url) && /status of 504/.test(message.text())) return
    errors.push(message.text())
  })
  await page.route(`${origin}/configs`, (route) => route.fulfill({ json: {
    mode: 'rule', 'log-level': 'info', 'mixed-port': 7890,
    ...(unified === 'unknown' ? {} : { 'unified-delay': unified }),
  } }))
  return { context, page }
}

const section = (page) => page.locator('section[aria-labelledby="latency-heading"]')
const saved = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey)
const focused = (page) => page.evaluate(() => document.activeElement?.id)

async function openSettings(page, locale = 'en') {
  await page.goto(`${base}#/settings?secret=test`)
  await page.getByRole('heading', { name: locale === 'ru' ? 'Настройки' : 'Settings', exact: true }).waitFor()
  await section(page).getByRole('heading', { name: locale === 'ru' ? 'Задержка' : 'Latency', exact: true }).waitFor()
}

const groupName = 'Latency lab'
const groupUrl = 'https://core.example/group-check'
const ipv6Url = 'https://ipv6.google.com/generate_204'
const names = ['direct-node', 'provider-node', 'slow-node']
const node = (name) => ({ name, type: 'Vless', udp: true, history: [], extra: {} })

async function proxyFixtures(page, historyValues = () => ({}), extraValues = historyValues) {
  const fixtureNode = (name) => {
    const value = historyValues()[name]
    const extra = extraValues()[name]
    return { ...node(name),
      history: value === undefined ? [] : [{ time: '2026-11-08T00:00:00Z', delay: value }],
      extra: extra === undefined ? {} : {
        [groupUrl]: { alive: extra > 0, history: [{ time: '2026-11-08T00:00:00Z', delay: extra }] },
      },
    }
  }
  await page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
    GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [groupName], history: [] },
    [groupName]: { name: groupName, type: 'Selector', all: [names[0], names[2], names[1]], now: names[0], history: [], testUrl: groupUrl },
    [names[0]]: fixtureNode(names[0]),
  } } }))
  await page.route(`${origin}/providers/proxies`, (route) => route.fulfill({ json: { providers: {
    'provider-tests': { proxies: [fixtureNode(names[1]), fixtureNode(names[2])] },
  } } }))
}

async function openProxies(page) {
  await page.goto(`${base}#/proxies?secret=test`)
  await page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true }).waitFor()
  await poll(async () => (await nodeCard(page, names[1]).innerText()).includes('Vless'), 'provider-only node metadata')
}

const groupCard = (page, group = groupName) => page.locator('section').filter({ has: page.getByRole('button', { name: `Test latency for ${group}`, exact: true }) })
const nodeCard = (page, name, group = groupName) => groupCard(page, group).locator('[data-proxy-node]').filter({ has: page.locator(`span[title="${name}"]`) })
const displayedNames = (page) => groupCard(page).locator('[data-proxy-node]').evaluateAll((cards) => cards.map((card) => card.dataset.proxyNode))
const strip = (page, group = groupName) => page.getByTestId('proxy-latency-strip').and(page.locator(`[data-group="${group}"]`))

async function distribution(page, group = groupName) {
  return strip(page, group).getByTestId('latency-distribution').evaluate((element) =>
    Object.fromEntries(['fast', 'ok', 'slow', 'none', 'total'].map((key) => [key, Number(element.getAttribute(`data-${key}`))])),
  )
}

async function expectDistribution(page, expected, group = groupName) {
  await poll(async () => {
    const graphic = strip(page, group).getByTestId('latency-distribution')
    return await graphic.count() > 0 && JSON.stringify(await distribution(page, group)) === JSON.stringify(expected)
  }, `${group}: latency distribution ${JSON.stringify(expected)}`)
}

async function assertLatencyColor(page, name, token) {
  // Wait for the visible color transition instead of depending on a utility name.
  await poll(async () => {
    const colors = await nodeCard(page, name).locator('.num').evaluate((element, token) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${token})`
      element.append(probe)
      const result = { actual: getComputedStyle(element).color, expected: getComputedStyle(probe).color }
      probe.remove()
      return result
    }, token)
    return colors.actual === colors.expected
  }, `${name}: latency uses the ${token} semantic color`)
}

async function assertOrder(page, expected, description, requests) {
  let checks = 0
  try {
    await poll(async () => {
      checks++
      return JSON.stringify(await displayedNames(page)) === JSON.stringify(expected)
    }, description)
  } catch (error) {
    const diagnostic = {
      description,
      selected: await groupCard(page).getByRole('combobox', { name: `Sort nodes in ${groupName}`, exact: true }).inputValue(),
      stored: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('miboard.proxy-sort')))),
      order: await displayedNames(page),
      cards: await groupCard(page).locator('[data-proxy-node]').allInnerTexts(),
      requests,
    }
    console.error('Latency sort diagnostic:', JSON.stringify(diagnostic, null, 2))
    throw error
  }
  assert.deepEqual(await displayedNames(page), expected, description)
  if (checks > 1) console.log(`Sort settled after ${checks} checks: ${description}`)
}

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  base = `${origin}/ui/`
  if (process.env.MIBOARD_LATENCY_UI_URL) {
    const entry = new URL(process.env.MIBOARD_LATENCY_UI_URL)
    entry.hash = ''
    for (const [key, value] of Object.entries({ hostname: '127.0.0.1', port, protocol: 'http', secret: 'test' })) entry.searchParams.set(key, String(value))
    base = entry.href
  }
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mock.stdout.on('data', (chunk) => { mockOutput += chunk })
  mock.stderr.on('data', (chunk) => { mockOutput += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(`Mock exited: ${mockOutput}`)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'mock startup')
  browser = await launchBrowser()

  const main = await session()
  const page = main.page
  await openSettings(page)
  const delay = section(page)
  await delay.getByText('Enabled', { exact: true }).waitFor()
  for (const label of ['Test URL', 'Test timeout', 'Yellow threshold', 'Red threshold']) await delay.getByLabel(label, { exact: true }).waitFor()
  const ipv6Switch = delay.getByRole('switch', { name: 'IPv6 test', exact: true })
  const independentSwitch = delay.getByRole('switch', { name: 'Independent latency test', exact: true })
  assert.equal(await ipv6Switch.getAttribute('aria-checked'), 'false')
  assert.equal(await independentSwitch.getAttribute('aria-checked'), 'false')
  await ipv6Switch.click()
  assert.equal((await saved(page)).ipv6, true)
  await delay.getByText('IPv6 test setting saved', { exact: true }).waitFor()
  await independentSwitch.click()
  assert.equal((await saved(page)).independent, true)
  await delay.getByText('Independent latency test setting saved', { exact: true }).waitFor()
  await page.reload()
  assert.equal(await ipv6Switch.getAttribute('aria-checked'), 'true')
  assert.equal(await independentSwitch.getAttribute('aria-checked'), 'true')
  await delay.getByRole('radio', { name: 'Panel', exact: true }).click()
  assert.equal((await saved(page)).mode, 'panel')
  await delay.getByRole('radio', { name: 'Core', exact: true }).click()
  assert.equal((await saved(page)).mode, 'core')
  await delay.getByRole('radio', { name: 'Panel', exact: true }).click()
  const before = await saved(page)
  await page.locator('#latency-url').fill('ftp://invalid.example/check')
  await page.locator('#latency-timeout').fill('32768')
  await page.locator('#latency-yellow').fill('500')
  await page.locator('#latency-red').fill('100')
  await delay.getByRole('button', { name: 'Save', exact: true }).click()
  await poll(async () => (await focused(page)) === 'latency-url', 'focus invalid URL')
  assert.deepEqual(await saved(page), before)
  await delay.getByText(/http:\/\/ or https:\/\//).waitFor()
  const customUrl = 'https://latency.example/custom?probe=1'
  await page.locator('#latency-url').fill(customUrl)
  await delay.getByRole('button', { name: 'Save', exact: true }).click()
  await poll(async () => (await focused(page)) === 'latency-timeout', 'focus invalid timeout')
  assert.deepEqual(await saved(page), before)
  await page.locator('#latency-timeout').fill('1234')
  await delay.getByRole('button', { name: 'Save', exact: true }).click()
  await poll(async () => (await focused(page)) === 'latency-red', 'focus invalid threshold order')
  assert.deepEqual(await saved(page), before)
  await page.locator('#latency-red').fill('900')
  await delay.getByRole('button', { name: 'Save', exact: true }).click()
  await delay.getByText('Settings saved in this browser', { exact: true }).waitFor()
  const preferences = { mode: 'panel', url: customUrl, timeout: 1234, yellow: 500, red: 900, ipv6: true, independent: true }
  assert.deepEqual(await saved(page), preferences)
  await page.reload()
  assert.equal(await page.locator('#latency-url').inputValue(), customUrl)
  assert.equal(await page.locator('#latency-timeout').inputValue(), '1234')
  assert.equal(await page.locator('#latency-yellow').inputValue(), '500')
  assert.equal(await page.locator('#latency-red').inputValue(), '900')
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
  for (const label of ['URL проверки', 'Таймаут проверки', 'Жёлтый порог', 'Красный порог']) await delay.getByLabel(label, { exact: true }).waitFor()
  await delay.getByRole('radio', { name: 'Панель', exact: true }).waitFor()
  await delay.getByRole('radio', { name: 'Ядро', exact: true }).waitFor()
  assert.equal(await delay.getByRole('switch', { name: 'IPv6-тест', exact: true }).getAttribute('aria-checked'), 'true')
  assert.equal(await delay.getByRole('switch', { name: 'Независимый тест задержки', exact: true }).getAttribute('aria-checked'), 'true')
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme })
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: 844 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${colorScheme}/${width}px settings overflow`)
      await page.screenshot({ path: path.join(screenshotDir, `settings-ru-${colorScheme}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  await delay.getByRole('button', { name: 'По умолчанию', exact: true }).click()
  assert.deepEqual(await saved(page), { mode: 'core', url: 'https://cp.cloudflare.com/generate_204', timeout: 15000, yellow: 400, red: 800, ipv6: false, independent: false })
  await main.context.close()
  console.log('PASS: RU/EN settings, both modes, switch autosave/reload/save/reset, invalid input focus, 375/390px light/dark layouts')

  for (const [unified, value, hint] of [
    [true, 'Enabled', 'second measurement'],
    [false, 'Disabled', 'includes connection setup'],
    ['unknown', 'Unknown', 'did not report unified-delay'],
  ]) {
    const state = await session({ unified })
    await openSettings(state.page)
    await section(state.page).getByText(value, { exact: true }).waitFor()
    await section(state.page).getByText(new RegExp(hint)).waitFor()
    await state.context.close()
  }
  console.log('PASS: unified-delay enabled, disabled and unavailable states use the current core configuration')

  const testPreferences = { ...preferences, ipv6: false, independent: false }
  const panel = await session({ settings: testPreferences })
  await proxyFixtures(panel.page)
  const requests = []
  let releaseSlow
  const slowGate = new Promise((resolve) => { releaseSlow = resolve })
  await panel.page.route(/\/(delay|healthcheck)\?/, async (route) => {
    const url = new URL(route.request().url())
    const pathname = decodeURIComponent(url.pathname)
    requests.push({ pathname, url: url.searchParams.get('url'), timeout: url.searchParams.get('timeout') })
    if (pathname.startsWith('/group/')) return route.fulfill({ json: {} })
    const name = pathname.split('/').at(-2)
    if (name === names[2]) await slowGate
    await route.fulfill({ json: { delay: name === names[0] ? 420 : name === names[1] ? 110 : 1000 } })
  })
  await openProxies(panel.page)
  await groupCard(panel.page).getByRole('combobox', { name: `Sort nodes in ${groupName}`, exact: true }).selectOption('latency')
  const panelTest = panel.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
  const idleStripHeight = (await strip(panel.page).boundingBox()).height
  await expectDistribution(panel.page, { fast: 0, ok: 0, slow: 0, none: 3, total: 3 })
  await panelTest.click()
  await groupCard(panel.page).getByText('Testing 2/3', { exact: true }).waitFor()
  assert.equal(await strip(panel.page).locator('progress').count(), 1, 'The existing strip shows progress while a measurement is active')
  assert.equal(await strip(panel.page).getByTestId('latency-distribution').count(), 0, 'Progress replaces the idle distribution')
  assert.equal((await strip(panel.page).boundingBox()).height, idleStripHeight, 'Starting a measurement keeps the strip height fixed')
  assert.match(await nodeCard(panel.page, names[0]).innerText(), /420 ms/)
  assert.match(await nodeCard(panel.page, names[1]).innerText(), /110 ms/)
  await assertOrder(panel.page, [names[0], names[1], names[2]], 'Progressive results sort provider nodes after pinned manual entries', requests)
  assert.equal(requests.filter((request) => request.pathname.startsWith('/group/')).length, 0)
  assert.equal(requests.length, 3)
  assert(requests.some((request) => request.pathname === '/providers/proxies/provider-tests/provider-node/healthcheck'), 'Provider-only nodes use the provider healthcheck API')
  assert(requests.every((request) => request.url === testPreferences.url && request.timeout === '1234'), 'Every panel request uses custom URL and timeout; disabled IPv6 sends no extra calls')
  releaseSlow()
  await poll(async () => await panelTest.isEnabled(), 'panel test completion')
  assert.match(await nodeCard(panel.page, names[2]).innerText(), /1,000 ms/)
  await assertLatencyColor(panel.page, names[0], '--good')
  await assertLatencyColor(panel.page, names[2], '--bad')
  await expectDistribution(panel.page, { fast: 2, ok: 0, slow: 1, none: 0, total: 3 })
  assert.equal((await strip(panel.page).boundingBox()).height, idleStripHeight, 'Finishing a measurement keeps the strip height fixed')
  assert.equal(await strip(panel.page).locator('progress').count(), 0, 'Completed measurement returns to the distribution')
  await panel.page.screenshot({ path: path.join(screenshotDir, 'proxies-panel-progress-results.png'), fullPage: true, animations: 'disabled' })
  await panel.context.close()
  console.log('PASS: panel per-node tests, provider-only endpoint, custom URL/timeout, progressive results, sorting and threshold colors')

  {
    const state = await session({ settings: { ...testPreferences, mode: 'core', yellow: 400, red: 800 } })
    const nested = 'distribution-nested'
    const collapsed = 'Distribution closed'
    const values = { 'manual-fast': 40, 'nested-leaf': 200, 'provider-yellow': 500, 'provider-slow': 900, 'provider-dead': 0 }
    const members = ['manual-fast', nested, 'provider-yellow', 'provider-slow', 'provider-dead', 'provider-unknown']
    let revision = 0
    const fixtureNode = (name) => ({ ...node(name), history: values[name] === undefined ? [] : [{ time: `2026-11-09T00:00:0${revision}Z`, delay: values[name] }] })
    const fixtureGroup = (name, all, extra = {}) => ({ name, type: 'Selector', all, now: all[0], history: [], ...extra })
    await state.page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
      GLOBAL: fixtureGroup('GLOBAL', [groupName, 'Distribution other', collapsed]),
      [groupName]: fixtureGroup(groupName, members),
      'Distribution other': fixtureGroup('Distribution other', ['manual-fast']),
      [collapsed]: fixtureGroup(collapsed, members),
      [nested]: fixtureGroup(nested, ['nested-leaf'], { hidden: true }),
      'manual-fast': fixtureNode('manual-fast'),
    } } }))
    await state.page.route(`${origin}/providers/proxies`, (route) => route.fulfill({ json: { providers: {
      'distribution-subscription': { vehicleType: 'HTTP', proxies: ['nested-leaf', 'provider-yellow', 'provider-slow', 'provider-dead', 'provider-unknown'].map(fixtureNode) },
    } } }))
    await state.page.route(/\/(delay|healthcheck)\?/, async (route) => {
      const name = decodeURIComponent(new URL(route.request().url()).pathname).split('/').at(-2)
      assert.equal(name, 'provider-dead', 'The manual retest targets the failed provider node')
      values[name] = 50
      revision++
      await route.fulfill({ json: { delay: 50 } })
    })
    await state.page.goto(`${base}#/proxies?secret=test`)
    await poll(async () => await state.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true }).isEnabled(), 'distribution metadata loaded')
    const initial = { fast: 2, ok: 1, slow: 1, none: 2, total: 6 }
    await expectDistribution(state.page, initial)
    await expectDistribution(state.page, initial, collapsed)
    assert.equal(await state.page.getByRole('button', { name: `Test latency for ${collapsed}`, exact: true }).locator('..').getByRole('button', { expanded: false }).count(), 1, 'The third group starts collapsed')
    assert.equal(await strip(state.page, collapsed).isVisible(), true, 'A collapsed group keeps its distribution visible')
    const graphic = strip(state.page).getByTestId('latency-distribution')
    assert.equal((await graphic.boundingBox()).height, 4, 'The idle distribution is a four-pixel strip')
    assert.match(await graphic.getAttribute('aria-label'), /Low latency: 2.*Medium latency: 1.*High latency: 1.*No response or untested: 2/, 'Accessible summary explains each state without relying on color')
    const geometry = await graphic.evaluate((element) => {
      const width = element.getBoundingClientRect().width
      return [...element.querySelectorAll('[data-band]')].map((segment) => ({ band: segment.getAttribute('data-band'), count: Number(segment.getAttribute('data-count')), ratio: segment.getBoundingClientRect().width / width }))
    })
    for (const segment of geometry) assert.ok(Math.abs(segment.ratio - segment.count / 6) < 0.01, `${segment.band} width represents its share of the group`)
    await assertLatencyColor(state.page, 'provider-dead', '--text-3')
    await assertLatencyColor(state.page, 'provider-unknown', '--text-3')
    await assertLatencyColor(state.page, 'provider-slow', '--bad')
    assert.equal((await nodeCard(state.page, 'provider-dead').locator('.num').innerText()).trim(), '—')
    assert.equal((await nodeCard(state.page, 'provider-unknown').locator('.num').innerText()).trim(), '—')
    const failedExplanation = nodeCard(state.page, 'provider-dead').locator('.num')
    assert.match(`${await failedExplanation.getAttribute('title')} ${await failedExplanation.getAttribute('aria-description')}`, /no response/i, 'The neutral dash retains an explanation for unavailable latency')
    const bulk = groupCard(state.page).getByTestId('proxy-selection-apply')
    const bulkSize = await bulk.evaluate((element) => {
      const text = [...element.querySelectorAll('span')].find((span) => span.textContent.trim()) ?? element
      return parseFloat(getComputedStyle(text).fontSize)
    })
    assert.ok(bulkSize <= 12, `Bulk node action text is compact: ${bulkSize}px`)
    await state.page.getByRole('searchbox').fill('provider-yellow')
    assert.equal(await displayedNames(state.page).then((items) => items.length), 1, 'Search filters the visible cards')
    await expectDistribution(state.page, initial)
    await state.page.getByRole('searchbox').fill('')
    await openSettings(state.page)
    await state.page.locator('#latency-yellow').fill('100')
    await state.page.locator('#latency-red').fill('300')
    await section(state.page).getByRole('button', { name: 'Save', exact: true }).click()
    await section(state.page).getByText('Settings saved in this browser', { exact: true }).waitFor()
    await state.page.goto(`${base}#/proxies?secret=test`)
    await expectDistribution(state.page, { fast: 1, ok: 1, slow: 2, none: 2, total: 6 })
    await nodeCard(state.page, 'provider-dead').locator('.num').click()
    await poll(async () => (await nodeCard(state.page, 'provider-dead').locator('.num').innerText()).trim() === '50 ms', 'a failed node receives its new measurement')
    await expectDistribution(state.page, { fast: 2, ok: 1, slow: 2, none: 1, total: 6 })
    await expectDistribution(state.page, { fast: 2, ok: 1, slow: 2, none: 1, total: 6 }, collapsed)
    await state.page.screenshot({ path: path.join(screenshotDir, 'proxies-static-latency-distribution.png'), fullPage: true, animations: 'disabled' })
    await state.context.close()
    console.log('PASS: permanent distribution covers full and collapsed groups, reflects thresholds/retests, and keeps failed/unknown latency neutral')
  }

  {
    const sharedGroups = [groupName, 'Latency overlap B', 'Latency overlap C']
    const sharedNames = ['shared-direct', 'shared-provider']
    const sharedUrl = 'https://cp.cloudflare.com/generate_204'
    const otherUrl = 'https://other.example/generate_204'
    const state = await session({ settings: {
      ...testPreferences, mode: 'panel', url: sharedUrl, ipv6: false, independent: false,
    } })
    try {
      await state.context.addInitScript((groups) => {
        localStorage.setItem('miboard.groups', JSON.stringify(Object.fromEntries(groups.map((name) => [name, true]))))
      }, sharedGroups)
      let sampleNumber = 0
      let failing = false
      const samples = new Map()
      const calls = []
      const fixtureNode = (name) => {
        const sample = samples.get(name) ?? { time: '2026-11-08T00:00:00Z', delay: 80 }
        // Another background URL owns generic history after a manual refresh.
        const generic = samples.has(name) ? { time: '2026-11-08T01:00:00Z', delay: 900 } : sample
        return { ...node(name), history: [generic], extra: {
          [sharedUrl]: { alive: sample.delay > 0, history: [sample] },
          [otherUrl]: { alive: true, history: [{ time: '2026-11-08T01:00:00Z', delay: 900 }] },
        } }
      }
      await state.page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
        GLOBAL: { name: 'GLOBAL', type: 'Selector', all: sharedGroups, history: [] },
        ...Object.fromEntries(sharedGroups.map((name) => [name, {
          name, type: 'Selector', all: sharedNames, now: sharedNames[0], history: [], testUrl: groupUrl,
        }])),
        [sharedNames[0]]: fixtureNode(sharedNames[0]),
      } } }))
      await state.page.route(`${origin}/providers/proxies`, (route) => route.fulfill({ json: { providers: {
        'shared-subscription': { proxies: [fixtureNode(sharedNames[1])] },
      } } }))
      await state.page.route(/\/(delay|healthcheck)\?/, async (route) => {
        const url = new URL(route.request().url())
        const pathname = decodeURIComponent(url.pathname)
        const name = pathname.split('/').at(-2)
        calls.push({ pathname, name, url: url.searchParams.get('url'), timeout: url.searchParams.get('timeout') })
        const delay = failing && name === sharedNames[1] ? 0 : 40
        samples.set(name, { time: new Date(Date.UTC(2026, 10, 8, 0, 1, ++sampleNumber)).toISOString(), delay })
        await route.fulfill({ json: { delay } })
      })
      await state.page.goto(`${base}#/proxies?secret=test`)
      const trigger = state.page.getByRole('button', { name: 'Test all groups', exact: true })
      const pings = state.page.locator('[data-proxy-node] .num')
      await poll(async () => await trigger.isEnabled(), 'overlapping group metadata loaded')
      assert.equal(await pings.count(), 6, 'All three overlapping groups are open')
      assert.deepEqual(await pings.allTextContents(), Array(6).fill('80 ms'))
      await trigger.click()
      await state.page.getByText('Test completed: 3/3 groups', { exact: true }).waitFor()
      assert.equal(calls.length, 2, 'A campaign measures two distinct nodes once, rather than twice per group')
      assert.deepEqual(calls.map((call) => call.name).sort(), [...sharedNames].sort())
      assert(calls.every((call) => call.url === sharedUrl && call.timeout === String(testPreferences.timeout)), 'Bulk requests keep the shared URL and timeout')
      assert(calls.some((call) => call.pathname === '/providers/proxies/shared-subscription/shared-provider/healthcheck'), 'Provider identity survives overlapping groups')
      assert.deepEqual(await pings.allTextContents(), Array(6).fill('40 ms'), 'Bulk results must use the requested URL history, never the unrelated 900 ms generic history')

      const single = nodeCard(state.page, sharedNames[0]).getByRole('button', { name: `Retest latency for ${sharedNames[0]}`, exact: true })
      await single.click()
      await poll(async () => await single.isEnabled(), 'single retest after overlapping campaign')
      assert.equal(calls.length, 3, 'A later single-node click is a fresh measurement')
      assert.equal(calls.at(-1).url, sharedUrl)
      assert.deepEqual(await pings.allTextContents(), Array(6).fill('40 ms'), 'Bulk and individual results agree for the same URL')

      failing = true
      const failed = nodeCard(state.page, sharedNames[1]).getByRole('button', { name: `Retest latency for ${sharedNames[1]}`, exact: true })
      await failed.click()
      await poll(async () => await failed.isEnabled(), 'failed URL-specific retest refresh')
      assert.equal(calls.length, 4)
      const failedPings = state.page.locator('[data-proxy-node]').filter({ has: state.page.locator(`span[title="${sharedNames[1]}"]`) }).locator('.num')
      assert.deepEqual(await failedPings.allTextContents(), Array(3).fill('—'), 'A failed current-URL sample must not fall back to a successful 900 ms sample from another URL')
      await assertLatencyColor(state.page, sharedNames[1], '--text-3')
      assert.equal(await state.page.getByRole('alert').count(), 0)
    } finally {
      await state.context.close()
    }
  }
  console.log('PASS: Test all deduplicates overlapping groups; bulk, single-node and failed results retain the requested URL history')

  for (const scenario of [
    { name: 'leaf first', aliasesFirst: false, leafMember: true, independent: false },
    { name: 'aliases first', aliasesFirst: true, leafMember: true, independent: false },
    { name: 'alias-only members', aliasesFirst: true, leafMember: false, independent: false },
    { name: 'independent named measurements', aliasesFirst: false, leafMember: true, independent: true },
  ]) {
    const state = await session({ settings: { ...testPreferences, mode: 'core', independent: scenario.independent } })
    const aliases = ['shared-alias-a', 'shared-alias-b']
    const members = !scenario.leafMember ? [...aliases, ...names.slice(1)] : scenario.aliasesFirst ? [...aliases, ...names] : [names[0], ...aliases, ...names.slice(1)]
    let refreshed = false
    const calls = []
    const fixtureLeaf = (name) => ({ ...node(name),
      // A post-test background result differs from the response the user requested.
      history: [{ time: `2026-11-09T00:00:0${refreshed ? 1 : 0}Z`, delay: refreshed ? 999 : 19 }],
      extra: {
        [testPreferences.url]: { alive: true, history: [{ time: `2026-11-09T00:00:0${refreshed ? 1 : 0}Z`, delay: refreshed ? 777 : 19 }] },
        'https://unrelated.test/check': { alive: true, history: [{ time: '2026-11-09T00:00:02Z', delay: 999 }] },
      },
    })
    await state.page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [groupName], history: [] },
      [groupName]: { name: groupName, type: 'Selector', all: members, now: names[0], history: [] },
      ...Object.fromEntries(aliases.map(name => [name, { name, type: 'Selector', all: [names[0]], now: names[0], history: [], hidden: true }])),
      [names[0]]: fixtureLeaf(names[0]),
    } } }))
    await state.page.route(`${origin}/providers/proxies`, (route) => route.fulfill({ json: { providers: {
      'provider-tests': { proxies: names.slice(1).map(fixtureLeaf) },
    } } }))
    await state.page.route(/\/(delay|healthcheck)\?/, async (route) => {
      const url = new URL(route.request().url())
      const pathname = decodeURIComponent(url.pathname)
      calls.push({ pathname, url: url.searchParams.get('url') })
      const values = { [names[0]]: 55, [aliases[0]]: 497, [aliases[1]]: 777, [names[1]]: 60, [names[2]]: 70 }
      if (pathname.startsWith('/group/')) refreshed = true
      return route.fulfill({ json: pathname.startsWith('/group/') ? values : { delay: values[pathname.split('/').at(-2)] } })
    })
    await openProxies(state.page)
    const trigger = state.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
    await trigger.click()
    await poll(async () => await trigger.isEnabled(), 'shared core aliases test completion')
    if (scenario.leafMember) assert.equal(await nodeCard(state.page, names[0]).locator('.num').innerText(), '55 ms', `${scenario.name}: alias/background history must not overwrite the directly measured leaf`)
    for (const [index, alias] of aliases.entries()) {
      const expected = scenario.independent ? `${index ? 777 : 497} ms` : '55 ms'
      assert.equal(await nodeCard(state.page, alias).locator('.num').innerText(), expected, `${scenario.name}: shared aliases agree, while independent named samples remain separate`)
    }
    assert.equal(calls.filter(call => call.pathname.startsWith('/group/')).length, 1, 'Core mode retains one group request')
    if (!scenario.leafMember) assert.deepEqual(calls.filter(call => !call.pathname.startsWith('/group/')).map(call => call.pathname), [`/proxies/${names[0]}/delay`], 'Aliases without a direct leaf member share exactly one real endpoint follow-up')
    else assert.equal(calls.length, 1, 'A directly measured member does not need extra endpoint requests')
    assert(calls.every(call => call.url === testPreferences.url), 'Core and endpoint follow-up requests keep the same URL')
    const retestedName = scenario.leafMember ? names[0] : aliases[0]
    await nodeCard(state.page, retestedName).getByRole('button', { name: `Retest latency for ${retestedName}`, exact: true }).click()
    await poll(async () => await trigger.isEnabled(), 'single leaf retest after aliased core test')
    assert.equal(await nodeCard(state.page, retestedName).locator('.num').innerText(), '55 ms', 'Group and individual endpoint results use the same measured identity')
    await state.context.close()
  }
  console.log('PASS: core aliases preserve exact endpoint values across order/history refreshes, share missing-leaf follow-ups and retain independent samples')

  {
    const state = await session({ settings: { ...testPreferences, mode: 'core', independent: false } })
    const secondGroup = 'Manual retest group'
    const aliases = ['old-alias-a', 'old-alias-b']
    let leafHistory = 19
    let revision = 0
    let releaseGroup
    let oldGroupStarted = false
    const groupGate = new Promise(resolve => { releaseGroup = resolve })
    const fixtureLeaf = (name) => ({ ...node(name),
      history: [{ time: `2026-11-09T01:00:0${revision}Z`, delay: leafHistory }],
      extra: { [testPreferences.url]: { alive: true, history: [{ time: `2026-11-09T01:00:0${revision}Z`, delay: leafHistory }] } },
    })
    await state.page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [groupName, secondGroup], history: [] },
      [groupName]: { name: groupName, type: 'Selector', all: [names[0], ...aliases, ...names.slice(1)], now: names[0], history: [] },
      [secondGroup]: { name: secondGroup, type: 'Selector', all: [names[0]], now: names[0], history: [] },
      ...Object.fromEntries(aliases.map(name => [name, { name, type: 'Selector', all: [names[0]], now: names[0], history: [], hidden: true }])),
      [names[0]]: fixtureLeaf(names[0]),
    } } }))
    await state.page.route(`${origin}/providers/proxies`, route => route.fulfill({ json: { providers: {
      'provider-tests': { proxies: names.slice(1).map(fixtureLeaf) },
    } } }))
    await state.page.route(/\/(delay|healthcheck)\?/, async route => {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname)
      if (pathname.startsWith('/group/')) {
        oldGroupStarted = true
        await groupGate
        leafHistory = 777
        revision++
        return route.fulfill({ json: { [names[0]]: 55, [aliases[0]]: 497, [aliases[1]]: 777, [names[1]]: 60, [names[2]]: 70 } })
      }
      assert.equal(pathname, `/proxies/${names[0]}/delay`, 'The newer manual check targets the same actual leaf')
      leafHistory = 20
      revision++
      return route.fulfill({ json: { delay: 20 } })
    })
    try {
      await openProxies(state.page)
      const trigger = state.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
      await trigger.click()
      await poll(async () => oldGroupStarted, 'older group test is pending')
      const single = nodeCard(state.page, names[0], secondGroup).getByRole('button', { name: `Retest latency for ${names[0]}`, exact: true })
      await single.click()
      await poll(async () => await single.isEnabled(), 'newer manual result and metadata refresh finish')
      assert.equal(await single.innerText(), '20 ms')
      releaseGroup()
      await poll(async () => await trigger.isEnabled(), 'older group response and its late metadata refresh finish')
      for (const name of [names[0], ...aliases]) assert.equal(await nodeCard(state.page, name).locator('.num').innerText(), '20 ms', 'An older group result/history refresh cannot replace the newer manual measurement')
      assert.equal(await single.innerText(), '20 ms', 'The newer result stays shared across groups')
    } finally {
      releaseGroup()
      await state.context.close()
    }
  }
  console.log('PASS: a newer single-node result wins over an older pending group response and its late URL history')

  const core = await session({ settings: { ...testPreferences, mode: 'core', independent: true } })
  let failedRefresh = false
  await proxyFixtures(core.page, () => failedRefresh ? { [names[0]]: 555, [names[1]]: 0, [names[2]]: 777 } : {})
  const coreRequests = []
  await core.page.route(/\/(delay|healthcheck)\?/, async (route) => {
    const url = new URL(route.request().url())
    coreRequests.push(url)
    if (coreRequests.length > 1) {
      failedRefresh = true
      return route.fulfill({ status: 504, json: { message: 'mock timeout' } })
    }
    await route.fulfill({ json: { [names[0]]: 555, [names[1]]: 333, [names[2]]: 777 } })
  })
  await openProxies(core.page)
  await groupCard(core.page).getByRole('combobox', { name: `Sort nodes in ${groupName}`, exact: true }).selectOption('latency')
  const coreTest = core.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
  await coreTest.click()
  await poll(async () => (await nodeCard(core.page, names[0]).innerText()).includes('555 ms'), 'group API result appears immediately')
  await poll(async () => await coreTest.isEnabled(), 'core test completion')
  assert.equal(coreRequests.length, 1, 'Core mode makes one group request')
  assert.equal(decodeURIComponent(coreRequests[0].pathname), `/group/${groupName}/delay`)
  assert.equal(coreRequests[0].searchParams.get('url'), groupUrl, 'The core group test URL takes precedence')
  assert.equal(coreRequests[0].searchParams.get('timeout'), '1234')
  assert.match(await nodeCard(core.page, names[1]).innerText(), /333 ms/)
  assert.match(await nodeCard(core.page, names[2]).innerText(), /777 ms/)
  await assertLatencyColor(core.page, names[0], '--warning')
  console.log('PASS: core mode sends one group request, honors the configured group URL and displays returned values')

  expectedFailures.add(coreRequests[0].href)
  await coreTest.click()
  await core.page.getByRole('alert').filter({ hasText: 'mock timeout' }).waitFor()
  await poll(async () => await coreTest.isEnabled(), 'failed repeat core test refresh')
  assert.equal(coreRequests.length, 2)
  assert.equal((await nodeCard(core.page, names[1]).locator('.num').innerText()).trim(), '—')
  await assertLatencyColor(core.page, names[1], '--text-3')
  assert.doesNotMatch(await nodeCard(core.page, names[1]).innerText(), /333 ms/, 'A failed new test must not retain its previous manual result')
  await assertOrder(core.page, [names[0], names[2], names[1]], 'A provider node whose refreshed history is zero sorts after measured nodes', coreRequests.map(String))
  await core.context.close()
  console.log('PASS: failed repeat test replaces stale manual values with current URL-specific history and re-sorts unreachable nodes')

  for (const [mode, independent] of [['core', false], ['panel', true]]) {
    const state = await session({ settings: { ...testPreferences, mode, independent } })
    await proxyFixtures(state.page,
      () => ({ [names[0]]: 12, [names[1]]: 23, [names[2]]: 34 }),
      () => ({ [names[0]]: 112, [names[1]]: 223, [names[2]]: 334 }),
    )
    const calls = []
    await state.page.route(/\/(delay|healthcheck)\?/, async (route) => {
      const url = new URL(route.request().url())
      calls.push(url)
      const values = { [names[0]]: 451, [names[1]]: 452, [names[2]]: 453 }
      const name = decodeURIComponent(url.pathname).split('/').at(-2)
      await route.fulfill({ json: url.pathname.startsWith('/group/') ? values : { delay: values[name] } })
    })
    await openProxies(state.page)
    assert.equal(await nodeCard(state.page, names[0]).locator('.num').innerText(), `${independent ? 112 : 12} ms`, 'The chosen mode reads the matching history')
    const trigger = state.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
    await trigger.click()
    await poll(async () => calls.length === (mode === 'core' ? 1 : 3), `${mode} request count`)
    await poll(async () => await trigger.isEnabled(), `${mode} independent=${independent} completion`)
    assert(calls.every((url) => url.searchParams.get('url') === (independent ? groupUrl : testPreferences.url)), 'Independent setting controls URL priority in both modes')
    assert(calls.every((url) => url.searchParams.get('url') !== ipv6Url), 'Disabled IPv6 causes no IPv6 requests')
    await state.context.close()
  }
  console.log('PASS: independent testing selects per-URL history and the group URL in both modes; the shared mode uses the global URL')

  for (const mode of ['core', 'panel']) {
    const timeout = mode === 'core' ? 5000 : 1234
    const state = await session({ settings: { ...testPreferences, mode, ipv6: true, timeout } })
    const nestedName = 'nested-selector'
    let general = { [names[0]]: 11, [names[1]]: 22, [names[2]]: 33 }
    const currentNode = (name) => ({ ...node(name), history: [{ time: '2026-11-08T01:00:00Z', delay: general[name] }] })
    await state.page.route(`${origin}/proxies`, (route) => route.fulfill({ json: { proxies: {
      GLOBAL: { name: 'GLOBAL', type: 'Selector', all: [groupName], history: [] },
      [groupName]: { name: groupName, type: 'Selector', all: [nestedName, names[0], names[2]], now: nestedName, history: [], testUrl: groupUrl },
      [nestedName]: { name: nestedName, type: 'Selector', all: [names[1]], now: names[1], history: [{ time: '2026-11-08T00:00:00Z', delay: 915 }], hidden: true },
      [names[0]]: currentNode(names[0]),
    } } }))
    await state.page.route(`${origin}/providers/proxies`, (route) => route.fulfill({ json: { providers: {
      'provider-tests': { proxies: [currentNode(names[1]), currentNode(names[2])] },
    } } }))
    const calls = []
    await state.page.route(/\/(delay|healthcheck)\?/, async (route) => {
      const url = new URL(route.request().url())
      const pathname = decodeURIComponent(url.pathname)
      const name = pathname.split('/').at(-2)
      const ipv6 = url.searchParams.get('url') === ipv6Url
      calls.push({ pathname, name, ipv6, url: url.searchParams.get('url'), timeout: url.searchParams.get('timeout') })
      if (ipv6) {
        general[name] = name === names[1] ? 0 : 99
        if (name === names[1]) {
          expectedFailures.add(url.href)
          return route.fulfill({ status: 504, json: { message: 'IPv6 unavailable in fixture' } })
        }
        return route.fulfill({ json: { delay: 99 } })
      }
      const values = { [nestedName]: 15000, [names[0]]: 410, [names[1]]: 15000, [names[2]]: 430 }
      if (pathname.startsWith('/group/')) {
        general = { [names[0]]: 410, [names[1]]: 15000, [names[2]]: 430 }
        return route.fulfill({ json: values })
      }
      general[name === nestedName ? names[1] : name] = values[name]
      return route.fulfill({ json: { delay: values[name] } })
    })
    await state.page.goto(`${base}#/proxies?secret=test`)
    const trigger = state.page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true })
    await trigger.waitFor()
    await poll(async () => (await nodeCard(state.page, nestedName).innerText()).includes('22 ms'), 'Shared history resolves the selected provider leaf, not a selector history')
    await trigger.click()
    await poll(async () => calls.some((call) => !call.ipv6), `${mode} main test starts after IPv6`)
    await poll(async () => await trigger.isEnabled(), `${mode} IPv6 and main tests complete`)
    const ipv6Calls = calls.filter((call) => call.ipv6)
    assert.equal(ipv6Calls.length, 3, 'IPv6 checks each distinct endpoint once')
    assert(ipv6Calls.every((call) => !call.pathname.startsWith('/group/') && call.name !== nestedName), 'IPv6 checks leaf endpoints, never a strategy group')
    assert(ipv6Calls.some((call) => call.pathname === '/providers/proxies/provider-tests/provider-node/healthcheck'), 'A nested provider leaf uses its provider endpoint')
    assert(ipv6Calls.every((call) => call.timeout === String(Math.min(2000, timeout))), 'IPv6 timeout is bounded by the main timeout and 2000 ms')
    if (mode === 'core') {
      const mainCalls = calls.filter((call) => !call.ipv6)
      assert.equal(mainCalls.length, 2, 'The group request is followed by one canonical leaf check for the nested-only member')
      assert.equal(mainCalls[0].pathname, `/group/${groupName}/delay`)
      assert.equal(mainCalls[1].pathname, '/providers/proxies/provider-tests/provider-node/healthcheck', 'A strategy result is confirmed through its actual provider leaf')
      assert(calls.slice(0, 3).every((call) => call.ipv6), 'The main group test runs after the IPv6 requests to restore main latency history')
      assert(calls[3].pathname.startsWith('/group/'))
    }
    assert(calls.filter((call) => !call.ipv6).every((call) => call.url === testPreferences.url && call.timeout === String(timeout)))
    await nodeCard(state.page, nestedName).locator('[aria-label="IPv6 unavailable"]').waitFor()
    await nodeCard(state.page, names[0]).locator('[aria-label="IPv6 available"]').waitFor()
    assert.match(await nodeCard(state.page, nestedName).innerText(), /15,000 ms/, 'A failed IPv6 check must not replace the main latency')
    assert.match(await nodeCard(state.page, names[0]).innerText(), /410 ms/)
    assert.equal(await state.page.getByRole('alert').count(), 0, 'Partial IPv6 failure is shown in its badge, not as a main-test failure')
    await state.page.screenshot({ path: path.join(screenshotDir, `proxies-ipv6-${mode}.png`), fullPage: true, animations: 'disabled' })
    if (mode === 'core') {
      for (const width of [320, 360, 375, 640]) {
        await state.page.setViewportSize({ width, height: 844 })
        assert(await state.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `IPv6 proxy cards fit the ${width}px viewport`)
        for (const name of [nestedName, names[0]]) {
          const card = nodeCard(state.page, name)
          assert(await card.locator('[data-ipv6-state]').isVisible(), `IPv6 badge is visible for ${name} at ${width}px`)
          const geometry = await card.evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            const badge = element.querySelector('[data-ipv6-state]').getBoundingClientRect()
            const ping = element.querySelector('.num').getBoundingClientRect()
            const title = element.querySelector('button > span').getBoundingClientRect()
            const separate = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
            const contains = rect => rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom
            return { badge: separate(badge, ping), title: separate(title, ping), contained: contains(badge) && contains(ping) }
          })
          assert(geometry.badge, `IPv6 badge and ping button do not overlap for ${name} at ${width}px`)
          assert(geometry.title, `Proxy name and ping button do not overlap for ${name} at ${width}px`)
          assert(geometry.contained, `IPv6 badge and long latency stay inside the card for ${name} at ${width}px`)
        }
        await state.page.screenshot({ path: path.join(screenshotDir, `proxies-ipv6-core-${width}px.png`), fullPage: true, animations: 'disabled' })
      }
    }
    await state.context.close()
  }
  console.log('PASS: IPv6 uses only leaf/provider endpoints with a bounded timeout; failures keep the main latency intact in both modes')
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
