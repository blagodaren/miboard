import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-notifications-'))
const errors = []
let browser, mock, output = ''
async function poll(check, name, timeout = 10000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) } while (Date.now() < end)
  throw new Error(`Timed out: ${name}`)
}
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const result = server.address().port
  await new Promise(resolve => server.close(resolve))
  return result
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch { /* Installed browser fallback. */ }
  }
  throw new Error('No browser available')
}
try {
  const mockPort = await port(), origin = `http://127.0.0.1:${mockPort}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(mockPort), SECRET: 'test' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  mock.stdout.on('data', chunk => output += chunk)
  mock.stderr.on('data', chunk => output += chunk)
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(output)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'mock startup')
  browser = await launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' })
  await stubAppUpdates(context)
  await context.addInitScript(() => { if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en') })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  const start = new Date()
  await page.clock.install({ time: start })
  await page.clock.pauseAt(start)
  await page.goto(`${origin}/ui/#/settings?secret=test`)
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor()
  const toasts = page.locator('.notification-toast')
  const toast = id => page.locator(`[data-toast-id="${id}"]`)
  await chooseSettingsCategory(page, 'maintenance')
  await page.getByRole('button', { name: 'Flush', exact: true }).nth(0).click()
  await toast('settings:fakeip').waitFor()
  await page.getByRole('button', { name: 'Flush', exact: true }).nth(1).click()
  await toast('settings:dns').waitFor()
  await chooseSettingsCategory(page, 'core')
  await page.getByRole('switch', { name: 'TUN', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disable TUN', exact: true }).click()
  await toast('settings:tun').waitFor()
  // The clock is paused for toast expiry; let the dialog's closing frames run.
  await page.clock.runFor(32)
  await page.locator('[data-alert-dialog-overlay]').waitFor({ state: 'hidden' })
  await page.getByRole('switch', { name: 'Allow LAN', exact: true }).click()
  await poll(async () => await page.getByRole('switch', { name: 'Allow LAN', exact: true }).isEnabled(), 'fourth operation completes')
  assert.equal(await toasts.count(), 3, 'Three visible messages; the fourth waits in the queue')
  assert.equal(await toast('settings:lan').count(), 0)
  await page.mouse.move(0, 0)
  await page.locator('h1').click()
  await page.clock.fastForward(7900)
  assert.equal(await toasts.count(), 3)
  await page.clock.fastForward(200)
  await toast('settings:lan').waitFor()
  assert.equal(await toasts.count(), 1, 'Queued notice starts only after another expires')
  await page.clock.fastForward(7800)
  assert.equal(await toasts.count(), 1)
  await page.clock.fastForward(200)
  assert.equal(await toasts.count(), 0)
  console.log('PASS: global queue displays three notifications; queued feedback receives eight visible seconds')

  await page.route(`${origin}/configs`, route => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 503, json: { message: 'Controller rejected mode change' } }) : route.continue())
  await page.getByRole('radio', { name: 'Global', exact: true }).first().click()
  await toast('routing-mode').waitFor()
  assert.match(await toast('routing-mode').innerText(), /Could not change routing mode/)
  assert.equal(await page.locator('main [role="alert"]').count(), 0, 'No inline copy of an operation error')
  await chooseSettingsCategory(page, 'appearance')
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
  await toast('routing-mode').getByText(/Не удалось изменить режим/).waitFor()
  await page.getByRole('link', { name: 'Прокси', exact: true }).first().click()
  await toast('routing-mode').waitFor()
  assert.equal(await toasts.count(), 1, 'A route change preserves visible feedback')
  await toast('routing-mode').getByRole('button', { name: 'Закрыть уведомление' }).focus()
  await page.clock.fastForward(15000)
  assert.equal(await toasts.count(), 1, 'Keyboard focus pauses expiry')
  await page.keyboard.press('Escape')
  assert.equal(await toasts.count(), 0)
  console.log('PASS: mode errors use the global surface, translate reactively and survive navigation; Escape dismisses')

  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { localStorage.setItem('miboard.theme', theme); document.documentElement.dataset.theme = theme }, theme)
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 })
      await page.getByRole('radio', { name: 'Глобально', exact: true }).filter({ visible: true }).first().click()
      await toast('routing-mode').waitFor()
      const geometry = await toast('routing-mode').evaluate(element => {
        const rect = element.getBoundingClientRect()
        const navigation = document.querySelector('.mobile-sections')?.getBoundingClientRect()
        return { left: rect.left, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
          navTop: navigation?.height ? navigation.top : innerHeight,
          opacity: getComputedStyle(element).opacity, background: getComputedStyle(element).backgroundColor,
          animation: getComputedStyle(element).animationName }
      })
      assert(geometry.left >= 0 && geometry.right <= geometry.width)
      assert(geometry.bottom <= geometry.navTop - (width < 768 ? 15 : 0), 'Toast clears the mobile navigation')
      assert(geometry.height - geometry.bottom <= (width < 768 ? 74 : 26), 'Toast is at the bottom right')
      assert.equal(geometry.opacity, '1', 'Only the background is translucent')
      assert.equal(geometry.animation, 'none', 'Reduced-motion preference is respected')
      assert.match(geometry.background, /0\.94/)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await page.screenshot({ path: path.join(screenshots, `notification-${theme}-${width}.png`), animations: 'disabled' })
      await toast('routing-mode').getByRole('button', { name: 'Закрыть уведомление' }).click()
    }
  }
  assert.deepEqual(errors, [])
  console.log(`PASS: dark/light, 320/390/1440px, translucent background, mobile safe area, no runtime errors. Screenshots: ${screenshots}`)
  await context.close()
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const ended = once(mock, 'exit'); mock.kill(); await ended }
}
