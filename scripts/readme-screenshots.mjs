// Reproduce README screenshots from an isolated controller and synthetic data.
// Run after npm run build. No saved user profile or external controller is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { APP_UPDATE_URL, stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'docs/images')
const controller = 'http://demo-gateway.example'
const start = Date.parse('2026-11-10T15:00:00Z')
const hosts = ['media.example.com', 'cdn.example.net', 'api.example.org', 'sync.example.com']
const countryByConnection = [...Array(30).fill('NL'), ...Array(18).fill('US'), ...Array(10).fill('DE'), ...Array(6).fill('FI'), ...Array(5).fill('GB'), ...Array(3).fill('JP')]
const weights = Array.from({ length: 72 }, (_, index) => (1 + index % 5) * [6, 3, 2, 1][index % hosts.length])
const totalWeight = weights.reduce((sum, value) => sum + value, 0)
const deviceIPs = ['192.0.2.10', '192.0.2.20', '192.0.2.30']
const nodeNames = ['🇳🇱 Amsterdam 01', '🇳🇱 Amsterdam 02', '🇩🇪 Frankfurt', '🇫🇮 Helsinki', '🇸🇪 Stockholm', '🇺🇸 New York', '🇯🇵 Tokyo', '🇬🇧 London']
const nodeDelays = [42, 48, 56, 64, 71, 128, 212, 86]
let browser
let mock
let mockOutput = ''
const errors = []
const forbiddenRequests = []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function ready(check, message) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(mockOutput)
    await sleep(50)
  }
  throw new Error(message)
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function catalog(locale) {
  const names = locale === 'ru' ? ['Основной маршрут', 'Автовыбор', 'Медиа', 'Локальная сеть'] : ['Main route', 'Auto select', 'Media', 'Local network']
  const proxies = Object.fromEntries(nodeNames.map((name, index) => [name, {
    name, type: index === 2 || index === 6 ? 'Hysteria2' : 'Vless', udp: true, alive: true,
    'provider-name': 'Demo nodes', history: [{ time: new Date(start).toISOString(), delay: nodeDelays[index] }],
  }]))
  proxies.DIRECT = { name: 'DIRECT', type: 'Direct', history: [], alive: true, udp: true }
  proxies.REJECT = { name: 'REJECT', type: 'Reject', history: [], alive: true }
  const group = (name, type, all, now) => { proxies[name] = { name, type, all, now, alive: true, udp: true, history: [{ time: new Date(start).toISOString(), delay: 42 }] } }
  group(names[1], 'URLTest', nodeNames, nodeNames[0])
  group(names[0], 'Selector', [names[1], ...nodeNames, 'DIRECT'], names[1])
  group(names[2], 'Selector', [nodeNames[0], nodeNames[2], nodeNames[5], 'DIRECT'], nodeNames[0])
  group(names[3], 'Selector', ['DIRECT', names[0]], 'DIRECT')
  group('GLOBAL', 'Selector', names, names[0])
  return { proxies, names, providers: { 'Demo nodes': { name: 'Demo nodes', type: 'Proxy', vehicleType: 'HTTP', updatedAt: new Date(start).toISOString(), proxies: nodeNames.map(name => proxies[name]), subscriptionInfo: { Download: 43_000_000_000, Upload: 3_000_000_000, Total: 500_000_000_000, Expire: Math.floor(start / 1000) + 30 * 86400 } } } }
}
function connections(download, upload, names) {
  return Array.from({ length: 72 }, (_, index) => {
    const device = index < 36 ? 0 : index < 60 ? 1 : 2
    const host = index % hosts.length
    const proxy = index % 7 === 0 ? 'DIRECT' : index % 4 === 0 ? nodeNames[2] : nodeNames[0]
    const weight = weights[index] / totalWeight
    return {
      id: `demo-connection-${index}`, metadata: {
        network: index % 9 === 0 ? 'udp' : 'tcp', type: 'Tun', sourceIP: deviceIPs[device], sourcePort: String(51000 + index),
        destinationIP: `203.0.113.${index + 1}`, destinationPort: '443', host: hosts[host], destinationGeoIP: [countryByConnection[index]],
        process: device === 0 ? 'Browser' : device === 1 ? 'Mobile app' : 'Sync', inboundName: 'TUN', dnsMode: 'fake-ip',
      },
      download: Math.floor(80_000_000 * weight + download * weight), upload: Math.floor(5_000_000 * weight + upload * weight),
      start: new Date(start).toISOString(), chains: proxy === 'DIRECT' ? ['DIRECT'] : [proxy, names[1], names[0]],
      rule: proxy === 'DIRECT' ? 'DomainSuffix' : 'RuleSet', rulePayload: proxy === 'DIRECT' ? 'example.org' : 'demo-routes',
    }
  })
}

try {
  await mkdir(output, { recursive: true })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { mockOutput += chunk })
  mock.stderr.on('data', chunk => { mockOutput += chunk })
  await ready(async () => { try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'Mock did not start')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'Install Chromium: npx playwright install chromium')
  for (const locale of ['ru', 'en']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' })
    await stubAppUpdates(context)
    const data = catalog(locale)
    await context.addInitScript(({ locale, controller, deviceIPs }) => {
      localStorage.setItem('miboard.locale', locale)
      localStorage.setItem('miboard.theme', 'dark')
      localStorage.setItem('miboard.backend', JSON.stringify({ url: controller, secret: 'test', name: locale === 'ru' ? 'Демонстрационный шлюз' : 'Demo gateway' }))
      localStorage.setItem('miboard.proxy-card-size', 'compact')
      const aliases = locale === 'ru' ? ['Рабочий ноутбук', 'Телефон', 'Домашний сервер'] : ['Work laptop', 'Phone', 'Home server']
      localStorage.setItem('miboard.device-names.' + encodeURIComponent(controller), JSON.stringify(Object.fromEntries(deviceIPs.map((ip, index) => [ip, aliases[index]]))))
    }, { locale, controller, deviceIPs })
    await context.route(`${controller}/**`, async route => {
      const request = route.request()
      const url = new URL(request.url())
      assert.equal(request.method(), 'GET', 'Screenshots must not mutate controller state')
      if (url.pathname === '/proxies') return route.fulfill({ json: { proxies: data.proxies } })
      if (url.pathname === '/providers/proxies') return route.fulfill({ json: { providers: data.providers } })
      if (url.pathname === '/rules') return route.fulfill({ json: { rules: hosts.map(host => ({ type: 'DomainSuffix', payload: host, proxy: data.names[0], size: -1 })) } })
      const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    await page.clock.install({ time: new Date(start) })
    const sockets = new Map()
    let totalDown = 0, totalUp = 0, sampleDown = 0, sampleUp = 0
    const snapshot = type => type === 'traffic' ? { down: sampleDown, up: sampleUp } : type === 'memory' ? { inuse: 88 * 1024 * 1024 } : { downloadTotal: 12_400_000_000 + totalDown, uploadTotal: 860_000_000 + totalUp, connections: connections(totalDown, totalUp, data.names) }
    await page.routeWebSocket(/demo-gateway\.example\/(traffic|connections|memory)(?:\?|$)/, ws => {
      const type = new URL(ws.url()).pathname.slice(1)
      sockets.set(type, ws)
      ws.send(JSON.stringify(snapshot(type)))
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.href !== APP_UPDATE_URL && ![new URL(origin).host, new URL(controller).host].includes(url.host)) forbiddenRequests.push(url.href)
    })
    await page.goto(`${origin}/ui/#/overview`)
    await page.locator('main h1').waitFor()
    await ready(async () => sockets.size === 3, 'Telemetry streams were not opened')
    for (let index = 0; index < 180; index++) {
      sampleDown = Math.floor((1.5 + 0.6 * Math.sin(index / 11) + 3.6 * Math.exp(-(((index - 54) / 18) ** 2)) + 5.1 * Math.exp(-(((index - 125) / 22) ** 2))) * 1024 * 1024)
      sampleUp = Math.floor((0.28 + 0.13 * Math.sin(index / 15 + 1) + 0.7 * Math.exp(-(((index - 130) / 28) ** 2))) * 1024 * 1024)
      totalDown += sampleDown
      totalUp += sampleUp
      for (const [type, socket] of sockets) socket.send(JSON.stringify(snapshot(type)))
      await page.clock.runFor(1000)
    }
    for (const route of ['overview', 'proxies', 'devices', 'geography']) {
      if (route === 'geography') {
        await page.evaluate(() => { localStorage.setItem('miboard.theme', 'light') })
        // Use the real theme control so the change uses the application's theme state.
        await page.evaluate(() => { location.hash = '/settings?category=appearance' })
        await page.getByRole('radio', { name: locale === 'ru' ? 'Светлая' : 'Light', exact: true }).click()
      }
      await page.evaluate(route => { location.hash = `/${route}`; window.scrollTo(0, 0) }, route)
      await page.waitForFunction(route => location.hash === `#/${route}`, route)
      if (route === 'proxies') await page.locator('.proxy-group').first().waitFor()
      if (route === 'devices') await page.getByTestId('device-flow-node').first().waitFor()
      if (route === 'geography') await page.getByTestId('region-card').first().waitFor()
      await page.clock.runFor(1000)
      totalDown += sampleDown
      totalUp += sampleUp
      for (const [type, socket] of sockets) socket.send(JSON.stringify(snapshot(type)))
      await page.clock.runFor(100)
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode().catch(() => {}))) })
      // Selection-reveal effects may scroll a newly mounted proxy group.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}/${route} overflow`)
      await page.screenshot({ path: path.join(output, `${route}-${locale}-${route === 'geography' ? 'light' : 'dark'}.png`), animations: 'disabled' })
    }
    await context.close()
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(forbiddenRequests, [])
  console.log('PASS: eight README screenshots, RU/EN, synthetic telemetry, no user API or external requests, no browser errors or overflow')
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const closed = once(mock, 'exit'); mock.kill(); await closed }
}
