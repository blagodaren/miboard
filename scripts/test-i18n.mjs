import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const routes = {
  overview: ['Overview', 'Обзор'],
  proxies: ['Proxies', 'Прокси'],
  connections: ['Connections', 'Соединения'],
  devices: ['Devices', 'Устройства'],
  analysis: ['IP & Domain analysis', 'IP и домены'],
  geography: ['Geography', 'География'],
  rules: ['Rules', 'Правила'],
  logs: ['Logs', 'Логи'],
  settings: ['Settings', 'Настройки'],
}
const errors = []
let browser
let mock
let mockOutput = ''
const screenshotDir = await mkdtemp(path.join(os.tmpdir(), 'miboard-i18n-'))

async function poll(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch({ headless: true, ...options })
    } catch {
      // Prefer the bundled browser; installed Chrome/Edge are useful on Windows.
    }
  }
  throw new Error('No browser available. Run: npx playwright install chromium')
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function watch(page) {
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    // The setup scenarios deliberately reject missing/incorrect credentials.
    if (message.location().url.endsWith('/version') && /\b401\b/.test(message.text())) return
    errors.push(message.text())
  })
}

async function language(page, locale) {
  await page.getByRole('combobox', { name: /^(Language|Язык)$/ }).selectOption(locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
}

async function screenshots(page, screen, locale) {
  const original = page.viewportSize()
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme })
    for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${screen}/${locale}/${scheme}/${name} overflows horizontally`)
      await page.screenshot({ path: path.join(screenshotDir, `${screen}-${locale}-${scheme}-${name}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize(original)
}

async function route(page, name, locale) {
  await page.evaluate((value) => { location.hash = `/${value}` }, name)
  const heading = routes[name][locale === 'ru' ? 1 : 0]
  const navigation = name === 'analysis' && locale === 'en' ? 'IP & Domain' : heading
  await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor()
  await poll(async () => (await page.title()) === `${navigation} · MIBoard`, `${locale} document title for ${name}`)
  const nav = page.getByRole('navigation').filter({ visible: true })
  // Check the visible navigation as well as the independently rendered page.
  await nav.getByRole('link', { name: new RegExp(`^${navigation}(?:\\s+\\d+)?$`) }).waitFor()
}

function placeholders(message) {
  const variants = typeof message === 'string' ? [message] : Object.values(message)
  return [...new Set(variants.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1])))].sort()
}

async function dictionaries() {
  const keys = new Set()
  const directory = new URL('../src/lib/locales/', import.meta.url)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.ts') && !['en.ts', 'ru.ts'].includes(name)).sort()
  for (const file of files) {
    const name = file.slice(0, -3)
    const { en, ru } = await import(new URL(file, directory))
    assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort(), `${name}: locale keys differ`)
    for (const [key, source] of Object.entries(en)) {
      assert(!keys.has(key), `Duplicate message key: ${key}`)
      keys.add(key)
      assert.deepEqual(placeholders(ru[key]), placeholders(source), `${key}: interpolation parameters differ`)
      for (const message of [source, ru[key]]) {
        assert(typeof message === 'string' || typeof message.other === 'string', `${key}: missing plural fallback`)
        const variants = typeof message === 'string' ? [message] : Object.values(message)
        assert(variants.every((text) => typeof text === 'string' && text.trim()), `${key}: empty translation`)
      }
    }
  }
  console.log(`PASS: ${keys.size} English/Russian messages, interpolation parameters and plural fallbacks`)
}

try {
  await dictionaries()
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const base = `${origin}/ui/`
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
  }, 'mock server startup')
  browser = await launchBrowser()

  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } })
  await stubAppUpdates(context)
  const page = await context.newPage()
  watch(page)
  await page.goto(base)
  await page.getByRole('heading', { name: 'Connections', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => navigator.language), 'ru-RU')
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  assert.equal(await page.getByRole('combobox', { name: 'Language', exact: true }).inputValue(), 'en')
  await screenshots(page, 'setup', 'en')
  await language(page, 'ru')
  await page.getByRole('heading', { name: 'Подключения', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('miboard.locale')), 'ru')
  await screenshots(page, 'setup', 'ru')
  await page.reload()
  await page.getByRole('heading', { name: 'Подключения', exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Язык', exact: true }).inputValue(), 'ru')

  await page.locator('input[type="password"]').fill('incorrect-secret')
  await page.locator('form button[type="submit"]').click()
  await page.locator('[data-toast-id="backend-connect"]').getByText('Неверный secret', { exact: true }).waitFor()
  const marker = await page.evaluate(() => { window.__i18nTestMarker = crypto.randomUUID(); return window.__i18nTestMarker })
  await language(page, 'en')
  await page.locator('[data-toast-id="backend-connect"]').getByText('Invalid secret', { exact: true }).waitFor()
  assert.equal(await page.locator('input[type="password"]').inputValue(), 'incorrect-secret')
  assert.equal(await page.evaluate(() => window.__i18nTestMarker), marker, 'Language change reloaded the page')
  await page.locator('input[type="password"]').fill('test')
  await page.locator('form button[type="submit"]').click()
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
  console.log('PASS: English default with Russian browser, persisted Russian choice and reactive authentication errors')

  for (const name of Object.keys(routes)) await route(page, name, 'en')
  await screenshots(page, 'settings', 'en')
  await language(page, 'ru')
  await screenshots(page, 'settings', 'ru')
  assert.equal(await page.evaluate(() => window.__i18nTestMarker), marker, 'Settings language change reloaded the page')
  for (const name of Object.keys(routes)) await route(page, name, 'ru')
  await route(page, 'rules', 'ru')
  await page.getByText(/^12 правил ·/).waitFor()
  let ruleCount = 1
  await page.route(`${origin}/rules`, (request) => request.fulfill({
    json: { rules: Array.from({ length: ruleCount }, (_, index) => ({ type: 'DomainSuffix', payload: `example${index}.com`, proxy: 'DIRECT' })) },
  }))
  for (const [count, expected] of [[1, '1 правило'], [2, '2 правила'], [5, '5 правил'], [21, '21 правило']]) {
    ruleCount = count
    await route(page, 'settings', 'ru')
    await route(page, 'rules', 'ru')
    await page.getByText(new RegExp(`^${expected} ·`)).waitFor()
  }
  await page.unroute(`${origin}/rules`)
  await route(page, 'overview', 'ru')
  await poll(async () => /\d,\d\s*ГБ/.test(await page.locator('main').innerText()), 'Russian decimal separator and byte units')
  await route(page, 'settings', 'ru')
  await language(page, 'en')
  await route(page, 'rules', 'en')
  await page.getByText(/^12 rules ·/).waitFor()
  await route(page, 'overview', 'en')
  await poll(async () => /\d\.\d\s*GB/.test(await page.locator('main').innerText()), 'English decimal separator and byte units')
  console.log(`PASS: all ${Object.keys(routes).length} pages, navigation, document titles, plural forms and localized number/byte formatting`)

  await route(page, 'settings', 'en')
  await page.setViewportSize({ width: 390, height: 844 })
  await language(page, 'ru')
  await route(page, 'settings', 'ru')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile Settings overflows horizontally')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.reload()
  await page.getByRole('heading', { name: 'Настройки', exact: true }).waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'Язык', exact: true }).inputValue(), 'ru')
  const mobileNavigation = page.getByRole('navigation').filter({ visible: true })
  await poll(() => mobileNavigation.evaluate((element) => {
    const current = element.querySelector('[aria-current="page"]')?.getBoundingClientRect()
    const strip = element.getBoundingClientRect()
    return current && current.left >= strip.left && current.right <= strip.right
  }), 'selected mobile section remains visible after reload')
  assert.equal(await page.evaluate(() => scrollY), 0, 'Revealing the mobile section must not scroll the page')
  await page.evaluate(() => window.scrollTo(0, 300))
  await mobileNavigation.getByRole('link', { name: 'Прокси', exact: true }).click()
  await page.getByRole('heading', { name: 'Прокси', exact: true }).waitFor()
  await poll(async () => await page.evaluate(() => scrollY === 0), 'a different mobile screen starts at its heading')
  await mobileNavigation.getByRole('link', { name: 'Настройки', exact: true }).click()
  await page.getByRole('heading', { name: 'Настройки', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => scrollY), 0, 'Returning to Settings starts at the heading')
  await context.close()

  for (const blockedStorage of [false, true]) {
    const fallback = await browser.newContext({ locale: 'ru-RU' })
    await stubAppUpdates(fallback)
    await fallback.addInitScript((blocked) => {
      if (blocked) {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
          Object.defineProperty(Storage.prototype, method, { value() { throw new DOMException('Storage blocked', 'SecurityError') } })
        }
      } else localStorage.setItem('miboard.locale', 'unsupported-language')
    }, blockedStorage)
    const fallbackPage = await fallback.newPage()
    watch(fallbackPage)
    await fallbackPage.goto(`${base}#/overview?secret=test`)
    await fallbackPage.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
    assert.equal(await fallbackPage.locator('html').getAttribute('lang'), 'en')
    await route(fallbackPage, 'settings', 'en')
    await language(fallbackPage, 'ru')
    await fallbackPage.getByRole('heading', { name: 'Настройки', exact: true }).waitFor()
    await fallback.close()
  }
  assert.deepEqual(errors, [], 'Unexpected browser errors')
  console.log('PASS: mobile persistence, unsupported locale fallback, blocked storage and no browser errors')
  console.log(`Screenshots: ${screenshotDir}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const stopped = once(mock, 'exit')
    mock.kill()
    await stopped
  }
}
