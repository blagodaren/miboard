import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, '.settings-safety-check')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, mock, origin, output = ''
const errors = []
async function poll(check, label, timeout = 12000) {
  const until = Date.now() + timeout
  do { if (await check()) return; await pause(30) } while (Date.now() < until)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function session({ locale = 'en', width = 1440, groups = '{}' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale, groups }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' }))
    localStorage.setItem('miboard.locale', locale)
    if (!localStorage.getItem('miboard.groups')) localStorage.setItem('miboard.groups', groups)
  }, { origin, locale, groups })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const state = { enabled: false, writes: [], fail: false }
  await page.route(`${origin}/configs`, async route => {
    if (route.request().method() === 'PATCH') {
      state.writes.push(route.request().postDataJSON())
      if (state.fail) return route.fulfill({ status: 500, json: { message: 'TUN update failed' } })
      state.enabled = route.request().postDataJSON().tun.enable
      return route.fulfill({ status: 204 })
    }
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...await response.json(), tun: { enable: state.enabled } } })
  })
  const names = ['Main', 'Second', 'constructor', '__proto__', 'toString']
  await page.route(`${origin}/proxies`, route => route.fulfill({ json: { proxies: {
    ...Object.fromEntries(names.map(name => [name, { name, type: 'Selector', all: ['DIRECT'], now: 'DIRECT', history: [] }])),
    DIRECT: { name: 'DIRECT', type: 'Direct', history: [] },
  } } }))
  await page.route(`${origin}/providers/proxies`, route => route.fulfill({ json: { providers: {} } }))
  return { context, page, state }
}
const groupControl = (page, name) => page.locator('section.proxy-group').filter({ has: page.locator(`span[title="${name}"]`) }).locator('button[aria-expanded]')

try {
  await mkdir(out, { recursive: true })
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'A Chromium browser is available')

  for (const groups of ['null', '[]', 'true', '42', '"wrong"', '{broken', '{"Main":"false","Second":null,"constructor":{},"__proto__":{}}']) {
    const { context, page, state } = await session({ groups })
    await page.goto(`${origin}/ui/#/proxies`)
    await groupControl(page, 'Main').waitFor()
    assert.equal(await page.getByTestId('page-recovery').count(), 0, groups)
    assert.equal(await groupControl(page, 'Main').getAttribute('aria-expanded'), 'true')
    for (const name of ['constructor', '__proto__', 'toString']) assert.equal(await groupControl(page, name).getAttribute('aria-expanded'), 'false', `${groups}: no inherited open state for ${name}`)
    await groupControl(page, '__proto__').click()
    assert.equal(await groupControl(page, '__proto__').getAttribute('aria-expanded'), 'true')
    await page.reload()
    await groupControl(page, '__proto__').waitFor()
    assert.equal(await groupControl(page, '__proto__').getAttribute('aria-expanded'), 'true', 'Special-name group preference survives reload')
    assert.deepEqual(state.writes, [])
    await context.close()
  }
  console.log('PASS: malformed/null/array/primitive preferences recover; boolean filtering and prototype-name groups persist safely')

  for (const [locale, width] of [['en', 1440], ['ru', 320]]) {
    const { context, page, state } = await session({ locale, width })
    const enable = locale === 'ru' ? 'Включить TUN' : 'Enable TUN'
    const disable = locale === 'ru' ? 'Выключить TUN' : 'Disable TUN'
    const cancel = locale === 'ru' ? 'Отмена' : 'Cancel'
    await page.goto(`${origin}/ui/#/settings?category=core`)
    const toggle = page.getByRole('switch', { name: 'TUN', exact: true })
    await toggle.waitFor()
    await toggle.click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('heading', { name: enable, exact: true }).waitFor()
    assert.match(await dialog.textContent(), locale === 'ru' ? /удалённый доступ/ : /remote access/)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'Opening confirmation does not change the switch')
    assert.deepEqual(state.writes, [], 'No PATCH before confirmation')
    await poll(() => dialog.evaluate(element => element.contains(document.activeElement)), 'focus enters the confirmation')
    // bits-ui focuses the dialog so screen readers announce its warning first.
    // The first keyboard action must be Cancel, never the dangerous action.
    if (await dialog.evaluate(element => element === document.activeElement)) await page.keyboard.press('Tab')
    assert.equal(await dialog.getByRole('button', { name: cancel, exact: true }).evaluate(element => element === document.activeElement), true, 'Cancel is the first keyboard action')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Dialog fits viewport')
    await page.screenshot({ path: path.join(out, `tun-${locale}-${width}.png`), fullPage: true })
    await dialog.getByRole('button', { name: cancel, exact: true }).click()
    assert.deepEqual(state.writes, [])
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.focus(); await page.keyboard.press('Space')
    await dialog.waitFor(); await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(state.writes, [], 'Escape does not write')

    for (const [target, label] of [[true, enable], [false, disable]]) {
      const count = state.writes.length
      await toggle.click()
      await dialog.getByRole('heading', { name: label, exact: true }).waitFor()
      assert.equal(state.writes.length, count)
      await dialog.getByRole('button', { name: label, exact: true }).click()
      await poll(async () => await toggle.getAttribute('aria-checked') === String(target) && !await toggle.isDisabled(), `TUN ${target} applied`)
      assert.deepEqual(state.writes[count], { tun: { enable: target } })
      assert.equal(state.writes.length, count + 1)
    }
    state.fail = true
    await toggle.click(); await dialog.getByRole('button', { name: enable, exact: true }).click()
    await page.getByText('TUN update failed', { exact: true }).waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'A failed PATCH preserves the reported state')
    const beforeLeaving = state.writes.length
    await toggle.click(); await dialog.waitFor()
    await page.evaluate(() => { location.hash = '/setup' })
    await page.locator('#backend-url').waitFor()
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'Changing controller discards the pending confirmation')
    assert.equal(state.writes.length, beforeLeaving)
    await context.close()
  }
  assert.deepEqual(errors, [])
  console.log('PASS: EN desktop/RU mobile TUN confirmation for both directions, cancel/Escape, focus, failure and leaving Settings; no browser errors')
  console.log(`Screenshots: ${out}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
