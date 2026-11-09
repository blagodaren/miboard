// Isolated UI checks: never connect to the user's saved controller.
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
const base = process.env.MIBOARD_DEVICES_URL ?? 'http://127.0.0.1:5173/'
const out = path.join(root, '.devices-check')
const errors = []
const externalRequests = []
let browser
let mock
let mockOutput = ''
let port
let origin
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout
  do {
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(`Mock stopped: ${mockOutput}`)
    if (await check()) return
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const result = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return result
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch { /* Try the next installed browser. */ }
  }
  throw new Error('No supported Chrome/Edge browser is installed')
}

function connection(id, sourceIP, host, proxy, download, upload, network = 'tcp') {
  return {
    id,
    metadata: {
      network, type: 'Tun', sourceIP, sourcePort: '49152',
      destinationIP: '203.0.113.10', destinationPort: network === 'udp' ? '53' : '443', host,
      process: sourceIP === '192.168.1.10' ? 'browser.exe' : '',
      processPath: sourceIP === '192.168.1.10' ? 'C:/Program Files/Browser/browser.exe' : '',
      inboundName: 'tun-in',
    },
    download, upload, start: '2026-11-09T10:00:00Z',
    chains: proxy ? [proxy, 'Auto'] : [], rule: proxy === 'DIRECT' ? 'Domain' : 'Match', rulePayload: proxy === 'DIRECT' ? host : '',
  }
}

const fixture = [
  connection('pc-api', '192.168.1.10', 'api.example.com', 'edge-a', 8_000_000, 500_000),
  connection('pc-cdn', '192.168.1.10', 'cdn.example.com', 'edge-a', 3_000_000, 100_000),
  connection('phone-cdn', '192.168.1.20', 'cdn.example.com', 'DIRECT', 2_000_000, 80_000),
  connection('phone-dns', '192.168.1.20', 'dns.example.com', 'DIRECT', 100_000, 100_000, 'udp'),
  connection('ipv6-api', 'fd00::30', 'api.example.com', 'edge-a', 700_000, 20_000),
  connection('unknown', '', 'mystery.example.com', '', 200_000, 5000),
]
const snapshot = (connections) => JSON.stringify({
  downloadTotal: connections.reduce((sum, item) => sum + item.download, 0),
  uploadTotal: connections.reduce((sum, item) => sum + item.upload, 0),
  connections,
})

async function newPage({ locale = 'ru', theme = 'light', width = 1440, initial = fixture } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 1040 },
    colorScheme: theme, reducedMotion: 'reduce',
  })
  await stubAppUpdates(context)
  await context.addInitScript(({ locale, theme }) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', theme)
  }, { locale, theme })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.href !== APP_UPDATE_URL && /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) externalRequests.push(request.url())
  })
  let socket
  let offline = false
  await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => {
    socket = ws
    if (offline) ws.close({ code: 1011, reason: 'Controlled test disconnect' })
    else ws.send(snapshot(initial))
  })
  const entry = new URL(base)
  entry.hash = `/devices?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
  return {
    page, context, entry,
    send(connections) { assert.ok(socket, 'Connections socket was not opened'); socket.send(snapshot(connections)) },
    disconnect() { offline = true; socket.close({ code: 1011, reason: 'Controlled test disconnect' }) },
  }
}

const rows = (page) => page.getByTestId('device-row')
const rowById = (page, id) => page.locator(`[data-testid="device-row"][data-device-id=${JSON.stringify(id)}]`)
const details = (page) => page.getByTestId('device-details')
const search = (page) => page.getByTestId('device-search').locator('input')

async function open(data, expectedRows = 4) {
  await data.page.goto(data.entry.href)
  await data.page.getByRole('heading', { level: 1, name: /^(Устройства|Devices)$/ }).waitFor()
  await eventually(async () => await rows(data.page).count() === expectedRows, `device rows: ${expectedRows}`)
  await data.page.evaluate(() => document.fonts.ready)
}

async function noOverflow(page, description) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  assert.ok(dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${description}: horizontal overflow ${JSON.stringify(dimensions)}`)
}

try {
  port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  mock.stdout.on('data', (data) => { mockOutput += data })
  mock.stderr.on('data', (data) => { mockOutput += data })
  await eventually(async () => {
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated mock startup')
  assert.ok((await fetch(base)).ok, `Frontend unavailable: ${base}`)
  browser = await launchBrowser()
  await mkdir(out, { recursive: true })

  {
    const data = await newPage()
    const { page, context } = data
    await open(data)
    assert.equal(await page.getByTestId('device-summary').count(), 4)
    assert.equal(await page.title(), 'Устройства · MIBoard')
    await page.getByRole('navigation').filter({ visible: true }).getByRole('link', { name: 'Устройства', exact: true }).waitFor()
    assert.equal(await page.locator('[data-testid="device-flow-node"][data-kind="proxy"][data-name="edge-a"]').count(), 1, 'Shared proxy is duplicated')
    assert.equal(await page.locator('[data-testid="device-flow-node"][data-kind="domain"][data-name="api.example.com"]').count(), 1, 'Shared domain is duplicated')
    assert.ok(await page.getByTestId('device-flow-link').count() >= 4)
    const metric = page.getByTestId('devices-metric')
    await metric.selectOption('connections')
    assert.equal(await metric.inputValue(), 'connections')
    await metric.selectOption('traffic')

    await rowById(page, '192.168.1.10').click()
    assert.equal(await details(page).getAttribute('data-device-id'), '192.168.1.10')
    assert.match(await details(page).textContent(), /browser\.exe/)
    assert.match(await details(page).textContent(), /tun-in/)
    assert.equal(await page.getByTestId('device-detail-domain').count(), 2)

    await page.getByTestId('device-alias-input').fill('Рабочий ноутбук')
    await page.getByTestId('device-alias-save').click()
    await eventually(async () => /Рабочий ноутбук/.test(await rowById(page, '192.168.1.10').textContent()), 'saved device name')
    const savedToast = page.locator('[data-toast-id="device-alias-save"]')
    await savedToast.getByText('Название сохранено в этом браузере', { exact: true }).waitFor()
    assert.equal(await details(page).getByText('Название сохранено в этом браузере', { exact: true }).count(), 0, 'The save result is not duplicated inline')
    await page.reload()
    await eventually(async () => await rows(page).count() === 4, 'devices after reload')
    assert.match(await rowById(page, '192.168.1.10').textContent(), /Рабочий ноутбук/)

    await search(page).fill('Рабочий ноутбук')
    await eventually(async () => await rows(page).count() === 1, 'search by alias')
    await search(page).fill('api.example.com')
    await eventually(async () => await rows(page).count() === 2, 'search by domain')
    await search(page).fill('fd00::30')
    await eventually(async () => await rows(page).count() === 1, 'search by IPv6')
    await search(page).fill('browser.exe')
    await eventually(async () => await rows(page).count() === 1, 'search by process')
    await search(page).fill('no-such-device')
    await eventually(async () => await rows(page).count() === 0, 'empty search results')
    await search(page).fill('')
    await eventually(async () => await rows(page).count() === 4, 'cleared search')

    await page.locator('[data-testid="device-flow-node"][data-device-id="192.168.1.20"]').focus()
    await page.keyboard.press('Enter')
    assert.equal(await details(page).getAttribute('data-device-id'), '192.168.1.20')
    await search(page).fill('192.168.1.10')
    await eventually(async () => await details(page).getAttribute('data-device-id') === 'all', 'selection outside the search is cleared')
    await search(page).fill('')
    await page.getByTestId('devices-all').click()

    const pause = page.getByTestId('devices-pause')
    await pause.click()
    const extra = connection('extra', '10.10.0.9', 'new.example.com', 'edge-b', 900_000, 0)
    data.send([...fixture, extra])
    await delay(150)
    assert.equal(await rows(page).count(), 4, 'Paused snapshot changed')
    await pause.click()
    await eventually(async () => await rows(page).count() === 5, 'resume applies the latest snapshot')
    data.send(fixture.filter((item) => item.metadata.sourceIP !== 'fd00::30'))
    await eventually(async () => await rows(page).count() === 3, 'closed devices disappear from the active snapshot')
    assert.equal(await rowById(page, 'fd00::30').count(), 0)
    await noOverflow(page, 'interactive devices page')
    await context.close()
    console.log('PASS: route, 4 summaries, shared flow nodes, device details, search, names, pause/resume and active-only devices')
  }

  {
    const data = await newPage()
    const { page, context } = data
    await open(data)
    await page.evaluate(() => {
      const original = Storage.prototype.setItem
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('miboard.device-names.')) throw new DOMException('Fixture quota', 'QuotaExceededError')
        return original.call(this, key, value)
      }
    })
    await rowById(page, '192.168.1.10').click()
    await page.getByTestId('device-alias-input').fill('Не сохранено')
    await page.getByTestId('device-alias-save').click()
    await page.locator('[data-toast-id="device-alias-save"]').getByText('Не удалось сохранить название в этом браузере', { exact: true }).waitFor()
    assert.equal(await details(page).getByText('Не удалось сохранить название в этом браузере', { exact: true }).count(), 0)
    assert.doesNotMatch(await rowById(page, '192.168.1.10').textContent(), /Не сохранено/, 'A failed save cannot update the device label')
    await context.close()
    console.log('PASS: device alias save outcomes appear once in the global toast; failed storage preserves the prior name')
  }

  {
    const data = await newPage({ initial: [] })
    const { page, context } = data
    await open(data, 0)
    assert.equal(await page.getByTestId('device-summary').count(), 4)
    assert.equal(await page.getByTestId('device-flow-node').count(), 0)
    await noOverflow(page, 'empty devices')
    data.send(fixture)
    await eventually(async () => await rows(page).count() === 4, 'data after an empty snapshot')
    data.disconnect()
    await eventually(async () => await page.getByRole('status').filter({ hasText: /связ|подключ|обновлен|недоступ|отключ/i }).count() > 0, 'offline state')
    assert.equal(await rows(page).count(), 4, 'Disconnect cleared the last known snapshot')
    await context.close()
    console.log('PASS: empty state, recovery and disconnected snapshot')
  }

  for (const locale of ['ru', 'en']) {
    for (const theme of ['light', 'dark']) {
      const data = await newPage({ locale, theme })
      const { page, context } = data
      await open(data)
      assert.equal((await page.locator('main h1').textContent()).trim(), locale === 'ru' ? 'Устройства' : 'Devices')
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 1040 })
        await delay(100)
        await noOverflow(page, `${locale}/${theme}/${width}px`)
        if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(out, `devices-${locale}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' })
      }
      await context.close()
    }
  }
  assert.deepEqual(errors, [], `Page errors: ${errors.join('\n')}`)
  assert.deepEqual(externalRequests, [], 'Devices page made external requests')
  console.log(`PASS: RU/EN, light/dark, 1440/1024/390/320 px, no overflow, no page errors or external requests\nScreenshots: ${out}`)
} catch (error) {
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(out, 'devices-failure.png'), fullPage: true }).catch(() => {})
      console.error('PAGE:', (await page.locator('body').textContent()).slice(0, 1800))
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
