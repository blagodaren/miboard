import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { FONT_SOURCES } from './font-sources.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const servers = []
const fontBytes = new Map(await Promise.all(FONT_SOURCES.map(async ({ local, cdn }) =>
  [cdn, await readFile(path.join(root, 'src', local.replace(/^\.\//, '')))])))
const fontSamples = [
  ['400 16px "Geist"', 'MIBoard'],
  ['400 16px "Geist"', 'Скорость'],
  ['400 16px "Geist Mono"', '123 MIBoard'],
  ['400 16px "Geist Mono"', 'Сеть'],
  ['400 16px "Twemoji Country Flags"', '\u{1F1E9}\u{1F1EA}'],
]
let browser

async function poll(check, label, timeout = 10_000) {
  const end = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function mockFor(directory) {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const state = { output: '', error: null }
  const process = spawn(globalThis.process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root,
    env: { ...globalThis.process.env, PORT: String(port), SECRET: 'test', MIBOARD_UI_DIR: path.join(root, directory) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  servers.push(process)
  process.stdout.on('data', chunk => { state.output += chunk })
  process.stderr.on('data', chunk => { state.output += chunk })
  process.on('error', error => { state.error = error })
  await poll(async () => {
    if (state.error) throw state.error
    if (process.exitCode !== null) throw new Error(`Mock stopped: ${state.output}`)
    try {
      return (await fetch(`${origin}/version`, {
        headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000),
      })).ok
    } catch { return false }
  }, `${directory} mock startup`)
  return { origin, base: `${origin}/ui/` }
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No browser available. Run: npx playwright install chromium')
}

async function navigate(page, route, heading) {
  await page.locator(`nav:visible a[href="#/${route}"]`).click()
  await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor()
}

async function readable(page, label, theme) {
  const state = await page.getByRole('heading', { level: 1 }).evaluate(heading => {
    const bounds = heading.getBoundingClientRect()
    const style = getComputedStyle(heading)
    return {
      width: innerWidth, scroll: document.documentElement.scrollWidth,
      headingWidth: bounds.width, headingHeight: bounds.height,
      text: heading.textContent.trim(), opacity: style.opacity, visibility: style.visibility,
      color: style.color, colorScheme: getComputedStyle(document.documentElement).colorScheme,
    }
  })
  assert.equal(state.width, 390, `${label}: wrong viewport`)
  assert.ok(state.scroll <= state.width, `${label}: horizontal overflow`)
  assert.ok(state.headingWidth > 0 && state.headingHeight > 0 && state.text, `${label}: heading missing`)
  assert.notEqual(state.opacity, '0', `${label}: heading invisible`)
  assert.notEqual(state.visibility, 'hidden', `${label}: heading hidden`)
  assert.notEqual(state.color, 'rgba(0, 0, 0, 0)', `${label}: heading transparent`)
  assert.ok(state.colorScheme.includes(theme), `${label}: wrong color scheme`)
}

async function scenario(server, mode) {
  const blocked = mode === 'blocked'
  const cdn = mode !== 'local'
  const requests = new Set()
  const localFonts = new Set()
  const unexpected = []
  const errors = []
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', reducedMotion: 'reduce' })
  try {
    await context.addInitScript(() => {
      localStorage.setItem('miboard.locale', 'en')
      localStorage.removeItem('miboard.theme')
    })
    // No external requests leave the browser. CDN bytes are the verified local originals.
    await context.route('**/*', async route => {
      const url = route.request().url()
      if (fontBytes.has(url)) {
        requests.add(url)
        if (blocked) return route.abort('failed')
        return route.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fontBytes.get(url) })
      }
      const parsed = new URL(url)
      if (parsed.origin === server.origin) {
        if (/\.woff2(?:\?|$)/.test(parsed.pathname)) localFonts.add(parsed.pathname)
        return route.continue()
      }
      if (/^https?:$/.test(parsed.protocol)) {
        unexpected.push(url)
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`)
    })
    page.on('requestfailed', request => {
      if (/\.woff2(?:\?|$)/.test(request.url()) && !(blocked && fontBytes.has(request.url()))) {
        errors.push(`Font request failed: ${request.url()}`)
      }
    })
    await page.goto(`${server.base}#/overview?secret=test`)
    await page.getByRole('heading', { level: 1, name: 'Overview', exact: true }).waitFor()
    const loaded = await page.evaluate(async samples => Promise.all(samples.map(async ([font, text]) => {
      try {
        const faces = await document.fonts.load(font, text)
        return { font, text, loaded: faces.length > 0 && faces.every(face => face.status === 'loaded'), checked: document.fonts.check(font, text) }
      } catch {
        return { font, text, loaded: false, checked: document.fonts.check(font, text) }
      }
    })), fontSamples)
    if (blocked) assert.ok(loaded.every(result => !result.loaded && !result.checked), 'Blocked CDN unexpectedly supplied fonts')
    else assert.ok(loaded.every(result => result.loaded && result.checked), `Some fonts did not load: ${JSON.stringify(loaded)}`)

    for (const locale of ['en', 'ru']) {
      const settings = locale === 'ru' ? 'Настройки' : 'Settings'
      const proxies = locale === 'ru' ? 'Прокси' : 'Proxies'
      await page.locator('nav:visible a[href="#/settings"]').click()
      const language = page.getByRole('combobox', { name: /^(Language|Язык)$/ })
      await language.selectOption(locale)
      await page.waitForFunction(value => document.documentElement.lang === value, locale)
      await page.getByRole('heading', { level: 1, name: settings, exact: true }).waitFor()
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await readable(page, `${mode}/${locale}/${theme}/settings`, theme)
        await navigate(page, 'proxies', proxies)
        await readable(page, `${mode}/${locale}/${theme}/proxies`, theme)
        await navigate(page, 'settings', settings)
      }
    }
    assert.deepEqual(unexpected, [], `${mode}: unexpected external requests`)
    assert.deepEqual(errors, [], `${mode}: browser or HTTP errors`)
    assert.deepEqual([...requests].sort(), cdn ? [...fontBytes.keys()].sort() : [], `${mode}: CDN requests differ from pinned sources`)
    assert.equal(localFonts.size, cdn ? 0 : FONT_SOURCES.length, `${mode}: wrong number of local font files`)
    console.log(`PASS: ${mode}; ${requests.size} pinned CDN and ${localFonts.size} local font requests; RU/EN, light/dark, 390px navigation`)
  } finally {
    await context.close()
  }
}

try {
  assert.equal(FONT_SOURCES.length, 5, 'Update the font samples when the font manifest changes')
  const local = await mockFor('dist')
  const cdn = await mockFor('dist-cdn-fonts')
  browser = await launchBrowser()
  await scenario(local, 'local')
  await scenario(cdn, 'cdn')
  await scenario(cdn, 'blocked')
} finally {
  await browser?.close()
  for (const server of servers) if (server.exitCode === null) server.kill()
}
