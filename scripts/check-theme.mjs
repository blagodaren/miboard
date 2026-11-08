// Visual and contrast checks against an isolated mock, never the user's controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.theme-check')
const baseline = process.argv.includes('--baseline')
const base = process.env.MIBOARD_THEME_URL ?? 'http://127.0.0.1:5173/'
const port = 19093
const secret = 'theme-check'
const routes = ['overview', 'proxies', 'connections', 'analysis', 'geography', 'rules', 'logs', 'settings']
const shots = new Set(['overview', 'proxies', 'connections', 'geography', 'settings'])
const tokens = ['--deep', '--page', '--card', '--raised', '--text', '--text-2', '--text-3', '--line', '--line-strong', '--accent', '--good', '--bad']
const report = { baseline, pages: [], tokens: {}, failures: [] }
const errors = []
let browser
let mockOutput = ''
const mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
  cwd: root, env: { ...process.env, PORT: String(port), SECRET: secret },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
mock.stdout.on('data', (chunk) => (mockOutput += chunk))
mock.stderr.on('data', (chunk) => (mockOutput += chunk))
mock.on('error', (error) => errors.push(error.message))

async function poll(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    if (mock.exitCode !== null) throw new Error(`Mock stopped: ${mockOutput}`)
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

async function open(context, route) {
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  const entry = new URL(base)
  entry.hash = `/${route}?hostname=127.0.0.1&port=${port}&protocol=http&secret=${secret}`
  await page.goto(entry.href)
  await page.locator('main h1').waitFor()
  if (route === 'proxies') await page.locator('section button[aria-pressed]').first().waitFor()
  if (route === 'connections') await page.locator('tbody tr').first().waitFor()
  if (route === 'rules') await page.locator('tbody tr').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function contextFor(width, theme, colorScheme = 'light') {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, colorScheme, reducedMotion: 'reduce' })
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('miboard.locale', 'ru')
    if (theme) localStorage.setItem('miboard.theme', theme)
    else localStorage.removeItem('miboard.theme')
  }, { theme })
  return context
}

async function inspect(page) {
  return page.evaluate((tokenNames) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const painter = canvas.getContext('2d', { willReadFrequently: true })
    function rgba(color) {
      painter.clearRect(0, 0, 1, 1)
      painter.fillStyle = color
      painter.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = painter.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (a, b) => [0, 1, 2].map((index) => a[index] * a[3] + b[index] * (1 - a[3])).concat(1)
    function background(element) {
      const chain = []
      for (let node = element; node; node = node.parentElement) chain.push(rgba(getComputedStyle(node).backgroundColor))
      return chain.reverse().reduce((result, color) => over(color, result), [255, 255, 255, 1])
    }
    function lum(color) {
      const values = color.slice(0, 3).map((channel) => { const v = channel / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
    }
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const samples = []
    for (const el of document.querySelectorAll('.text-fg-3, .text-fg-2, .text-good, .text-bad, .text-accent-ink, [data-state="on"], button[aria-pressed="true"]')) {
      if (!el.textContent.trim() || !el.getClientRects().length || el.closest('[disabled], [aria-disabled="true"]')) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      const bg = background(el)
      samples.push({ text: el.textContent.trim().slice(0, 75), ratio: ratio(over(rgba(getComputedStyle(el).color), bg), bg) })
    }
    const fields = [...document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select')].filter((el) => !el.disabled && el.getClientRects().length).map((el) => {
      const style = getComputedStyle(el)
      return { label: el.getAttribute('aria-label') || el.name || el.id, ratio: ratio(over(rgba(style.borderTopColor), background(el)), background(el)) }
    })
    const css = getComputedStyle(document.documentElement)
    return {
      tokens: Object.fromEntries(tokenNames.map((name) => [name, css.getPropertyValue(name).trim()])),
      colorScheme: css.colorScheme,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
      text: samples.sort((a, b) => a.ratio - b.ratio), fields,
    }
  }, tokens)
}

try {
  await poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/version`, { headers: { Authorization: `Bearer ${secret}` } })).ok } catch { return false } }, 'mock startup')
  const executablePath = [process.env.MIBOARD_BROWSER_PATH, chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((candidate) => candidate && existsSync(candidate))
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  await mkdir(out, { recursive: true })
  for (const width of [1440, 390, 320]) {
    const context = await contextFor(width, 'light')
    for (const route of routes) {
      const page = await open(context, route)
      const result = await inspect(page)
      report.pages.push({ route, width, ...result })
      if (result.overflow > 1) report.failures.push(`${route} ${width}: overflow ${result.overflow}px`)
      for (const sample of result.text.filter((sample) => sample.ratio < 4.5)) report.failures.push(`${route} ${width}: text ${sample.ratio.toFixed(2)}:1 «${sample.text}»`)
      for (const field of result.fields.filter((field) => field.ratio < 3)) report.failures.push(`${route} ${width}: field border ${field.ratio.toFixed(2)}:1 «${field.label}»`)
      if (shots.has(route) && width !== 320) await page.screenshot({ path: path.join(out, `${baseline ? 'before' : 'after'}-${route}-${width}.png`), fullPage: true })
      await page.close()
    }
    await context.close()
  }
  if (!baseline) {
  const interactive = await contextFor(1440, 'light')
  const proxies = await open(interactive, 'proxies')
  const search = proxies.getByRole('searchbox').first()
  await search.focus()
  const focus = await search.evaluate((el) => { const css = getComputedStyle(el); return { width: css.outlineWidth, style: css.outlineStyle, shadow: css.boxShadow, border: css.borderColor } })
  assert.ok((parseFloat(focus.width) > 0 && focus.style !== 'none') || focus.shadow !== 'none', 'Search focus has no visible outline or ring')
  const selectedProxy = proxies.locator('section button[aria-pressed="true"]').first()
  assert.ok(await selectedProxy.count(), 'No selected proxy state')
  const selectedStyle = await selectedProxy.evaluate((el) => { const css = getComputedStyle(el); return { background: css.backgroundColor, border: css.borderColor } })
  const idleStyle = await proxies.locator('section button[aria-pressed="false"]').first().evaluate((el) => { const css = getComputedStyle(el); return { background: css.backgroundColor, border: css.borderColor } })
  assert.notDeepEqual(selectedStyle, idleStyle, 'Selected and idle proxies are visually identical')
  const settings = await open(interactive, 'settings')
  const toggle = settings.getByRole('switch', { name: 'TUN', exact: true })
  const previous = await toggle.getAttribute('aria-checked')
  const oldToggleStyle = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor)
  await toggle.click()
  await poll(async () => await toggle.getAttribute('aria-checked') !== previous, 'toggle state')
  await poll(async () => await toggle.evaluate((el) => getComputedStyle(el).backgroundColor) !== oldToggleStyle, 'toggle visual state')
  await toggle.click()
  const activeSegment = settings.getByRole('radio', { name: 'Светлая', exact: true })
  const offSegment = settings.getByRole('radio', { name: 'Тёмная', exact: true })
  const segmentStyles = await Promise.all([activeSegment, offSegment].map((locator) => locator.evaluate((el) => { const css = getComputedStyle(el); return { background: css.backgroundColor, border: css.borderColor, color: css.color } })))
  assert.notDeepEqual(segmentStyles[0], segmentStyles[1], 'Active and idle segments are visually identical')
  await settings.reload()
  assert.equal(await settings.evaluate(() => document.documentElement.dataset.theme), 'light', 'Saved explicit light theme was not restored')
  await interactive.close()
  }
  for (const [name, theme, scheme] of [['systemLight', null, 'light'], ['explicitLightOnDarkSystem', 'light', 'dark'], ['dark', 'dark', 'light']]) {
    const context = await contextFor(1440, theme, scheme)
    const page = await open(context, 'proxies')
    const result = await inspect(page)
    report.tokens[name] = result.tokens
    assert.equal(result.colorScheme, name === 'dark' ? 'dark' : 'light', `${name}: incorrect color scheme`)
    if (name !== 'dark') assert.equal(result.tokens['--card'], report.pages[0].tokens['--card'], `${name}: explicit/system light themes disagree`)
    if (name === 'dark') await page.screenshot({ path: path.join(out, `${baseline ? 'before' : 'after'}-proxies-dark.png`), fullPage: true })
    await context.close()
  }
  assert.deepEqual(errors, [], `Browser errors:\n${errors.join('\n')}`)
  if (!baseline && existsSync(path.join(out, 'before-report.json'))) {
    const before = JSON.parse(await readFile(path.join(out, 'before-report.json'), 'utf8'))
    assert.deepEqual(report.tokens.dark, before.tokens.dark, 'Existing dark-theme colors changed during the light-theme edit')
  }
  await writeFile(path.join(out, `${baseline ? 'before' : 'after'}-report.json`), JSON.stringify(report, null, 2))
  console.log(`${baseline ? 'Baseline' : 'Theme QA'}: ${report.pages.length} pages; browser errors 0; findings ${report.failures.length}`)
  console.log([...new Set(report.failures)].slice(0, 20).join('\n'))
  if (!baseline) assert.deepEqual(report.failures, [], 'Light-theme contrast or layout checks failed; see .theme-check/after-report.json')
} finally {
  await browser?.close()
  if (mock.exitCode === null) { const exited = once(mock, 'exit'); mock.kill(); await Promise.race([exited, delay(5000, undefined, { ref: false })]) }
}
