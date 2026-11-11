// Isolated browser fixtures and ephemeral mock origins; never open saved user controllers.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'
import { chooseSettingsCategory } from './settings-category-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = await mkdtemp(path.join(os.tmpdir(), 'miboard-journal-'))
const errors = []
const mutations = []
let browser
let mock
let mockOutput = ''
async function poll(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout
  do {
    if (mock?.exitCode !== null && mock?.exitCode !== undefined) throw new Error(`Mock exited: ${mockOutput}`)
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
  throw new Error('No supported browser is installed')
}
const connection = (id, host, sourceIP, proxy) => ({
  id, metadata: { network: 'tcp', type: 'Tun', sourceIP, sourcePort: '49152', destinationIP: '1.1.1.1', destinationPort: '443', host, process: 'journal-browser', processPath: '/applications/journal-browser' },
  download: 4096, upload: 1024, start: '2026-11-09T00:00:00Z', chains: [proxy, 'Auto'], rule: 'Domain', rulePayload: host,
})
const a = connection('closed-a', 'a.journal.example', '192.168.1.10', 'edge-a')
const b = connection('closed-b', 'b.journal.example', '192.168.1.20', 'edge-b')
const snapshot = rows => JSON.stringify({ uploadTotal: 10000, downloadTotal: 100000, connections: rows })
const archived = page => page.getByTestId('journal-row')

async function record(page, backend) {
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
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const base = process.env.MIBOARD_JOURNAL_URL ?? `${origin}/ui/`
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

  async function session(locale = 'en', width = 1440, memory = false, initial = [a, b]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: locale === 'ru' ? 'dark' : 'light', reducedMotion: 'reduce' })
    await stubAppUpdates(context)
    await context.addInitScript(({ locale, origin, memory }) => {
      localStorage.setItem('miboard.locale', locale)
      localStorage.setItem('miboard.device-names.' + encodeURIComponent(origin), JSON.stringify({ '192.168.1.10': 'Work laptop' }))
      localStorage.setItem('miboard.backends', JSON.stringify([{ id: 'unrelated-fixture', url: 'http://unrelated-fixture.invalid:9090', secret: 'fixture-only', name: 'Keep this profile' }]))
      if (memory) Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('Blocked in fixture', 'SecurityError') } })
    }, { locale, origin, memory })
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (['DELETE', 'PUT', 'PATCH', 'POST'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/connections')) mutations.push(request.url()) })
    let socket
    let latest = initial
    let offline = false
    await page.routeWebSocket(/\/connections(?:\?|$)/, ws => {
      socket = ws
      if (offline) ws.close({ code: 1011, reason: 'Fixture offline' })
      else ws.send(snapshot(latest))
    })
    const entry = new URL(base)
    entry.hash = `/connections?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
    await page.goto(entry.href)
    await page.getByTestId('active-connection-row').first().waitFor()
    return {
      context, page, entry,
      send(rows) { latest = rows; socket.send(snapshot(rows)) },
      disconnect() { offline = true; socket.close({ code: 1011, reason: 'Fixture disconnect' }) },
      reconnect(rows) { latest = rows; offline = false },
    }
  }

  const state = await session()
  const { page } = state
  state.send([b])
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await archived(page).count() === 1, 'one completed connection')
  assert.match(await archived(page).innerText(), /a\.journal\.example/)
  assert.equal(await page.getByRole('button', { name: 'Close all', exact: true }).count(), 0)
  assert.equal(await archived(page).getByRole('button', { name: /Close |Switch / }).count(), 0, 'Historical rows have no live mutation actions')
  for (const query of ['a.journal.example', 'Work laptop', '192.168.1.10', 'edge-a']) {
    await page.getByRole('searchbox').fill(query)
    assert.equal(await archived(page).count(), 1, `Journal search matches ${query}`)
  }
  await page.getByRole('searchbox').fill('no-such-journal-record')
  assert.equal(await archived(page).count(), 0)
  await page.getByRole('searchbox').fill('')
  await archived(page).getByRole('button', { name: 'Connection details for a.journal.example', exact: true }).first().click()
  await page.getByTestId('connection-details').waitFor()
  assert.match(await page.getByTestId('connection-details').innerText(), /192\.168\.1\.10.*49152/s)
  assert.match(await page.getByTestId('connection-details').innerText(), /applications\/journal-browser/)
  await poll(async () => (await record(page, origin))?.entries?.length === 1, 'journal persisted to IndexedDB')
  await page.reload()
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await archived(page).count() === 1, 'journal survives reload without duplicate entries')
  console.log('PASS: completed snapshots, domain/device/proxy search, details, persistence and historical rows without live actions')

  state.disconnect()
  await page.getByRole('radio', { name: 'Active', exact: true }).click()
  await page.getByText('Updates are unavailable. Active rows show the last received snapshot.', { exact: true }).waitFor()
  assert.equal(await page.getByTestId('active-connection-row').count(), 1)
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  assert.equal(await archived(page).count(), 1, 'A disconnect is not a closure')
  state.reconnect([])
  await poll(async () => await archived(page).count() === 2, 'missing connection observed after reconnect')
  assert.match(await archived(page).filter({ hasText: 'b.journal.example' }).innerText(), /Observed after a connection gap/)
  console.log('PASS: disconnect preserves active snapshots; reconnect records observed disappearance with uncertainty')

  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await chooseSettingsCategory(page, 'data')
  const settings = page.locator('section[aria-labelledby="journal-settings-heading"]')
  await settings.locator('#journal-retention').selectOption('7d')
  await poll(async () => (await record(page, origin))?.retention === '7d', 'retention preference persisted')
  await settings.getByRole('button', { name: 'Clear journal', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.match(await settings.innerText(), /2 saved connections/)
  await settings.getByRole('button', { name: 'Clear journal', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear journal', exact: true }).click()
  await poll(async () => (await record(page, origin))?.entries?.length === 0, 'clear persisted')
  assert(await page.evaluate(() => JSON.parse(localStorage.getItem('miboard.backends')).some(profile => profile.url === 'http://unrelated-fixture.invalid:9090')), 'Clearing history preserves unrelated saved profiles')
  state.send([a])
  state.send([])
  await poll(async () => (await record(page, origin))?.entries?.length === 1, 'new completed record after clear')
  await settings.locator('#journal-retention').selectOption('off')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await settings.locator('#journal-retention').inputValue(), '7d', 'Cancelling disable keeps the previous policy and select value')
  await settings.locator('#journal-retention').selectOption('off')
  await page.getByRole('alertdialog').getByRole('button', { name: 'Turn off and clear', exact: true }).click()
  await poll(async () => (await record(page, origin))?.retention === 'off', 'disabled recording persisted')
  state.send([b]); state.send([])
  await page.getByRole('link', { name: 'Connections', exact: true }).click()
  await page.getByRole('radio', { name: 'Completed', exact: true }).click()
  assert.equal(await archived(page).count(), 0)
  await page.getByText('Recording is off. Enable it in Settings to retain completed connections.', { exact: true }).waitFor()
  await state.context.close()
  console.log('PASS: retention, clear/disable confirmation and cancellation; saved server profiles are preserved')

  const lifecycle = await session()
  lifecycle.send([b])
  await lifecycle.page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await archived(lifecycle.page).count() === 1, 'pending closure before reload')
  assert.equal((await record(lifecycle.page, origin))?.entries?.length ?? 0, 0, 'The batch window has not written yet')
  await lifecycle.page.reload()
  await lifecycle.page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await archived(lifecycle.page).count() === 1, 'pagehide flush survives immediate reload')
  lifecycle.send([])
  await poll(async () => await archived(lifecycle.page).count() === 2, 'pending closure before backgrounding')
  await lifecycle.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await poll(async () => (await record(lifecycle.page, origin))?.entries?.length === 2, 'backgrounding flushes pending closures', 3000)
  await lifecycle.context.close()
  console.log('PASS: pending journal batches survive immediate reload and flush when the document becomes hidden')

  const many = Array.from({ length: 105 }, (_, i) => connection(`paged-${i}`, `paged-${String(i).padStart(3, '0')}.journal.example`, '192.168.1.30', 'edge-paged'))
  const paging = await session('en', 1440, false, many)
  await poll(async () => await paging.page.getByTestId('active-connection-row').count() === 105, 'the large active snapshot is visible')
  paging.send([])
  await paging.page.getByRole('radio', { name: 'Completed', exact: true }).click()
  await poll(async () => await archived(paging.page).count() === 100, 'the first completed page has 100 records')
  const navigation = paging.page.getByTestId('journal-pagination')
  assert.match(await navigation.innerText(), /Page 1 of 2/)
  await navigation.getByRole('button', { name: 'Next', exact: true }).click()
  assert.equal(await archived(paging.page).count(), 5)
  assert.match(await navigation.innerText(), /Page 2 of 2/)
  await paging.page.getByRole('searchbox').fill('paged-104.journal.example')
  assert.equal(await archived(paging.page).count(), 1, 'Search covers records beyond the first page')
  assert.match(await archived(paging.page).innerText(), /paged-104/)
  await paging.page.getByRole('searchbox').fill('')
  assert.match(await navigation.innerText(), /Page 1 of 2/, 'Search changes reset pagination')
  await navigation.getByRole('button', { name: 'Next', exact: true }).click()
  await paging.page.getByRole('button', { name: 'Host', exact: true }).click()
  assert.match(await navigation.innerText(), /Page 1 of 2/, 'Sorting resets pagination')
  await paging.context.close()
  console.log('PASS: 105 real snapshot closures paginate by 100; search covers the complete journal and sort/search reset the page')

  assert.deepEqual(mutations, [], 'Historical journal controls have not invoked mutation APIs')
  const actions = await session()
  let closeStatus = 500
  await actions.page.route(`${origin}/connections/${a.id}`, route => route.fulfill({ status: closeStatus, ...(closeStatus === 204 ? {} : { json: { message: 'fixture close failure' } }) }))
  const closeButton = actions.page.getByRole('button', { name: 'Close connection to a.journal.example', exact: true })
  await closeButton.click()
  const closeToast = actions.page.locator(`[data-toast-id="connection-close-${a.id}"]`)
  await closeToast.getByText('Could not close a.journal.example: fixture close failure', { exact: true }).waitFor()
  assert.equal(await actions.page.locator('main').getByText('Could not close a.journal.example: fixture close failure', { exact: true }).count(), 0)
  closeStatus = 204
  await closeButton.click()
  await closeToast.getByText('Closure requested for a.journal.example', { exact: true }).waitFor()
  assert.equal(await closeToast.count(), 1, 'Repeating a connection action updates the same notification')
  await actions.page.route(`${origin}/connections`, route => route.fulfill({ status: 500, json: { message: 'fixture close-all failure' } }))
  await actions.page.getByRole('button', { name: 'Close all', exact: true }).click()
  await actions.page.getByRole('alertdialog').getByRole('button', { name: 'Close all', exact: true }).click()
  await actions.page.locator('[data-toast-id="connections-close-all"]').getByText('Could not close all connections: fixture close-all failure', { exact: true }).waitFor()
  await actions.context.close()
  mutations.length = 0 // Subsequent checks again assert that historical-only interactions do not mutate the core.
  console.log('PASS: single/all live-connection failures and success use one global toast with no inline duplicates')

  const setup = await session()
  const setupUrl = new URL(base)
  setupUrl.hash = '/setup'
  await setup.page.goto(setupUrl.href)
  await setup.page.getByRole('button', { name: 'Add', exact: true }).click()
  await setup.page.getByPlaceholder('For example, home router', { exact: true }).fill('Offline toast fixture')
  await setup.page.locator('#backend-url').fill('offline-toast.invalid:9090')
  await setup.page.getByRole('button', { name: 'Save', exact: true }).click()
  await setup.page.locator('[data-toast-id="backend-profile-save"]').getByText('Profile saved', { exact: true }).waitFor()
  assert.equal(await setup.page.locator('form').getByText('Profile saved', { exact: true }).count(), 0)
  await setup.page.locator('#backend-url').fill(origin)
  await setup.page.locator('#backend-secret').fill('wrong-fixture-secret')
  await setup.page.getByRole('button', { name: 'Connect', exact: true }).click()
  const connectToast = setup.page.locator('[data-toast-id="backend-connect"]')
  await connectToast.getByText('Invalid secret', { exact: true }).waitFor()
  assert.equal(await setup.page.locator('#connection-error').count(), 0, 'Authentication failure moved out of form validation')
  await setup.page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ru')
  await connectToast.getByText('Неверный secret', { exact: true }).waitFor()
  assert.equal(await connectToast.count(), 1, 'The same authentication toast reacts to locale changes')
  await setup.context.close()
  console.log('PASS: offline profile saves and API authentication failures use global, locale-reactive notifications')

  for (const memory of [false, true]) {
    const mobile = await session('ru', 320, memory)
    mobile.send([b])
    await mobile.page.getByRole('radio', { name: 'Завершённые', exact: true }).click()
    await poll(async () => await archived(mobile.page).count() === 1, 'Russian mobile journal')
    assert(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The journal fits a 320px document with its own table scroll')
    if (memory) await mobile.page.getByText(/Постоянное хранилище недоступно или заполнено/).waitFor()
    await mobile.page.screenshot({ path: path.join(out, `journal-ru-320-${memory ? 'memory' : 'persistent'}.png`), fullPage: true })
    await mobile.context.close()
  }
  assert.deepEqual(mutations, [], 'Reading/clearing historical rows never invokes controller mutation APIs')
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`PASS: RU/EN, 320px dark layout and unavailable-storage fallback\nScreenshots: ${out}`)
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    console.error('PAGE:', (await page.locator('body').textContent()).slice(0, 2200))
    console.error('BUTTONS:', await page.locator('button').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, role: node.getAttribute('role'), label: node.getAttribute('aria-label') }))))
    await page.screenshot({ path: path.join(out, 'journal-failure.png'), fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const closed = once(mock, 'exit')
    mock.kill()
    await Promise.race([closed, delay(5000)])
  }
}
