// Скриншоты всех экранов с мока: node scripts/shots.mjs <outDir> [dark|light] [mobile]
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const out = process.argv[2] ?? 'shots'
const scheme = process.argv[3] ?? 'dark'
const mobile = process.argv[4] === 'mobile'
const base = process.env.MIBOARD_SCREENSHOT_URL ?? 'http://127.0.0.1:9090/ui/'
const routes = [
  ['overview', 'Overview', 'Overview'],
  ['proxies', 'Proxies', 'Proxies'],
  ['devices', 'Devices', 'Devices'],
  ['connections', 'Connections', 'Connections'],
  ['analysis', 'IP & Domain analysis', 'IP & Domain'],
  ['geography', 'Geography', 'Geography'],
  ['rules', 'Rules', 'Rules'],
  ['logs', 'Logs', 'Logs'],
  ['settings', 'Settings', 'Settings'],
]

function safeUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return '(unknown URL)'
  }
}

function safeMessage(value) {
  return String(value)
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, safeUrl)
    .replace(/\b(secret|token|password)(?:=|:\s*)[^\s&,]+/gi, '$1=[redacted]')
}

if (!['dark', 'light'].includes(scheme)) throw new Error('Theme must be dark or light')
await mkdir(out, { recursive: true })
let browser
for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
}
if (!browser) throw new Error('No browser available. Run: npx playwright install chromium')
try {
  const ctx = await browser.newContext({
    colorScheme: scheme,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    reducedMotion: 'reduce',
  })
  await ctx.addInitScript((theme) => {
    localStorage.setItem('miboard.theme', theme)
    localStorage.setItem('miboard.locale', 'en')
  }, scheme)
  const page = await ctx.newPage()
  page.setDefaultTimeout(10_000)
  const errors = new Set()
  let currentRoute = 'boot'
  page.on('pageerror', (error) => errors.add(`[${currentRoute}] ${safeMessage(error.message)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    errors.add(`[${currentRoute}] console: ${safeMessage(message.text())} — ${safeUrl(message.location().url)}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    errors.add(`[${currentRoute}] HTTP ${response.status()} ${safeUrl(response.url())}`)
  })
  page.on('requestfailed', (request) => {
    errors.add(`[${currentRoute}] request failed: ${safeMessage(request.failure()?.errorText)} — ${safeUrl(request.url())}`)
  })

  const entry = new URL(base)
  entry.hash = '/overview?secret=test'
  await page.goto(entry.href)
  const suffix = `${scheme}${mobile ? '-m' : ''}`
  // Boot must finish before removing the connection parameters from the hash.
  await page.getByRole('heading', { level: 1, name: 'Overview', exact: true }).waitFor()
  for (const [route, heading, title] of routes) {
    currentRoute = route
    await page.evaluate((value) => {
      location.hash = `/${value}`
      window.scrollTo(0, 0)
    }, route)
    await page.waitForFunction(({ route, title }) =>
      location.hash === `#/${route}` && document.title === `${title} · MIBoard`, { route, title })
    await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor()
    if (route === 'proxies') await page.getByText('Loading groups', { exact: true }).waitFor({ state: 'hidden' })
    if (route === 'rules') await page.getByText('Loading rules', { exact: true }).waitFor({ state: 'hidden' })
    await page.evaluate(async () => {
      await document.fonts.ready
      // Full-page screenshots must also include images below the fold.
      const images = [...document.images]
      for (const image of images) image.loading = 'eager'
      await Promise.all(images.map(image => image.decode().catch(() => {
        if (image.isConnected) throw new Error('Screenshot image could not be decoded')
      })))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    if (route === 'logs') await page.getByText(/^Waiting for .+ messages and above$/).waitFor({ state: 'hidden' })
    await page.screenshot({ path: path.join(out, `${route}-${suffix}.png`), fullPage: !mobile, animations: 'disabled' })
  }
  console.log(errors.size ? `ERRORS:\n${[...errors].join('\n')}` : `PASS: ${routes.length} screenshots, no browser or HTTP errors`)
  if (errors.size) process.exitCode = 1
} finally {
  await browser.close()
}
