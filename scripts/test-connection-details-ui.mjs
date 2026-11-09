// Isolated controller fixtures only: never use saved user backends or mutate connections.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { APP_UPDATE_URL, stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.connections-check')
const errors = []
const mutations = []
const externalRequests = []
let browser
let mock
let mockOutput = ''

const rich = {
  id: 'details-rich',
  metadata: {
    network: 'tcp', type: 'Tun', sourceIP: '192.168.1.214', destinationIP: '',
    sourceGeoIP: null, destinationGeoIP: ['DE'], sourceIPASN: 'AS64500', destinationIPASN: 'AS64501',
    sourcePort: '52656', destinationPort: '443', inboundIP: '198.18.0.0', inboundPort: '36345',
    inboundName: 'DEFAULT-TUN', inboundUser: 'fixture-user', rematchName: 'fixture-rematch',
    host: 'raw.fixture.example', dnsMode: 'fake-ip', uid: 0,
    process: 'fixture-browser', processPath: 'C:/Fixture/Browser/browser.exe',
    specialProxy: 'fixture-special-proxy', specialRules: 'fixture-special-rule',
    remoteDestination: 'exit.fixture.example', dscp: 0, id: 'details-rich',
    smartBlock: 'fixture-block', smartTarget: 'fixture-smart-target', wildcardTarget: '*.fixture.example',
    exitGeoIP: 'DE', exitIPASN: 'AS64502', sniffHost: 'sniff.fixture.example',
  },
  upload: 627, download: 12018, start: '2026-11-09T20:37:30.130485768Z',
  chains: ['edge-fixture', 'Auto fixture', 'Select fixture'],
  providerChains: ['fixture-provider', '', ''],
  rule: 'RuleSet', rulePayload: 'fixture-domains@domain',
  maxUploadRate: 3290, maxDownloadRate: 71350, downloadSpeed: 0, uploadSpeed: 0,
  futureBackendField: { retained: true, value: 'backend-only-sentinel' },
}
const ipv6 = {
  id: 'details-ipv6',
  metadata: { network: 'udp', type: 'Socks5', sourceIP: 'fd00::123', sourcePort: '5353', destinationIP: '2001:db8::53', destinationPort: '53', host: '', inboundName: '', process: '' },
  upload: 20, download: 0, start: '2026-11-09T20:40:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '',
}
const snapshot = connections => JSON.stringify({ uploadTotal: 10_000, downloadTotal: 100_000, connections })
const activeRows = page => page.getByTestId('active-connection-row')
const richRow = page => activeRows(page).filter({ hasText: 'raw.fixture.example' })

async function poll(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  do {
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(`Mock stopped: ${mockOutput}`)
    if (await check()) return
    await delay(50)
  } while (Date.now() < deadline)
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

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No supported Chrome/Edge browser is installed')
}

async function assertPageFits(page, label) {
  const result = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  assert(result.scroll <= result.width + 1, `${label}: page overflow ${result.scroll} > ${result.width}`)
}

async function savedJournal(page, backend) {
  return page.evaluate(backend => new Promise((resolve, reject) => {
    const request = indexedDB.open('miboard-connection-journal-v1', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const read = db.transaction('backends').objectStore('backends').get(backend)
      read.onsuccess = () => { db.close(); resolve(read.result) }
      read.onerror = () => { db.close(); reject(read.error) }
    }
  }), backend)
}

try {
  await mkdir(out, { recursive: true })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const base = process.env.MIBOARD_CONNECTIONS_URL ?? `${origin}/ui/`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mock.stdout.on('data', value => { mockOutput += value })
  mock.stderr.on('data', value => { mockOutput += value })
  mock.on('error', error => errors.push(error.message))
  await poll(async () => {
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' }, signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }, 'mock startup')
  browser = await launch()

  async function session({ locale = 'en', theme = 'light', width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1040 }, colorScheme: theme, reducedMotion: 'reduce' })
    await stubAppUpdates(context)
    await context.addInitScript(({ locale, theme, origin }) => {
      localStorage.setItem('miboard.locale', locale)
      localStorage.setItem('miboard.theme', theme)
      localStorage.setItem('miboard.device-names.' + encodeURIComponent(origin), JSON.stringify({ '192.168.1.214': 'Fixture laptop' }))
      window.__copiedConnection = null
      window.__clipboardShouldFail = false
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        async writeText(value) {
          if (window.__clipboardShouldFail) throw new DOMException('Fixture clipboard denied', 'NotAllowedError')
          window.__copiedConnection = value
        },
      } })
    }, { locale, theme, origin })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      const url = new URL(request.url())
      if (['DELETE', 'PUT', 'PATCH', 'POST'].includes(request.method()) && url.pathname.startsWith('/connections')) mutations.push(request.url())
      if (url.href !== APP_UPDATE_URL && /^https?:$/.test(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) externalRequests.push(url.href)
    })
    let socket
    let latest = [rich, ipv6]
    await page.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; ws.send(snapshot(latest)) })
    const entry = new URL(base)
    entry.hash = `/connections?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
    await page.goto(entry.href)
    await poll(async () => await activeRows(page).count() === 2, 'two active fixture connections')
    return { context, page, send(rows) { latest = rows; socket.send(snapshot(rows)) } }
  }

  const state = await session()
  const { page } = state
  assert.match(await richRow(page).innerText(), /192\.168\.1\.214/)
  assert.match(await richRow(page).innerText(), /DEFAULT-TUN/)
  assert.match(await richRow(page).innerText(), /exit\.fixture\.example/)
  for (const query of ['sniff.fixture.example', '52656', '36345', 'fixture-user', 'fixture-provider', 'exit.fixture.example', 'C:/Fixture/Browser', 'fake-ip', 'Fixture laptop']) {
    await page.getByRole('searchbox').fill(query)
    await poll(async () => await activeRows(page).count() === 1, `search ${query}`)
    assert.match(await activeRows(page).innerText(), /raw\.fixture\.example/)
  }
  await page.getByRole('searchbox').fill('no-matching-connection')
  await poll(async () => await activeRows(page).count() === 0, 'empty filtered state')
  await page.getByRole('searchbox').fill('')
  await page.getByTestId('connection-columns-toggle').click()
  const columns = page.getByTestId('connection-columns')
  for (const id of ['process', 'sniffHost', 'dnsMode', 'peakSpeed', 'provider']) await columns.locator(`input[data-column="${id}"]`).check()
  await columns.locator('input[data-column="source"]').uncheck()
  await page.reload()
  await page.getByTestId('connection-columns-toggle').click()
  assert.equal(await columns.locator('input[data-column="source"]').isChecked(), false, 'Column selection survives reload')
  for (const id of ['process', 'sniffHost', 'dnsMode', 'peakSpeed', 'provider']) assert.equal(await columns.locator(`input[data-column="${id}"]`).isChecked(), true)
  await page.getByTestId('connection-columns-reset').click()
  assert.equal(await columns.locator('input[data-column="source"]').isChecked(), true)
  assert.equal(await columns.locator('input[data-column="sniffHost"]').isChecked(), false)
  await page.getByTestId('connection-columns-toggle').click()
  console.log('PASS: expanded source/destination/inbound columns, field search, persisted columns and reset')

  const opener = richRow(page).getByRole('button', { name: 'Connection details for raw.fixture.example', exact: true }).first()
  await opener.click()
  const dialog = page.getByTestId('connection-details')
  await dialog.waitFor()
  assert.equal(await dialog.getAttribute('role'), 'dialog')
  const details = await dialog.innerText()
  for (const value of ['raw.fixture.example', 'sniff.fixture.example', 'exit.fixture.example', '52656', '36345', 'DEFAULT-TUN', 'fixture-user', 'C:/Fixture/Browser/browser.exe', 'fixture-provider', 'AS64500', 'AS64501', 'AS64502', 'fake-ip']) assert(details.includes(value), `Details include ${value}`)
  const routeOrder = details.indexOf('Select fixture') < details.indexOf('Auto fixture') && details.indexOf('Auto fixture') < details.indexOf('edge-fixture')
  assert(routeOrder, 'Proxy route is displayed in selection-to-exit order')
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    assert(await dialog.evaluate(node => node.contains(document.activeElement)), 'Keyboard focus stays inside modal')
  }
  await dialog.getByRole('radio', { name: 'JSON', exact: true }).click()
  const raw = JSON.parse(await page.getByTestId('connection-json').innerText())
  assert.deepEqual(raw, rich, 'JSON preserves all backend fields, nulls and zeroes and omits UI-only fields')
  await page.getByTestId('connection-copy-json').click()
  assert.deepEqual(JSON.parse(await page.evaluate(() => window.__copiedConnection)), rich)
  await page.evaluate(() => { window.__clipboardShouldFail = true })
  await page.getByTestId('connection-copy-json').click()
  await poll(async () => /could not|unable|failed|denied/i.test(await dialog.innerText()), 'clipboard failure feedback')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert(await opener.evaluate(node => node === document.activeElement), 'Escape restores focus to opener')
  console.log('PASS: grouped details, provider chain order, exact raw JSON, clipboard feedback, modal focus and Escape')

  await activeRows(page).filter({ hasText: '2001:db8::53' }).getByRole('button', { name: 'Connection details for 2001:db8::53', exact: true }).first().click()
  assert.match(await dialog.innerText(), /\[fd00::123\]:5353/)
  assert.match(await dialog.innerText(), /\[2001:db8::53\]:53/)
  assert(!(await dialog.innerText()).includes('undefined'), 'Missing optional metadata never renders undefined')
  await page.getByTestId('connection-details-close').click()

  await opener.click()
  const updated = { ...rich, download: rich.download + 512, upload: rich.upload + 128 }
  state.send([updated, ipv6])
  await dialog.getByRole('radio', { name: 'JSON', exact: true }).click()
  await poll(async () => JSON.parse(await page.getByTestId('connection-json').innerText()).download === updated.download, 'open dialog receives current connection snapshot')
  state.send([ipv6])
  await dialog.waitFor()
  await page.getByText('This connection is no longer active. Showing the last received snapshot.', { exact: true }).waitFor()
  assert.deepEqual(JSON.parse(await page.getByTestId('connection-json').innerText()), updated, 'Closed live dialog retains the latest observed snapshot')
  await page.keyboard.press('Escape')
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await page.getByTestId('journal-row').count() === 1, 'completed connection recorded')
  await page.getByTestId('journal-row').getByRole('button', { name: 'Connection details for raw.fixture.example', exact: true }).first().click()
  assert.match(await dialog.innerText(), /fixture-provider/)
  assert.match(await dialog.innerText(), /DEFAULT-TUN/)
  await dialog.getByRole('radio', { name: 'JSON', exact: true }).click()
  const archivedRaw = JSON.parse(await page.getByTestId('connection-json').innerText())
  for (const key of ['providerChains', 'maxDownloadRate', 'maxUploadRate', 'downloadSpeed', 'uploadSpeed']) assert.deepEqual(archivedRaw[key], updated[key], `Journal preserves ${key}`)
  for (const key of ['inboundIP', 'inboundPort', 'inboundName', 'inboundUser', 'uid', 'dscp', 'sourceGeoIP', 'remoteDestination', 'smartTarget']) assert.deepEqual(archivedRaw.metadata[key], updated.metadata[key], `Journal preserves metadata.${key}`)
  assert.equal(archivedRaw.futureBackendField, undefined, 'Archive keeps only known bounded backend fields')
  assert.equal(archivedRaw.journal, undefined)
  await page.keyboard.press('Escape')
  await poll(async () => (await savedJournal(page, origin))?.entries?.length === 1, 'expanded archive saved')
  await page.reload()
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await page.getByTestId('journal-row').getByRole('button', { name: 'Connection details for raw.fixture.example', exact: true }).first().click()
  await dialog.getByRole('radio', { name: 'JSON', exact: true }).click()
  assert.deepEqual(JSON.parse(await page.getByTestId('connection-json').innerText()), archivedRaw, 'Expanded journal details survive reload')
  await state.context.close()
  console.log('PASS: IPv6 endpoints, missing fields, live refresh, retained closed snapshot and persisted journal metadata')

  for (const locale of ['ru', 'en']) for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
    const item = await session({ locale, theme, width })
    const page = item.page
    await assertPageFits(page, `${locale}/${theme}/${width} table`)
    const tableScrolls = await page.getByTestId('connections-table').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX }))
    assert.equal(tableScrolls.overflow, 'auto', 'Wide table scrolls in its own container')
    if (width < 768) assert(tableScrolls.scroll > tableScrolls.width, 'Narrow viewport keeps table columns in an internal scroller')
    if (locale === 'ru' && ((width === 1440 && theme === 'dark') || (width === 390 && theme === 'light'))) {
      await page.screenshot({ path: path.join(out, `connections-table-${locale}-${theme}-${width}.png`) })
    }
    await richRow(page).getByRole('button', { name: locale === 'ru' ? 'Детали соединения с raw.fixture.example' : 'Connection details for raw.fixture.example', exact: true }).first().click()
    const dialog = page.getByTestId('connection-details')
    await dialog.waitFor()
    const box = await dialog.boundingBox()
    assert(box && box.x >= -1 && box.x + box.width <= width + 1, `${locale}/${theme}/${width}: dialog fits viewport width`)
    assert(box.y >= -1 && box.y + box.height <= (width < 768 ? 844 : 1040) + 1, `${locale}/${theme}/${width}: dialog fits viewport height`)
    await assertPageFits(page, `${locale}/${theme}/${width} details`)
    if (locale === 'ru' && ((width === 1440 && theme === 'dark') || (width === 390 && theme === 'light'))) {
      await page.screenshot({ path: path.join(out, `connection-details-${locale}-${theme}-${width}.png`) })
    }
    await dialog.getByRole('radio', { name: 'JSON', exact: true }).click()
    assert.deepEqual(JSON.parse(await page.getByTestId('connection-json').innerText()), rich)
    await assertPageFits(page, `${locale}/${theme}/${width} JSON`)
    if (locale === 'ru' && theme === 'dark' && width === 1440) {
      await page.screenshot({ path: path.join(out, `connection-json-${locale}-${theme}-${width}.png`) })
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await item.context.close()
  }
  console.log('PASS: RU/EN × light/dark × 1440/390/320; table, details and JSON stay within the page viewport')
  assert.deepEqual(mutations, [], 'Read-only UI checks issue no connection mutations')
  assert.deepEqual(externalRequests, [], 'Fixtures do not request external services')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`Screenshots: ${out}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const exited = once(mock, 'exit')
    mock.kill()
    await Promise.race([exited, delay(3000)])
  }
}
