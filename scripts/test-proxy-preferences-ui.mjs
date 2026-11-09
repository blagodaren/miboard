import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, '.proxy-preferences-check')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, mock, origin, output = ''
const errors = [], writes = []
async function poll(check, label, timeout = 12000) {
  const until = Date.now() + timeout
  do { if (await check()) return; await pause(30) } while (Date.now() < until)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function launch() {
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...opts }) } catch {}
  }
  throw new Error('No browser')
}
const node = (name, delay = 10) => ({ name, type: 'Vless', history: [{ time: '2026-11-10T00:00:00Z', delay }] })
const group = (name, all, hidden = false) => ({ name, type: 'Selector', all, now: all[0], history: [], hidden })
const section = (page, name) => page.locator('section.proxy-group').filter({ has: page.locator(`span[title="${name}"]`) })
async function preferencePanel(page) {
  const details = page.getByTestId('proxy-test-selection')
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click()
  return details
}
async function session({ independent = false, duplicates = false, width = 1530, size = 'large', height = 'large', locale = 'en' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, independent, size, height, locale }) => {
    if (!localStorage.getItem('miboard.backend')) localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' }))
    if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', locale)
    if (!localStorage.getItem('miboard.theme')) localStorage.setItem('miboard.theme', locale === 'ru' ? 'dark' : 'light')
    if (!localStorage.getItem('miboard.latency.v1')) localStorage.setItem('miboard.latency.v1', JSON.stringify({ mode: 'panel', url: 'https://www.gstatic.com/generate_204', timeout: 5000, yellow: 400, red: 800, ipv6: false, independent }))
    if (!localStorage.getItem('miboard.proxy-card-size')) localStorage.setItem('miboard.proxy-card-size', size)
    if (!localStorage.getItem('miboard.proxy-group-height')) localStorage.setItem('miboard.proxy-group-height', height)
  }, { origin, independent, size, height, locale })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) writes.push(request.url()) })
  const extra = Array.from({ length: 40 }, (_, index) => node(`long-${index}`))
  const proxies = duplicates ? {
    GLOBAL: group('GLOBAL', ['First', 'Second']), First: group('First', ['same']), Second: group('Second', ['same']),
    // A globally merged old-core copy must not override either group's real owner.
    same: { ...node('same', 11), 'provider-name': 'one' },
  } : {
    GLOBAL: group('GLOBAL', ['A', 'B', 'Hidden', 'Long']), A: group('A', ['direct', 'shared']), B: group('B', ['shared', 'other']), Hidden: group('Hidden', ['hidden'], true),
    Long: group('Long', extra.map(node => node.name)), direct: node('direct'),
  }
  const providers = duplicates ? {
    one: { vehicleType: 'HTTP', proxies: [node('same', 11)] }, two: { vehicleType: 'HTTP', proxies: [{ ...node('same', 99), 'dialer-proxy': 'Entry' }] },
  } : { provider: { vehicleType: 'HTTP', proxies: ['shared', 'other', 'hidden', 'unreferenced'].map(name => node(name)).concat(extra) } }
  const requests = []
  await page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies } }))
  await page.route(`${origin}/providers/proxies`, route => route.fulfill({ json: { providers } }))
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    if (/\/delay$|\/healthcheck$/.test(url.pathname)) {
      requests.push(url.pathname)
      if (url.pathname.startsWith('/group/')) {
        const name = decodeURIComponent(url.pathname.split('/')[2]), value = name === 'Second' ? 99 : 11
        return route.fulfill({ json: Object.fromEntries((proxies[name]?.all ?? []).map(member => [member, value])) })
      }
      return route.fulfill({ json: { delay: url.pathname.includes('/two/') ? 99 : 11 } })
    }
    return route.fallback()
  })
  await page.goto(`${origin}/ui/#/proxies`)
  await page.getByTestId('proxy-test-selection').waitFor()
  await poll(async () => !await page.getByRole('button', { name: locale === 'ru' ? 'Замерить все' : 'Test all', exact: true }).isDisabled(), 'metadata loaded')
  return { page, context, requests }
}
async function runAll(page) {
  await page.getByRole('button', { name: 'Test all', exact: true }).click()
  await page.getByTestId('proxy-latency-summary').waitFor()
}
async function selectOnly(page, names) {
  const panel = await preferencePanel(page)
  await panel.getByRole('radio', { name: 'Selected groups', exact: true }).click()
  await panel.getByRole('button', { name: 'Clear selection', exact: true }).click()
  for (const name of names) await panel.locator(`input[data-test-group="${name}"]`).check()
}

try {
  await mkdir(out, { recursive: true })
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()
  for (const independent of [false, true]) {
    const { page, context, requests } = await session({ independent })
    await runAll(page)
    if (independent) assert(requests.some(url => url.includes('/hidden/')), 'Default all includes hidden groups')
    else assert(requests.some(url => url.includes('/unreferenced/')), 'Default shared all includes unreferenced providers')
    requests.length = 0
    await selectOnly(page, ['A'])
    await runAll(page)
    assert.deepEqual(requests.slice().sort(), ['/proxies/direct/delay', '/providers/proxies/provider/shared/healthcheck'].sort(), 'Only selected group members run')
    requests.length = 0
    await section(page, 'B').getByRole('button', { name: 'Test latency for B', exact: true }).click()
    await poll(async () => requests.length === 2, 'Excluded group still tests manually')
    assert(requests.some(url => url.includes('/other/')))
    await page.reload()
    const panel = await preferencePanel(page)
    assert.equal(await panel.getByRole('radio', { name: 'Selected groups', exact: true }).getAttribute('aria-checked'), 'true')
    assert.equal(await panel.locator('input[data-test-group="A"]').isChecked(), true)
    assert.equal(await panel.locator('input[data-test-group="B"]').isChecked(), false)
    await panel.getByRole('button', { name: 'Clear selection', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Test all', exact: true }).isDisabled(), true)
    await context.close()
  }
  console.log('PASS: all/selected groups, hidden and unreferenced defaults, shared dedupe, empty selection, manual excluded groups and reload')

  const { page, context, requests } = await session({ duplicates: true })
  for (const name of ['First', 'Second']) {
    const card = section(page, name)
    assert.equal(await card.getByRole('button', { name: 'Retest latency for same', exact: true }).isDisabled(), true)
    assert.match(await card.innerText(), /Multiple providers/)
  }
  await runAll(page)
  assert.deepEqual(requests.slice().sort(), ['/providers/proxies/one/same/healthcheck', '/providers/proxies/two/same/healthcheck'].sort(), 'Each concrete provider has its own request')
  requests.length = 0
  await selectOnly(page, ['First'])
  await runAll(page)
  assert.deepEqual(requests, ['/group/First/delay'], 'The selected ambiguous group is resolved by the core, never another provider')
  assert.match(await section(page, 'First').innerText(), /11 ms/)
  assert.doesNotMatch(await section(page, 'Second').innerText(), /11 ms|99 ms/)
  await section(page, 'Second').getByRole('button', { name: 'Test latency for Second', exact: true }).click()
  await poll(async () => /99 ms/.test(await section(page, 'Second').innerText()), 'second group result')
  assert.match(await section(page, 'First').innerText(), /11 ms/, 'Second cannot overwrite First')
  const options = await page.locator('select option').allTextContents()
  assert(options.includes('same · one') && options.includes('same · two'), 'Stability selector identifies each provider')
  await page.screenshot({ path: path.join(out, 'duplicates-desktop.png'), fullPage: true })
  await context.close()
  console.log('PASS: provider collisions are detected, provider requests/results isolated, authoritative group fallback and clear provider labels')

  for (const width of [320, 1530]) for (const size of ['large', 'compact']) for (const height of ['compact', 'large', 'full']) {
    const { page, context } = await session({ width, size, height })
    const expansion = section(page, 'Long').locator('button[aria-expanded]')
    if (await expansion.getAttribute('aria-expanded') !== 'true') await expansion.click()
    const grid = section(page, 'Long').locator('.proxy-node-grid')
    assert.equal(await grid.getAttribute('data-group-height'), height)
    assert.equal(await grid.getAttribute('data-card-size'), size)
    const dimensions = await grid.evaluate(element => ({ maxHeight: getComputedStyle(element).maxHeight, scroll: element.scrollHeight, client: element.clientHeight }))
    if (width === 320 || height === 'full') assert.equal(dimensions.maxHeight, 'none')
    else { assert.equal(parseFloat(dimensions.maxHeight), height === 'compact' ? 320 : 560); assert(dimensions.scroll > dimensions.client) }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await page.reload()
    await grid.waitFor()
    assert.equal(await grid.getAttribute('data-group-height'), height)
    if (height === 'compact') await page.screenshot({ path: path.join(out, `${width}-${size}-${height}.png`), fullPage: false })
    await context.close()
  }
  for (const [locale, width] of [['en', 1530], ['ru', 320]]) {
    const { page, context } = await session({ locale, width })
    for (const [height, label] of [['compact', locale === 'ru' ? 'Компактная' : 'Compact'], ['full', locale === 'ru' ? 'Без лимита' : 'Unlimited']]) {
      await page.goto(`${origin}/ui/#/settings`)
      const control = page.getByTestId('proxy-group-height-settings')
      await control.getByRole('radio', { name: label, exact: true }).click()
      assert.equal(await page.evaluate(() => localStorage.getItem('miboard.proxy-group-height')), height)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      if (height === 'compact') await page.screenshot({ path: path.join(out, `settings-${locale}-${width}.png`), fullPage: true })
      await page.goto(`${origin}/ui/#/proxies`)
      const expansion = section(page, 'Long').locator('button[aria-expanded]')
      if (await expansion.getAttribute('aria-expanded') !== 'true') await expansion.click()
      const grid = section(page, 'Long').locator('.proxy-node-grid')
      assert.equal(await grid.getAttribute('data-group-height'), height)
      assert.equal(await grid.evaluate(element => getComputedStyle(element).maxHeight), width === 320 || height === 'full' ? 'none' : '320px')
      await page.reload()
      await grid.waitFor()
      assert.equal(await grid.getAttribute('data-group-height'), height)
    }
    await context.close()
  }
  console.log('PASS: live Settings height controls apply immediately and survive route changes/reload in EN desktop and RU mobile')
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
  console.log('PASS: three group heights × two card sizes × desktop/mobile 320, preference persistence, no overflow, no API writes or browser errors')
} finally {
  await browser?.close()
  mock?.kill()
}
