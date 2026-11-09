// Fresh browser storage and ephemeral local backends only. Real WebSocket frames drive the UI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'
import { APP_UPDATE_URL, stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-sidebar-'))
const MiB = 1024 * 1024
const errors = []
const externalRequests = []
const facades = []
let browser
let mock
let mockOutput = ''

async function poll(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  do {
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(`Mock stopped: ${mockOutput}`)
    if (await check()) return
    await delay(30)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No supported browser available')
}

// HTTP goes to the ordinary mock; WebSocket connections stay here so tests control
// close/reconnect and the interval between an open socket and its first data frame.
async function backendFacade(mockPort) {
  const requests = []
  const channels = new Map()
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: new URL(req.url, 'http://fixture').pathname })
    const upstream = http.request({ hostname: '127.0.0.1', port: mockPort, path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(res)
    })
    upstream.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(String(error)) })
    req.pipe(upstream)
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://fixture')
    if (url.searchParams.get('token') !== 'test' || !['/traffic', '/memory', '/connections'].includes(url.pathname)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const opened = channels.get(url.pathname) ?? []
      opened.push(ws)
      channels.set(url.pathname, opened)
      ws.on('error', error => errors.push(`Fixture WebSocket: ${error.message}`))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const facade = {
    origin, requests,
    opens(name) { return channels.get('/' + name)?.length ?? 0 },
    socket(name) { return channels.get('/' + name)?.at(-1) },
    send(name, data) {
      const ws = this.socket(name)
      assert.equal(ws?.readyState, 1, `${name} WebSocket is open before sending a real frame`)
      ws.send(JSON.stringify(data))
    },
    async close() {
      for (const sockets of channels.values()) for (const ws of sockets) ws.terminate()
      await new Promise(resolve => wss.close(resolve))
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
  }
  facades.push(facade)
  return facade
}

const connections = count => Array.from({ length: count }, (_, i) => ({
  id: `sidebar-${i}`, metadata: { network: 'tcp', type: 'Tun', sourceIP: `192.168.1.${10 + i}`, sourcePort: String(50000 + i), destinationIP: `1.1.1.${i + 1}`, destinationPort: '443', host: `sidebar-${i}.example`, destinationGeoIP: ['US'] },
  download: 1024 * (i + 1), upload: 512 * (i + 1), start: '2026-11-10T00:00:00Z', chains: ['DIRECT'], rule: 'MATCH', rulePayload: '',
}))
const snapshot = (count, down, up) => ({ connections: connections(count), downloadTotal: down, uploadTotal: up })
const metricIds = ['download', 'upload', 'download-total', 'upload-total', 'connections', 'memory']

try {
  const mockPort = await freePort()
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(mockPort), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  mock.stdout.on('data', chunk => { mockOutput += chunk })
  mock.stderr.on('data', chunk => { mockOutput += chunk })
  await poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${mockPort}/version`, { headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }, 'mock startup')
  const a = await backendFacade(mockPort)
  const b = await backendFacade(mockPort)
  const base = new URL(process.env.MIBOARD_SIDEBAR_URL ?? `${a.origin}/ui/`)
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'The frontend test URL must be local')
  base.search = ''
  base.hash = `/overview?hostname=127.0.0.1&port=${new URL(a.origin).port}&protocol=http&secret=test`
  browser = await launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(() => {
    if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en')
    if (!localStorage.getItem('miboard.theme')) localStorage.setItem('miboard.theme', 'dark')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.href !== APP_UPDATE_URL && ['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) externalRequests.push(request.url())
  })
  const stats = page.getByTestId('sidebar-stats')
  const metric = name => stats.getByTestId('sidebar-' + name)
  const read = async () => Object.fromEntries(await Promise.all(metricIds.map(async name => [name, (await metric(name).innerText()).trim()])))
  async function expectValues(expected, label) {
    await poll(async () => {
      const actual = await read()
      return Object.entries(expected).every(([key, value]) => actual[key] === value)
    }, label)
    const actual = await read()
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, `${label}: ${key}`)
  }
  const allDash = Object.fromEntries(metricIds.map(name => [name, '—']))
  const waitStreams = async backend => poll(() => ['traffic', 'memory', 'connections'].every(name => backend.socket(name)?.readyState === 1), 'all three real WebSockets open')
  await page.goto(base.href)
  await stats.waitFor()
  await page.getByRole('region', { name: 'Core activity', exact: true }).waitFor()
  for (const label of ['Download', 'Upload', 'Connections', 'Core memory']) await stats.locator('dt').getByText(label, { exact: true }).waitFor()
  await waitStreams(a)
  await expectValues(allDash, 'Open sockets do not imply that a first frame has arrived')
  assert.equal(await stats.getByTestId('sidebar-traffic-history').locator('svg').count(), 0)

  a.send('traffic', { down: 0, up: 0 })
  a.send('memory', { inuse: 0 })
  a.send('connections', snapshot(0, 0, 0))
  await expectValues({ download: '0 B/s', upload: '0 B/s', 'download-total': '0 B', 'upload-total': '0 B', connections: '0', memory: '0 B' }, 'Measured zeros remain real values')
  a.send('traffic', { down: 2 * MiB, up: 512 * 1024 })
  a.send('memory', { inuse: 64 * MiB })
  a.send('connections', snapshot(3, 12 * MiB, 3 * MiB))
  const first = { download: '2.0 MB/s', upload: '512 KB/s', 'download-total': '12 MB', 'upload-total': '3.0 MB', connections: '3', memory: '64 MB' }
  await expectValues(first, 'Six sidebar values use real traffic, memory and connection frames')
  await stats.getByTestId('sidebar-traffic-history').getByRole('img').waitFor()
  const firstOpens = ['traffic', 'memory', 'connections'].map(name => a.opens(name))
  assert.deepEqual(firstOpens, [1, 1, 1], 'The sidebar shares the three core streams')
  await delay(2200)
  assert.deepEqual(['traffic', 'memory', 'connections'].map(name => a.opens(name)), firstOpens, 'Rendering the sidebar does not open extra streams')
  const restPolls = backend => backend.requests.filter(request => ['GET', 'POST'].includes(request.method) && /^\/(traffic|memory|connections)(?:\/|$)/.test(request.path))
  assert.deepEqual(restPolls(a), [], 'The sidebar does not add REST polling for live counters')
  console.log('PASS: six real WebSocket values, initial/zero states and no additional streams or REST polling')

  for (const [route, title] of [['devices', 'Devices'], ['settings', 'Settings'], ['overview', 'Overview']]) {
    await page.locator('aside nav').getByRole('link', { name: title, exact: true }).click()
    await page.getByRole('heading', { level: 1, name: title, exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash.split('?')[0], '#/' + route)
    await expectValues(first, 'Navigation preserves the live sidebar values')
  }
  assert.deepEqual(['traffic', 'memory', 'connections'].map(name => a.opens(name)), firstOpens, 'Page navigation keeps the same stream connections')

  const live = { ...first }
  for (const name of ['traffic', 'memory', 'connections']) {
    const before = a.opens(name)
    a.socket(name).close(1011, 'Fixture partial disconnect')
    const lost = name === 'traffic' ? { download: '—', upload: '—' } : name === 'memory' ? { memory: '—' } : { connections: '—', 'download-total': '—', 'upload-total': '—' }
    await expectValues({ ...live, ...lost }, `${name} close hides only its own measurements`)
    await poll(() => a.opens(name) === before + 1 && a.socket(name)?.readyState === 1, `${name} reconnect opens a new real socket`)
    await delay(80)
    await expectValues({ ...live, ...lost }, `${name} reconnect waits for its first new frame`)
    if (name === 'traffic') {
      assert.equal(await stats.getByTestId('sidebar-traffic-history').locator('svg').count(), 0)
      a.send(name, { down: 3 * MiB, up: 256 * 1024 })
      Object.assign(live, { download: '3.0 MB/s', upload: '256 KB/s' })
    } else if (name === 'memory') {
      a.send(name, { inuse: 96 * MiB })
      live.memory = '96 MB'
    } else {
      a.send(name, snapshot(2, 20 * MiB, 5 * MiB))
      Object.assign(live, { connections: '2', 'download-total': '20 MB', 'upload-total': '5.0 MB' })
    }
    await expectValues(live, `${name} resumes after a new frame`)
  }
  console.log('PASS: independent traffic/memory/connections close, open-without-frame and recovery states')

  for (const [width, height] of [[1440, 900], [1366, 768], [1024, 600]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
    const sidebar = page.locator('aside')
    const nav = sidebar.locator('nav')
    const panelBox = await stats.boundingBox()
    const navBox = await nav.boundingBox()
    assert(panelBox.y >= 0 && panelBox.y + panelBox.height <= height + 1, `The stats panel remains inside ${width}x${height}`)
    assert(navBox.y + navBox.height <= panelBox.y + 1, 'The navigation and lower stats panel do not overlap')
    if (height === 600) {
      assert(await nav.evaluate(node => node.scrollHeight > node.clientHeight), 'Short desktop navigation scrolls inside its own region')
      const settings = nav.getByRole('link', { name: 'Settings', exact: true })
      await settings.focus()
      const box = await settings.boundingBox()
      const frame = await nav.boundingBox()
      assert(box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1, 'Keyboard focus reveals the last navigation entry')
      await settings.press('Enter')
      await page.getByRole('heading', { level: 1, name: 'Settings', exact: true }).waitFor()
      await expectValues(live, 'Keyboard navigation leaves live counters intact')
    }
    await page.evaluate(() => scrollTo(0, 0))
    await page.screenshot({ path: path.join(screenshots, `sidebar-en-dark-${width}x${height}.png`), animations: 'disabled' })
  }

  const beforeDeepLink = ['traffic', 'memory', 'connections'].map(name => a.opens(name))
  const settingsEntry = new URL(base)
  settingsEntry.hash = `/settings?hostname=127.0.0.1&port=${new URL(a.origin).port}&protocol=http&secret=test`
  await page.goto(settingsEntry.href)
  await page.reload()
  await page.getByRole('heading', { level: 1, name: 'Settings', exact: true }).waitFor()
  await poll(() => ['traffic', 'memory', 'connections'].every((name, i) => a.opens(name) > beforeDeepLink[i] && a.socket(name)?.readyState === 1), 'fresh deep-link streams open')
  a.send('traffic', { down: 3 * MiB, up: 256 * 1024 })
  a.send('memory', { inuse: 96 * MiB })
  a.send('connections', snapshot(2, 20 * MiB, 5 * MiB))
  await expectValues(live, 'Deep-link reload receives its own new stream frames')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const deepNav = page.locator('aside nav')
  const activeSettings = deepNav.getByRole('link', { name: 'Settings', exact: true })
  const selectedBox = await activeSettings.boundingBox()
  const deepNavBox = await deepNav.boundingBox()
  assert.equal(await activeSettings.getAttribute('aria-current'), 'page')
  assert(selectedBox.y >= deepNavBox.y - 1 && selectedBox.y + selectedBox.height <= deepNavBox.y + deepNavBox.height + 1, 'Settings deep link reveals its selected item in the short desktop nav')
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'Revealing the selected navigation item does not scroll page content')
  await page.screenshot({ path: path.join(screenshots, 'sidebar-en-dark-settings-deeplink-1024x600.png'), animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await stats.isVisible(), false, 'Desktop stats are hidden on mobile')
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
  await page.screenshot({ path: path.join(screenshots, 'sidebar-en-dark-390.png'), animations: 'disabled' })
  console.log('PASS: 1440x900, 1366x768, 1024x600 navigation accessibility and mobile 390px without overflow')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { location.hash = '#/setup' })
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.locator('#backend-url').fill(b.origin)
  await page.locator('#backend-secret').fill('test')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await stats.waitFor()
  await waitStreams(b)
  await expectValues(allDash, 'Switching backends clears every metric before its first frame')
  assert.equal(await stats.getByTestId('sidebar-traffic-history').locator('svg').count(), 0, 'A new backend cannot reuse the previous traffic graph')
  await poll(() => ['traffic', 'memory', 'connections'].every(name => a.socket(name)?.readyState === 3), 'Previous backend sockets close')
  b.send('traffic', { down: 4 * MiB, up: MiB })
  await expectValues({ ...allDash, download: '4.0 MB/s', upload: '1.0 MB/s' }, 'The new traffic frame cannot revive old memory, totals or connections')
  b.send('memory', { inuse: 32 * MiB })
  b.send('connections', snapshot(1, 30 * MiB, 2 * MiB))
  await expectValues({ download: '4.0 MB/s', upload: '1.0 MB/s', 'download-total': '30 MB', 'upload-total': '2.0 MB', connections: '1', memory: '32 MB' }, 'The new backend displays only its own measurements')

  await page.setViewportSize({ width: 1024, height: 600 })
  const beforeRussian = ['traffic', 'memory', 'connections'].map(name => b.opens(name))
  await page.evaluate(() => {
    localStorage.setItem('miboard.locale', 'ru')
    localStorage.setItem('miboard.theme', 'light')
    location.hash = '#/settings'
  })
  await page.reload()
  await page.getByRole('region', { name: 'Активность ядра', exact: true }).waitFor()
  for (const label of ['Загрузка', 'Отдача', 'Соединения', 'Память ядра']) await stats.locator('dt').getByText(label, { exact: true }).waitFor()
  await poll(() => ['traffic', 'memory', 'connections'].every((name, i) => b.opens(name) > beforeRussian[i] && b.socket(name)?.readyState === 1), 'Russian locale streams reconnect after reload')
  await expectValues(allDash, 'Russian waiting values remain dashes before new frames')
  await stats.getByText('Ожидание данных трафика', { exact: true }).waitFor()
  b.send('traffic', { down: 4 * MiB, up: MiB })
  b.send('memory', { inuse: 32 * MiB })
  b.send('connections', snapshot(1, 30 * MiB, 2 * MiB))
  await expectValues({ download: '4,0 МБ/с', upload: '1,0 МБ/с', 'download-total': '30 МБ', 'upload-total': '2,0 МБ', connections: '1', memory: '32 МБ' }, 'Russian labels and localized numbers use the same live measurements')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert(await stats.evaluate(node => node.scrollWidth <= node.clientWidth), 'Russian sidebar copy fits its panel at 1024x600')
  assert(await stats.locator('dt, dd').evaluateAll(nodes => nodes.every(node => parseFloat(getComputedStyle(node).fontSize) >= 12)), 'Sidebar labels and measurements keep at least 12px text')
  const russianNav = page.locator('aside nav')
  const russianSettings = await russianNav.getByRole('link', { name: 'Настройки', exact: true }).boundingBox()
  const russianNavBox = await russianNav.boundingBox()
  assert(russianSettings.y >= russianNavBox.y - 1 && russianSettings.y + russianSettings.height <= russianNavBox.y + russianNavBox.height + 1, 'The Russian Settings deep link is visible in short navigation')
  assert.equal(await page.evaluate(() => scrollY), 0)
  await page.screenshot({ path: path.join(screenshots, 'sidebar-ru-light-1024x600.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await stats.isVisible(), false, 'The localized stats panel remains hidden on mobile')
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth)
  await page.screenshot({ path: path.join(screenshots, 'sidebar-ru-light-390.png'), animations: 'disabled' })
  console.log('PASS: EN/RU labels, localized numbers, readable 12px+ copy and short/mobile Russian layouts')

  assert.deepEqual(restPolls(a), [])
  assert.deepEqual(restPolls(b), [])
  assert.deepEqual(externalRequests, [], 'No real controller or external network source was contacted')
  assert.deepEqual(errors, [], 'No browser or fixture runtime errors')
  console.log(`PASS: backend generation isolation and independent first frames\nScreenshots: ${screenshots}`)
  await context.close()
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error('PAGE:', (await page.locator('body').textContent()).slice(0, 1800))
    await page.screenshot({ path: path.join(screenshots, 'sidebar-failure.png'), fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  for (const facade of facades) await facade.close()
  if (mock && mock.exitCode === null) { const stopped = once(mock, 'exit'); mock.kill(); await stopped }
}
