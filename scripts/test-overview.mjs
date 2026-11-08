import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = process.env.MIBOARD_OVERVIEW_URL ?? 'http://127.0.0.1:5173/'
const out = path.join(root, '.overview-check')
const errors = []
const externalRequests = []
let browser
let mock
let mockOutput = ''
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function poll(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  do { if (await check()) return; await delay(50) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No Chrome/Edge available')
}
const fixture = [
  ['big', 'large.example.com', 'US', 'big-proxy', 10_000_000, 1_000_000],
  ['small1', 'common.example.com', 'DE', 'many-proxy', 100_000, 1000],
  ['small2', 'common.example.com', 'DE', 'many-proxy', 100_000, 1000],
  ['small3', 'common.example.com', 'DE', 'many-proxy', 100_000, 1000],
  ['nl', 'netherlands.example.com', 'NL', 'DIRECT', 500_000, 10_000],
  ['jp', 'japan.example.com', 'JP', 'japan-proxy', 400_000, 10_000],
  ['fr', 'france.example.com', 'FR', 'france-proxy', 300_000, 10_000],
  ['unknown', 'unknown.example.com', null, 'unknown-proxy', 100_000, 1000],
].map(([id, host, country, proxy, download, upload], i) => ({
  id, metadata: { network: 'tcp', type: 'Mixed', sourceIP: '192.168.1.5', sourcePort: String(4000+i), destinationIP: country ? `8.8.8.${i+1}` : '', destinationPort: '443', host, ...(country ? { destinationGeoIP: [country] } : {}) },
  download, upload, start: new Date().toISOString(), chains: [proxy], rule: 'MATCH', rulePayload: '',
}))
const snap = connections => JSON.stringify({ downloadTotal: 123456789, uploadTotal: 1234567, connections })
const baseline = fixture.map(c => ({ ...c, download: 0, upload: 0 }))
let origin
let port
async function newPage(locale = 'ru', theme = 'light', width = 1440, initial = baseline) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1040 }, colorScheme: theme, reducedMotion: 'reduce' })
  await context.addInitScript(({ locale, theme }) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', theme)
  }, { locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (/^https?:/.test(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url())
  })
  let socket
  await page.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; ws.send(snap(initial)) })
  let trafficSocket
  await page.routeWebSocket(/\/traffic(?:\?|$)/, ws => {
    trafficSocket = ws
    let tick = 0
    const send = () => { ws.send(JSON.stringify({ down: 2_000_000 + Math.sin(tick++ * 1.2) * 1_500_000, up: 100_000 + tick % 4 * 80_000 })) }
    send()
    const timer = setInterval(send, 1000)
    page.on('close', () => clearInterval(timer))
  })
  const entry = new URL(base)
  entry.hash = `/overview?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
  return { context, page, entry, socket: () => socket, traffic: () => trafficSocket }
}
async function populate(data) {
  await data.page.goto(data.entry.href)
  await data.page.getByRole('heading', { level: 1 }).waitFor()
  await poll(() => Boolean(data.socket()), 'connections stream')
  data.socket().send(snap(fixture))
  await poll(async () => (await data.page.getByTestId('overview-rank-row').count()) >= 12, 'ranked session rows')
  await data.page.evaluate(() => document.fonts.ready)
}
async function noOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  assert.ok(dimensions.scroll <= dimensions.width, `${label}: overflow ${JSON.stringify(dimensions)}`)
}
function ranking(page, index) { return page.getByTestId('overview-ranking').nth(index) }
async function firstName(page, index) { return (await ranking(page, index).locator('.name-text').first().textContent()).trim() }

try {
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  mock.stdout.on('data', data => { mockOutput += data })
  mock.stderr.on('data', data => { mockOutput += data })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(`Mock stopped: ${mockOutput}`)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated mock startup')
  assert.ok((await fetch(base)).ok, `Frontend unavailable: ${base}`)
  browser = await launch()
  await mkdir(out, { recursive: true })

  {
    const data = await newPage()
    const { page, context } = data
    await populate(data)
    assert.equal(await page.getByTestId('overview-stat').count(), 6)
    assert.equal(await page.getByTestId('overview-ranking').count(), 3)
    assert.equal(await firstName(page, 0), 'large.example.com')
    assert.equal(await firstName(page, 1), 'big-proxy')
    assert.equal(await firstName(page, 2), 'Соединенные Штаты')
    for (const index of [0, 1, 2]) await ranking(page, index).getByRole('button', { name: 'По числу соединений', exact: true }).click()
    assert.equal(await firstName(page, 0), 'common.example.com')
    assert.equal(await firstName(page, 1), 'many-proxy')
    assert.equal(await firstName(page, 2), 'Германия')
    for (const index of [0, 1, 2]) await ranking(page, index).getByRole('button', { name: 'По объёму трафика', exact: true }).click()
    for (const label of ['1 час', '24 часа', '30 мин']) {
      const control = page.getByRole('button', { name: label, exact: true })
      await control.click()
      assert.equal(await control.getAttribute('aria-pressed'), 'true')
    }
    await poll(async () => (await page.locator('.traffic-chart').getAttribute('aria-valuemax')) !== '0', 'chart samples')
    await page.locator('.traffic-chart').focus()
    await page.keyboard.press('ArrowLeft')
    await page.locator('.traffic-tooltip').waitFor()
    assert.match(await page.locator('.traffic-tooltip').textContent(), /Загрузка/)
    assert.match(await page.locator('.traffic-tooltip').textContent(), /Отдача/)
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.traffic-tooltip').count(), 0)
    const rowsBefore = await page.getByTestId('overview-rank-row').count()
    data.socket().send(snap([]))
    await delay(150)
    assert.equal(await page.getByTestId('overview-rank-row').count(), rowsBefore, 'Closed connections disappeared from rankings')
    await context.close()
    console.log('PASS: 6 metrics, 3 rankings, ranking sorting, 3 time ranges, keyboard tooltip, closed connections')
  }

  {
    const data = await newPage()
    const { page, context } = data
    let failRules = true
    await page.route(`${origin}/rules`, route => failRules ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue())
    await page.goto(data.entry.href)
    const retry = page.getByRole('button', { name: 'Загрузить правила', exact: true })
    await retry.waitFor()
    assert.equal((await page.locator('[data-stat=rules] dd').textContent()).trim(), '—')
    failRules = false
    await retry.click()
    await poll(async () => (await page.locator('[data-stat=rules] dd').textContent()).trim() !== '—', 'rules retry success')
    await context.close()
    console.log('PASS: unavailable rules shows dash and successful retry restores count')
  }

  {
    const data = await newPage('ru', 'light', 1440, [])
    const { page, context } = data
    await page.goto(data.entry.href)
    await poll(async () => await page.locator('.empty-ranking').count() === 3, 'empty rankings')
    await noOverflow(page, 'empty session')
    await context.close()
    console.log('PASS: empty session')
  }

  for (const locale of ['ru', 'en']) {
    for (const theme of ['light', 'dark']) {
      const data = await newPage(locale, theme)
      const { page, context } = data
      await populate(data)
      assert.equal((await page.locator('main h1').textContent()).trim(), locale === 'ru' ? 'Обзор' : 'Overview')
      for (const width of [1440, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1040 })
        await delay(100)
        await noOverflow(page, `${locale}/${theme}/${width}`)
        if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(out, `overview-${locale}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
      await context.close()
    }
  }
  {
    const data = await newPage()
    const { page, context } = data
    await populate(data)
    const start = Date.now()
    await page.clock.install({ time: start })
    for (let i = 1; i <= 36; i++) {
      await page.clock.setSystemTime(start + i * 4000)
      data.traffic().send(JSON.stringify({ down: (i % 12 === 3 ? 7 : 1 + Math.sin(i * 0.6)) * 1_000_000, up: (i % 16 === 8 ? 3 : 0.2 + Math.sin(i * 0.3) * 0.15) * 1_000_000 }))
      await delay(10)
    }
    await page.screenshot({ path: path.join(out, 'overview-ru-light-1440-traffic.png'), fullPage: true, animations: 'disabled' })
    const colors = await page.evaluate(() => {
      const chart = document.querySelector('.traffic-chart')
      const canvas = document.createElement('canvas')
      const painter = canvas.getContext('2d')
      const actual = chart.querySelector('canvas')
      const pixels = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data
      const probe = document.createElement('span')
      chart.append(probe)
      return ['--traffic-down', '--traffic-up'].map(name => {
        probe.style.color = `var(${name})`
        const supplied = getComputedStyle(probe).color
        painter.strokeStyle = '#000000'
        painter.strokeStyle = supplied
        const rgb = supplied.match(/[\d.]+/g).slice(0, 3).map(Number)
        let matches = 0
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 200 && rgb.every((channel, c) => Math.abs(channel - pixels[index + c]) < 5)) matches++
        }
        return { name, supplied, accepted: painter.strokeStyle, matches }
      })
    })
    assert.ok(colors.every(color => color.accepted !== '#000000' && color.matches > 20), `Traffic lines not painted in expected colors: ${JSON.stringify(colors)}`)
    console.log(`PASS: multi-minute traffic fixture, canvas colors ${JSON.stringify(colors)}`)
    await context.close()
  }
  assert.deepEqual(errors, [], `Page errors: ${errors.join('\n')}`)
  assert.deepEqual(externalRequests, [], 'External requests made by overview')
  console.log(`PASS: RU/EN, light/dark, 1440/1024/768/390/320 px, no overflow, no page errors or external requests\nScreenshots: ${out}`)
} catch (error) {
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(out, 'overview-failure.png'), fullPage: true }).catch(() => {})
      console.error('PAGE:', (await page.locator('body').textContent()).slice(0, 1400))
    }
  }
  console.error('PAGE ERRORS:', errors)
  throw error
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const exited = once(mock, 'exit')
    mock.kill()
    await Promise.race([exited, delay(5000)])
  }
}
