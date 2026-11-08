// Visual and contrast checks against an isolated mock, never the user's controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.theme-check')
const baseline = process.argv.includes('--baseline')
const prefix = `palette-${baseline ? 'before' : 'after'}`
const base = process.env.MIBOARD_THEME_URL ?? 'http://127.0.0.1:5173/'
const port = 19093
const secret = 'theme-check'
const routes = ['overview', 'proxies', 'devices', 'connections', 'analysis', 'geography', 'rules', 'logs', 'settings', 'setup']
const tokens = ['--deep', '--page', '--card', '--raised', '--text', '--text-2', '--text-3', '--line', '--line-strong', '--field', '--field-border', '--selected', '--selected-border', '--selected-text', '--accent', '--accent-ink', '--good', '--bad', '--bad-fill', '--on-bad', '--traffic-down', '--traffic-up']
const report = { baseline, pages: [], tokens: {}, states: [], failures: [], browserErrors: [] }
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
  // Deep-link credentials intentionally connect and redirect setup to overview.
  // Setup must be opened without them, using the mock profile saved by prior routes.
  entry.hash = route === 'setup' ? '/setup' : `/${route}?hostname=127.0.0.1&port=${port}&protocol=http&secret=${secret}`
  await page.goto(entry.href)
  await page.locator('main h1').waitFor()
  if (route === 'proxies') await page.locator('section button[aria-pressed]').first().waitFor()
  if (route === 'connections' || route === 'rules') await page.locator('tbody tr').first().waitFor()
  if (route === 'geography') await page.getByTestId('region-card').first().waitFor()
  if (route === 'setup') await page.locator('#backend-url').waitFor()
  if (route === 'overview') await poll(async () => Number(await page.getByRole('slider').getAttribute('aria-valuemax')) > 0, 'traffic chart samples')
  await page.evaluate(() => document.fonts.ready)
  return page
}

async function contextFor(width, theme, colorScheme = theme ?? 'light') {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1000 }, colorScheme, reducedMotion: 'reduce' })
  await context.addInitScript(({ theme }) => {
    localStorage.setItem('miboard.locale', 'ru')
    if (theme) localStorage.setItem('miboard.theme', theme)
    else localStorage.removeItem('miboard.theme')
  }, { theme })
  return context
}

async function inspect(page, scope = 'body') {
  return page.evaluate(({ tokenNames, scope }) => {
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
    function visible(element) {
      if (!element.getClientRects().length || element.closest('[disabled], [aria-disabled="true"], .sr-only, script, style')) return false
      for (let current = element; current; current = current.parentElement) {
        const css = getComputedStyle(current)
        if (css.visibility !== 'visible' || css.display === 'none' || Number(css.opacity) === 0) return false
        if (css.clip !== 'auto' || css.clipPath !== 'none') return false
      }
      return true
    }
    const samples = []
    const inspected = new Set()
    const container = document.querySelector(scope)
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    function sample(element, text, style = getComputedStyle(element)) {
      if (!text || !visible(element) || /^[\p{Regional_Indicator}\s]+$/u.test(text)) return
      const bg = background(element)
      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 700)
      const key = `${text}|${style.color}|${bg.join(',')}`
      if (inspected.has(key)) return
      inspected.add(key)
      samples.push({ text: text.slice(0, 90), ratio: ratio(over(rgba(style.color), bg), bg), minimum: large ? 3 : 4.5, color: style.color, background: bg.slice(0, 3), element: element.tagName.toLowerCase(), class: typeof element.className === 'string' ? element.className : '' })
    }
    for (let node = walker.nextNode(); node; node = walker.nextNode()) sample(node.parentElement, node.textContent.trim())
    const fields = [...container.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]):not([type="color"]), select, textarea')].filter(visible).map((element) => {
      const style = getComputedStyle(element)
      sample(element, element.value || element.placeholder || element.getAttribute('aria-label') || '', !element.value && element.placeholder ? getComputedStyle(element, '::placeholder') : style)
      const inner = background(element)
      const outside = background(element.parentElement)
      const border = over(rgba(style.borderTopColor), inner)
      return { label: element.getAttribute('aria-label') || element.name || element.id || element.placeholder, ratio: Math.min(ratio(border, inner), ratio(border, outside)), border: style.borderTopColor }
    })
    const css = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    document.body.append(probe)
    const resolved = Object.fromEntries(tokenNames.map((name) => {
      if (!css.getPropertyValue(name).trim()) return [name, null]
      probe.style.color = `var(${name})`
      return [name, getComputedStyle(probe).color]
    }))
    probe.remove()
    return {
      tokens: resolved,
      colorScheme: css.colorScheme,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth,
      text: samples.sort((a, b) => a.ratio - b.ratio), fields,
    }
  }, { tokenNames: tokens, scope })
}

function record(result, label) {
  if (result.overflow > 1) report.failures.push(`${label}: overflow ${result.overflow}px`)
  for (const sample of result.text.filter((item) => item.ratio + 0.01 < item.minimum)) report.failures.push(`${label}: text ${sample.ratio.toFixed(2)}:1 < ${sample.minimum} «${sample.text}» (${sample.class})`)
  for (const field of result.fields.filter((item) => item.ratio + 0.01 < 3)) report.failures.push(`${label}: field border ${field.ratio.toFixed(2)}:1 «${field.label}»`)
}

async function checkInteractions(theme) {
  const context = await contextFor(1440, theme)
  const proxies = await open(context, 'proxies')
  const search = proxies.getByRole('searchbox').first()
  await search.focus()
  const focus = await search.evaluate((element) => { const css = getComputedStyle(element); return { width: css.outlineWidth, style: css.outlineStyle, shadow: css.boxShadow } })
  assert.ok((parseFloat(focus.width) > 0 && focus.style !== 'none') || focus.shadow !== 'none', `${theme}: search focus has no visible outline or ring`)
  const selectedProxy = proxies.locator('section button[aria-pressed="true"]').first()
  const styleOf = (locator) => locator.evaluate((element) => { const css = getComputedStyle(element); return { background: css.backgroundColor, border: css.borderColor, color: css.color } })
  assert.notDeepEqual(await styleOf(selectedProxy), await styleOf(proxies.locator('section button[aria-pressed="false"]').first()), `${theme}: selected and idle proxies are visually identical`)

  const settings = await open(context, 'settings')
  const toggle = settings.getByRole('switch', { name: 'TUN', exact: true })
  const previous = await toggle.getAttribute('aria-checked')
  const oldToggleStyle = await toggle.evaluate((element) => getComputedStyle(element).backgroundColor)
  await toggle.click()
  await poll(async () => await toggle.getAttribute('aria-checked') !== previous, 'toggle state')
  await poll(async () => await toggle.evaluate((element) => getComputedStyle(element).backgroundColor) !== oldToggleStyle, 'toggle visual state')
  await toggle.click()
  const active = settings.getByRole('radio', { name: theme === 'light' ? 'Светлая' : 'Тёмная', exact: true })
  const inactive = settings.getByRole('radio', { name: theme === 'light' ? 'Тёмная' : 'Светлая', exact: true })
  assert.notDeepEqual(await styleOf(active), await styleOf(inactive), `${theme}: active and idle segments are visually identical`)
  await settings.reload()
  assert.equal(await settings.evaluate(() => document.documentElement.dataset.theme), theme, `${theme}: saved explicit theme was not restored`)

  // Open and cancel the destructive confirmation; no delete/restart action is executed.
  const connections = await open(context, 'connections')
  await connections.getByRole('button', { name: 'Закрыть все', exact: true }).click()
  await connections.getByRole('alertdialog').waitFor()
  const dialog = await inspect(connections, '[role="alertdialog"]')
  record(dialog, `${theme} confirmation`)
  report.states.push({ theme, state: 'confirmation', ...dialog })
  await connections.screenshot({ path: path.join(out, `${prefix}-confirmation-${theme}-1440.png`), fullPage: true })
  await connections.getByRole('alertdialog').getByRole('button', { name: 'Отмена', exact: true }).click()
  await connections.getByRole('alertdialog').waitFor({ state: 'hidden' })
  const overview = await open(context, 'overview')
  await overview.getByRole('slider').focus()
  await overview.keyboard.press('End')
  await overview.getByRole('status').waitFor()
  const tooltip = await inspect(overview, '.traffic-tooltip')
  record(tooltip, `${theme} traffic tooltip`)
  report.states.push({ theme, state: 'traffic-tooltip', ...tooltip })
  await overview.screenshot({ path: path.join(out, `${prefix}-tooltip-${theme}-1440.png`), fullPage: true })
  await context.close()
}

try {
  await poll(async () => { try { return (await fetch(`http://127.0.0.1:${port}/version`, { headers: { Authorization: `Bearer ${secret}` } })).ok } catch { return false } }, 'mock startup')
  const executablePath = [process.env.MIBOARD_BROWSER_PATH, chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((candidate) => candidate && existsSync(candidate))
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  await mkdir(out, { recursive: true })
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390, 320]) {
      const context = await contextFor(width, theme)
      for (const route of routes) {
        const page = await open(context, route)
        const result = await inspect(page)
        report.pages.push({ route, width, theme, ...result })
        record(result, `${theme} ${route} ${width}`)
        if (width !== 320) await page.screenshot({ path: path.join(out, `${prefix}-${route}-${theme}-${width}.png`), fullPage: true })
        await page.close()
      }
      await context.close()
    }
    await checkInteractions(theme)
  }
  const explicit = report.pages.find((page) => page.route === 'proxies' && page.width === 1440)
  for (const [name, theme, scheme] of [['systemLight', null, 'light'], ['explicitLightOnDarkSystem', 'light', 'dark'], ['systemDark', null, 'dark'], ['explicitDarkOnLightSystem', 'dark', 'light']]) {
    const context = await contextFor(1440, theme, scheme)
    const page = await open(context, 'proxies')
    const result = await inspect(page)
    report.tokens[name] = result.tokens
    const expectedTheme = theme ?? scheme
    assert.equal(result.colorScheme, expectedTheme, `${name}: incorrect color scheme`)
    const reference = expectedTheme === 'light' ? explicit : report.pages.find((item) => item.route === 'proxies' && item.width === 1440 && item.theme === 'dark')
    assert.deepEqual(result.tokens, reference.tokens, `${name}: explicit/system theme colors disagree`)
    await context.close()
  }
  report.browserErrors = errors
  await writeFile(path.join(out, `${prefix}-report.json`), JSON.stringify(report, null, 2))
  console.log(`${baseline ? 'Исходное состояние' : 'Проверка тем'}: ${report.pages.length} страниц; ошибок браузера ${errors.length}; замечаний ${report.failures.length}`)
  console.log([...new Set(report.failures)].slice(0, 35).join('\n'))
  if (!baseline) {
    assert.deepEqual(errors, [], `Browser errors:\n${errors.join('\n')}`)
    assert.deepEqual(report.failures, [], `Contrast or layout checks failed; see .theme-check/${prefix}-report.json`)
  }
} finally {
  await browser?.close()
  if (mock.exitCode === null) { const exited = once(mock, 'exit'); mock.kill(); await Promise.race([exited, delay(5000, undefined, { ref: false })]) }
}
