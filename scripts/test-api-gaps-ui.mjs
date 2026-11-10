// Read-only fixtures on an ephemeral controller; never connects to a saved user backend.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { stubAppUpdates, APP_UPDATE_URL } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-api-gaps-'))
const profile = gzipSync(Buffer.from('isolated pprof download fixture'))
const fallbackName = 'Reserve-' + 'long-name-'.repeat(22)
let browser, mock, origin, output = ''
const errors = []
async function poll(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(35) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No browser available')
}
async function session(locale, width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: locale === 'ru' ? 'dark' : 'light', reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true })
  await stubAppUpdates(context)
  await context.addInitScript(({ origin, locale }) => {
    localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' }))
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', locale === 'ru' ? 'dark' : 'light')
    localStorage.setItem('miboard.groups', JSON.stringify({ Reserve: true, Legacy: true, Empty: true, Invalid: true }))
    const baseFetch = window.fetch
    window.profileAborts = 0
    window.fetch = (input, init) => {
      if (String(input).includes('/debug/pprof/')) init?.signal?.addEventListener('abort', () => window.profileAborts++, { once: true })
      return baseFetch(input, init)
    }
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL
    window.profileObjectUrls = new Set()
    URL.createObjectURL = blob => { const url = create.call(URL, blob); window.profileObjectUrls.add(url); return url }
    URL.revokeObjectURL = url => { window.profileObjectUrls.delete(url); return revoke.call(URL, url) }
  }, { origin, locale })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('pageerror', error => errors.push(error.message))
  const state = { response: 'success', requests: [], writes: [], downloads: [], held: null }
  page.on('download', download => state.downloads.push(download))
  const node = name => ({ name, type: 'Direct', history: [] })
  const group = (name, all, extra = {}) => ({ name, type: 'Selector', all, now: all[0], history: [], ...extra })
  const proxies = {
    GLOBAL: group('GLOBAL', ['Reserve', 'Legacy', 'Empty', 'Invalid']),
    Reserve: group('Reserve', [fallbackName], { emptyFallback: fallbackName }),
    Legacy: group('Legacy', ['DIRECT']),
    Empty: group('Empty', ['DIRECT'], { emptyFallback: '   ' }),
    Invalid: group('Invalid', ['DIRECT'], { emptyFallback: { name: 'not-a-string' } }),
    [fallbackName]: node(fallbackName), DIRECT: node('DIRECT'),
  }
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.href === APP_UPDATE_URL) return route.fallback()
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort()
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) state.writes.push(request.url())
    if (url.pathname === '/proxies') return route.fulfill({ json: { proxies } })
    if (url.pathname === '/providers/proxies') return route.fulfill({ json: { providers: {} } })
    if (url.pathname.startsWith('/debug/pprof/')) {
      state.requests.push({ url: request.url(), method: request.method(), authorization: request.headers().authorization })
      if (state.response === 'held') await new Promise(resolve => { state.held = resolve })
      try {
        if (state.response === 'network') return await route.abort('failed')
        if (state.response === 'unsupported') return await route.fulfill({ status: 404, body: 'PRIVATE-ERROR-BODY' })
        if (state.response === 'unauthorized') return await route.fulfill({ status: 401, body: 'PRIVATE-ERROR-BODY' })
        if (state.response === 'invalid') return await route.fulfill({ contentType: 'text/html', body: '<html>PRIVATE-ERROR-BODY</html>' })
        return await route.fulfill({ contentType: 'application/octet-stream', body: profile })
      } catch { return }
    }
    return route.continue()
  })
  await page.goto(`${origin}/ui/#/proxies`)
  await page.getByTestId('proxy-group-fallback').waitFor()
  return { page, context, state }
}
async function openProfiles(page) {
  await page.evaluate(() => { location.hash = '/settings' })
  await chooseSettingsCategory(page, 'core')
  const panel = page.getByTestId('core-profiles')
  await panel.locator('summary').press('Enter')
  assert.equal(await panel.evaluate(element => element.open), true)
  return panel
}

try {
  origin = `http://127.0.0.1:${await freePort()}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: new URL(origin).port, SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await poll(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  browser = await launch()
  for (const [locale, width] of [['en', 1440], ['ru', 320]]) {
    const { page, context, state } = await session(locale, width)
    const fallback = page.getByTestId('proxy-group-fallback')
    assert.equal(await fallback.count(), 1, 'Absent, blank and invalid fallback fields stay hidden')
    assert.equal(await fallback.getByTestId('proxy-group-fallback-name').innerText(), fallbackName)
    await fallback.locator('summary').press('Enter')
    assert.equal(await fallback.evaluate(element => element.open), true, 'Native disclosure works with the keyboard')
    assert.match(await fallback.innerText(), locale === 'ru' ? /отдельно не сообщает/ : /does not report whether/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Long fallback names wrap at mobile width')
    await fallback.screenshot({ path: path.join(screenshots, `fallback-${locale}-${width}.png`) })

    let panel = await openProfiles(page)
    assert.equal(state.requests.length, 0, 'Opening the profile tools performs no request')
    for (const kind of ['heap', 'allocs']) {
      const downloaded = page.waitForEvent('download')
      await panel.getByTestId(`core-profile-${kind}`).click()
      const download = await downloaded
      assert.match(download.suggestedFilename(), new RegExp(`^mihomo-${kind}-[\\dTZ-]+\\.pprof$`))
      assert.deepEqual(await readFile(await download.path()), profile, 'Downloaded binary bytes are preserved')
      await panel.getByRole('status').waitFor()
      assert.equal(await panel.getByTestId('core-profile-heap').isDisabled(), false)
    }
    const messages = locale === 'ru'
      ? { unsupported: /Профили недоступны/, unauthorized: /запретило доступ/, invalid: /неподдерживаемый формат/, network: /Не удалось скачать/ }
      : { unsupported: /Profiles are unavailable/, unauthorized: /denied access/, invalid: /unsupported profile format/, network: /Could not download/ }
    for (const [response, message] of Object.entries(messages)) {
      state.response = response
      await panel.getByTestId('core-profile-heap').click()
      await panel.getByRole('alert').filter({ hasText: message }).waitFor()
      assert.doesNotMatch(await panel.innerText(), /PRIVATE-ERROR-BODY/)
      assert.equal(await panel.getByRole('status').count(), 0, 'Failure clears the previous success')
      assert.equal(await panel.getByTestId('core-profile-heap').isDisabled(), false)
    }
    assert.equal(state.downloads.length, 2, 'Failures never trigger a download')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await panel.screenshot({ path: path.join(screenshots, `profiles-${locale}-${width}.png`) })

    state.response = 'held'
    await panel.getByTestId('core-profile-allocs').click()
    await poll(() => typeof state.held === 'function', 'held profile request')
    assert.equal(await panel.getByTestId('core-profile-heap').isDisabled(), true)
    assert.equal(await panel.getByTestId('core-profile-allocs').isDisabled(), true)
    await page.evaluate(() => { location.hash = '/overview' })
    await page.getByRole('heading', { name: locale === 'ru' ? 'Обзор' : 'Overview', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.profileAborts), 1, 'Leaving Settings aborts the in-flight request')
    state.held(); state.response = 'success'
    panel = await openProfiles(page)
    assert.equal(await panel.getByRole('alert').count(), 0)
    assert.equal(await panel.getByRole('status').count(), 0)
    assert.equal(state.downloads.length, 2, 'Cancelled response cannot create a late download')
    assert.equal(await page.evaluate(() => window.profileObjectUrls.size), 0, 'Object URLs are released when the component leaves')
    assert.deepEqual(state.writes, [], 'All diagnostics are read-only')
    for (const request of state.requests) {
      const url = new URL(request.url)
      assert.equal(url.search, '')
      assert.equal(url.username + url.password, '')
      assert.match(url.pathname, /^\/debug\/pprof\/(heap|allocs)$/)
      assert.equal(request.method, 'GET')
      assert.equal(request.authorization, 'Bearer test')
    }
    await context.close()
    console.log(`PASS: ${locale} ${width}px fallback semantics, keyboard/overflow, heap+allocs downloads, errors, cancellation and no writes`)
  }
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) mock.kill()
}
