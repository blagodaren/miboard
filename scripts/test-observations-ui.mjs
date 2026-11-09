// Uses only an isolated mock and synthetic connection stream.
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

const root = fileURLToPath(new URL('../', import.meta.url))
const out = await mkdtemp(path.join(os.tmpdir(), 'miboard-observations-'))
const errors = [], writes = [], dns = []
let browser, mock
async function until(check, label, timeout = 12_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await delay(50) }
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const row = (id, sourceIP, process, country, download) => ({
  id, start: new Date(Date.now() - 5000).toISOString(), upload: 100, download,
  chains: ['exit', 'Select'], rule: 'Match', rulePayload: '',
  metadata: { network: 'tcp', type: 'Tun', sourceIP, sourcePort: '4000', destinationPort: '443',
    destinationIP: country ? '1.1.1.1' : '', host: `${id}.observations.example`, process, processPath: process ? `/bin/${process}` : '',
    destinationGeoIP: country ? [country] : [], destinationIPASN: country === 'DE' ? 'AS64512 Example A' : country ? 'AS64513 Example B' : '',
  },
})
try {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await until(async () => { try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock startup')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  if (!browser) throw new Error('No supported browser is installed')
  for (const locale of ['en', 'ru']) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: locale === 'en' ? 1440 : 320, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' })
    await stubAppUpdates(context)
    await context.addInitScript(({ locale, theme }) => { localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme) }, { locale, theme })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', req => {
      if (new URL(req.url()).origin !== origin) return
      if (!['GET', 'OPTIONS'].includes(req.method())) writes.push(req.url())
      if (new URL(req.url()).pathname === '/dns/query') dns.push(req.url())
    })
    const a = row('archive-a', '192.168.1.20', 'curl', 'DE', 1024)
    const b = row('active-b', '192.168.1.21', 'browser', 'NL', 2048)
    const c = row('archive-unknown', '192.168.1.22', '', '', 512)
    let latest = [a, b, c], socket
    const send = rows => { latest = rows; socket?.send(JSON.stringify({ connections: rows, uploadTotal: 300, downloadTotal: rows.reduce((sum, row) => sum + row.download, 0) })) }
    await page.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; send(latest) })
    const url = new URL(`${origin}/ui/`)
    url.hash = `/analysis?hostname=127.0.0.1&port=${port}&protocol=http&secret=test`
    await page.goto(url.href)
    await page.getByRole('button', { name: locale === 'en' ? /^Applications/ : /^Приложения/ }).waitFor()
    send([a, { ...b, download: 4096 }, c])
    await page.getByRole('button', { name: locale === 'en' ? /^Applications/ : /^Приложения/ }).click()
    await page.getByRole('button', { name: 'curl', exact: true }).waitFor()
    assert.match(await page.locator('tbody').innerText(), /192\.168\.1\.20/)
    assert.match(await page.locator('tbody').innerText(), /192\.168\.1\.21/)
    assert.match(await page.locator('tbody').innerText(), locale === 'en' ? /Unidentified application/ : /Приложение не определено/)
    await page.getByRole('button', { name: locale === 'en' ? /^Networks \/ ASN/ : /^Сети \/ ASN/ }).click()
    await page.getByRole('button', { name: 'AS64512 Example A', exact: true }).waitFor()
    assert.match(await page.locator('tbody').innerText(), locale === 'en' ? /Unidentified ASN/ : /ASN не определена/)
    await page.screenshot({ path: path.join(out, `networks-${locale}-${theme}.png`), fullPage: true })
    send([{ ...b, download: 8192 }])
    await page.evaluate(() => { location.hash = '/geography' })
    await page.getByTestId('observation-range').waitFor()
    await until(async () => (await page.locator('.geo-stats .stat-value').first().innerText()).trim() === '1', 'active geography only')
    await page.getByTestId('observation-range').selectOption('1h')
    await until(async () => (await page.locator('.geo-stats .stat-value').first().innerText()).trim() === '2', 'journal country included')
    assert.match(await page.locator('main').innerText(), /archive-a\.observations\.example/)
    assert.match(await page.locator('main').innerText(), /archive-unknown\.observations\.example/)
    assert.equal(dns.length, 0, 'historical host names must not trigger current DNS requests')
    await page.screenshot({ path: path.join(out, `geography-${locale}-${theme}.png`), fullPage: true })
    await page.evaluate(() => { location.hash = '/devices' })
    await page.getByTestId('observation-range').waitFor()
    assert.equal(await page.getByTestId('device-row').count(), 1)
    await page.getByTestId('observation-range').selectOption('24h')
    await until(async () => await page.getByTestId('device-row').count() === 3, 'journal devices included')
    await page.getByTestId('device-row').filter({ hasText: '192.168.1.20' }).click()
    assert.match(await page.getByTestId('device-details').innerText(), /archive-a\.observations\.example/)
    await page.getByTestId('devices-pause').click()
    send([{ ...b, download: 16_384 }, row('new', '192.168.1.23', 'new-process', 'US', 2048)])
    await delay(100)
    assert.equal(await page.getByTestId('device-row').count(), 3, 'pause keeps chosen history snapshot')
    await page.getByTestId('devices-pause').click()
    await until(async () => await page.getByTestId('device-row').count() === 4, 'resume includes new source')
    await page.getByTestId('observation-range').selectOption('active')
    await until(async () => await page.getByTestId('device-row').count() === 2, 'return to live scope')
    await page.screenshot({ path: path.join(out, `devices-${locale}-${theme}.png`), fullPage: true })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no viewport overflow')

    // The historical-view prompt opens the category containing the journal control.
    await page.evaluate(() => { location.hash = '/settings?category=data' })
    await page.getByTestId('settings-category-panel-data').waitFor()
    await until(async () => await page.locator('#journal-retention').isEnabled(), 'journal settings ready')
    await page.locator('#journal-retention').selectOption('off')
    await page.getByRole('alertdialog').getByRole('button', { name: locale === 'en' ? 'Turn off and clear' : 'Выключить и очистить', exact: true }).click()
    await until(async () => await page.locator('#journal-retention').inputValue() === 'off', 'journal disabled')
    await page.evaluate(() => { location.hash = '/devices' })
    await page.getByTestId('observation-range').selectOption('24h')
    await page.getByTestId('observation-scope').getByRole('link', { name: locale === 'en' ? 'Journal settings' : 'Настройки журнала', exact: true }).click()
    await page.waitForURL(url => url.hash === '#/settings?category=data')
    await page.getByTestId('settings-category-panel-data').waitFor()
    assert(await page.locator('#journal-retention').isVisible(), 'Journal link reveals its settings control')
    assert.equal(await page.getByTestId('settings-category-panel-appearance').isVisible(), false)
    await context.close()
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [], 'reading history and analytics makes no API mutations')
  console.log('Observations UI passed: apps/ASN, journal geography/devices, scope/pause/resume, historical DNS exclusion, journal settings navigation, RU/EN, light/dark, desktop/mobile.')
  console.log(`Screenshots: ${out}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const closed = once(mock, 'exit'); mock.kill(); await closed }
}
