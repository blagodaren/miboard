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

const groupCard = (page) => page.locator('section').filter({ has: page.getByRole('button', { name: `Test latency for ${groupName}`, exact: true }) })
const nodeCard = (page, name) => groupCard(page).locator('[data-proxy-node]').filter({ has: page.locator(`span[title="${name}"]`) })
const displayedNames = (page) => groupCard(page).locator('[data-proxy-node]').evaluateAll((cards) => cards.map((card) => card.dataset.proxyNode))

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
  await panelTest.click()
  await groupCard(panel.page).getByText('Testing 2/3', { exact: true }).waitFor()
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
  assert(await nodeCard(panel.page, names[0]).locator('.num').evaluate((element) => element.classList.contains('text-good')))
  assert(await nodeCard(panel.page, names[2]).locator('.num').evaluate((element) => element.classList.contains('text-bad')))
  await panel.page.screenshot({ path: path.join(screenshotDir, 'proxies-panel-progress-results.png'), fullPage: true, animations: 'disabled' })
  await panel.context.close()
  console.log('PASS: panel per-node tests, provider-only endpoint, custom URL/timeout, progressive results, sorting and threshold colors')

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
  assert(await nodeCard(core.page, names[0]).locator('.num').evaluate((element) => element.classList.contains('text-accent-ink')))
  console.log('PASS: core mode sends one group request, honors the configured group URL and displays returned values')

  expectedFailures.add(coreRequests[0].href)
  await coreTest.click()
  await core.page.getByRole('alert').filter({ hasText: 'mock timeout' }).waitFor()
  await poll(async () => await coreTest.isEnabled(), 'failed repeat core test refresh')
  assert.equal(coreRequests.length, 2)
  assert.match(await nodeCard(core.page, names[1]).innerText(), /no response/)
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
      const values = { [nestedName]: 420, [names[0]]: 410, [names[1]]: 420, [names[2]]: 430 }
      if (pathname.startsWith('/group/')) {
        general = { [names[0]]: 410, [names[1]]: 420, [names[2]]: 430 }
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
      assert.equal(calls.filter((call) => !call.ipv6).length, 1)
      assert(calls.slice(0, 3).every((call) => call.ipv6), 'The main group test runs after the IPv6 requests to restore main latency history')
      assert(calls[3].pathname.startsWith('/group/'))
    }
    assert(calls.filter((call) => !call.ipv6).every((call) => call.url === testPreferences.url && call.timeout === String(timeout)))
    await nodeCard(state.page, nestedName).locator('[aria-label="IPv6 unavailable"]').waitFor()
    await nodeCard(state.page, names[0]).locator('[aria-label="IPv6 available"]').waitFor()
    assert.match(await nodeCard(state.page, nestedName).innerText(), /420 ms/, 'A failed IPv6 check must not replace the main latency')
    assert.match(await nodeCard(state.page, names[0]).innerText(), /410 ms/)
    assert.equal(await state.page.getByRole('alert').count(), 0, 'Partial IPv6 failure is shown in its badge, not as a main-test failure')
    await state.page.screenshot({ path: path.join(screenshotDir, `proxies-ipv6-${mode}.png`), fullPage: true, animations: 'disabled' })
    if (mode === 'core') {
      await state.page.setViewportSize({ width: 375, height: 844 })
      assert(await state.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'IPv6 proxy cards fit the 375px viewport')
      for (const name of [nestedName, names[0]]) {
        const card = nodeCard(state.page, name)
        assert(await card.locator('[data-ipv6-state]').isVisible(), `IPv6 badge is visible for ${name}`)
        const separated = await card.evaluate((element) => {
          const badge = element.querySelector('[data-ipv6-state]').getBoundingClientRect()
          const ping = element.querySelector('.num').getBoundingClientRect()
          return badge.right <= ping.left || ping.right <= badge.left || badge.bottom <= ping.top || ping.bottom <= badge.top
        })
        assert(separated, `IPv6 badge and ping button do not overlap for ${name}`)
      }
      await state.page.screenshot({ path: path.join(screenshotDir, 'proxies-ipv6-core-mobile375.png'), fullPage: true, animations: 'disabled' })
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
