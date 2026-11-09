// An isolated controller and browser profile; never touches a saved user backend.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { APP_UPDATE_URL, stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-diagnostics-'))
let mock, browser, origin
let mockOutput = ''
const errors = [], external = [], queries = []
async function poll(check, message, timeout = 10000) {
  const until = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  } while (Date.now() < until)
  throw new Error(`Timed out: ${message}`)
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch { /* Installed browser fallback. */ }
  }
  throw new Error('No supported browser available')
}
function connection(id, host, exit) {
  return { id, metadata: { host, network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '50000',
    destinationIP: '203.0.113.7', destinationPort: '443', process: 'browser.exe' },
    start: new Date(Date.now() - 60000).toISOString(), upload: 100, download: 1000,
    chains: [exit, 'Auto', 'Policy'], rule: 'DomainSuffix', rulePayload: host }
}
const example = connection('example', 'example.com', 'actual-exit')
const unrelated = connection('shared-ip', 'unrelated.test', 'wrong-shared-ip-exit')
const snapshot = connections => JSON.stringify({ connections, downloadTotal: 2000, uploadTotal: 200 })

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mock.stdout.on('data', chunk => mockOutput += chunk)
  mock.stderr.on('data', chunk => mockOutput += chunk)
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(mockOutput)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'mock startup')
  browser = await launchBrowser()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' })
  await stubAppUpdates(context)
  await context.addInitScript(() => { if (!localStorage.getItem('miboard.locale')) localStorage.setItem('miboard.locale', 'en') })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url() !== APP_UPDATE_URL && !request.url().startsWith(origin) && !request.url().startsWith('data:')) external.push(request.url()) })
  let socket
  await page.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; ws.send(snapshot([example, unrelated])) })
  const pending = []
  await page.route(`${origin}/dns/query?*`, async route => {
    const request = route.request(), url = new URL(request.url())
    const name = url.searchParams.get('name'), type = url.searchParams.get('type')
    queries.push({ name, type, authorization: request.headers().authorization, method: request.method() })
    if (name === 'slow.test') { pending.push(route); return }
    const body = name === 'missing.test' ? { Status: 3 } : name === 'invalid.test' ? { Answer: [] }
      : type === 'AAAA' ? { Status: 0, Answer: [] }
      : { Status: 0, Answer: [{ name, type: 5, TTL: 60, data: 'edge.test' }, { name: 'edge.test', type: 1, TTL: 60, data: '203.0.113.7' }] }
    await route.fulfill({ json: body })
  })
  await page.goto(`${origin}/ui/#/analysis?secret=test`)
  await page.getByRole('heading', { name: 'IP & Domain analysis', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Diagnose domain', exact: true }).click()
  const panel = page.locator('#domain-diagnostics')
  const field = panel.locator('#diagnostic-domain')
  await field.fill('https://Example.COM/path?private=1')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await panel.getByText('DNS check finished', { exact: true }).waitFor()
  assert.equal(await field.inputValue(), 'example.com')
  assert.deepEqual(queries.map(({ name, type }) => ({ name, type })).sort((a, b) => a.type.localeCompare(b.type)), [
    { name: 'example.com', type: 'A' }, { name: 'example.com', type: 'AAAA' },
  ])
  assert(queries.every(query => query.authorization === 'Bearer test' && query.method === 'GET'))
  await panel.getByText('Policy → Auto → actual-exit', { exact: true }).waitFor()
  assert.equal(await panel.getByText('wrong-shared-ip-exit', { exact: false }).count(), 0)
  assert(await panel.getByText('No records of this type').isVisible())
  assert(await panel.getByText('203.0.113.7', { exact: true }).isVisible())
  console.log('PASS: authenticated controller DNS, URL normalization, actual route and shared-IP isolation')

  socket.send(snapshot([unrelated]))
  await panel.getByText('Completed', { exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'Diagnose domain', exact: true }).click()
  await field.fill('never-seen.test')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await panel.getByText('No connection has been observed for this domain').waitFor()
  assert.equal(await panel.getByText('actual-exit', { exact: false }).count(), 0)
  console.log('PASS: completed journal observation and honest unknown route')

  await field.fill('missing.test')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await poll(async () => await panel.getByText('Domain not found (NXDOMAIN)', { exact: true }).count() === 2, 'NXDOMAIN')
  await field.fill('invalid.test')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await poll(async () => await panel.getByText('The core returned an invalid DNS response', { exact: true }).count() === 2, 'invalid response')
  const before = queries.length
  await field.fill('http://user:secret@example.com')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await panel.getByRole('alert').waitFor()
  assert.equal(queries.length, before, 'credentials rejected before any request')

  await field.fill('slow.test')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await poll(() => pending.length === 2, 'both slow requests started')
  await panel.getByRole('button', { name: 'Cancel check', exact: true }).click()
  await field.fill('example.com')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await panel.getByText('DNS check finished', { exact: true }).waitFor()
  for (const route of pending.splice(0)) await route.fulfill({ json: { Status: 0, Answer: [{ name: 'slow.test', type: 1, TTL: 60, data: 'STALE-RESULT' }] } }).catch(() => {})
  assert.equal(await panel.getByText('STALE-RESULT').count(), 0)
  await field.fill('slow.test')
  await panel.getByRole('button', { name: 'Check', exact: true }).click()
  await poll(() => pending.length === 2, 'requests before unmount')
  await panel.getByRole('button', { name: 'Close diagnostics' }).click()
  for (const route of pending.splice(0)) await route.fulfill({ json: { Status: 0 } }).catch(() => {})
  assert.equal(await panel.count(), 0)
  console.log('PASS: invalid input, NXDOMAIN, bad responses, cancellation, stale response and unmount')

  await page.getByRole('button', { name: 'example.com', exact: true }).click()
  await page.locator('[id^="analysis-details-"]:visible').getByRole('button', { name: 'Diagnose domain', exact: true }).click()
  await panel.getByText('DNS check finished', { exact: true }).waitFor()
  assert.equal(await field.inputValue(), 'example.com', 'domain detail opens and checks the selected domain')
  await panel.getByRole('button', { name: 'Close diagnostics' }).click()
  await page.getByRole('button', { name: 'example.com', exact: true }).click()

  for (const locale of ['ru', 'en']) {
    await page.evaluate(locale => localStorage.setItem('miboard.locale', locale), locale)
    await page.reload()
    await page.getByRole('button', { name: locale === 'ru' ? 'Диагностика домена' : 'Diagnose domain', exact: true }).click()
    await field.fill('example.com')
    await panel.getByRole('button', { name: locale === 'ru' ? 'Проверить' : 'Check', exact: true }).click()
    await panel.getByText(locale === 'ru' ? 'Проверка DNS завершена' : 'DNS check finished', { exact: true }).waitFor()
    for (const width of [390, 320, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 900 : 1100 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${locale} ${width}px has no page overflow`)
      assert(await panel.getByRole('button', { name: locale === 'ru' ? 'Проверить' : 'Check', exact: true }).isVisible())
      if (width !== 320) await page.screenshot({ path: path.join(screenshots, `diagnostics-${locale}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [], 'all requests stay on the isolated controller')
  console.log(`PASS: RU/EN at 320/390/1440px; screenshots: ${screenshots}`)
  await context.close()
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const stopped = once(mock, 'exit'); mock.kill(); await stopped }
}
