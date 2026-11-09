// Uses a private mock port and synthetic periodic frames; never touches a saved controller.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-traffic-tools-'))
let browser, mock, origin, output = ''
const errors = [], writes = []
async function until(check, label, timeout = 12_000) {
  const end = Date.now() + timeout
  do { if (await check()) return; await pause(40) } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}
async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
function row(id, host, source = '192.168.1.10', inbound = 'in-a', user = 'alice', network = 'tcp') {
  return { id, start: '2026-11-10T10:00:00Z', download: 10_000, upload: 1_000,
    chains: [source === '192.168.1.10' ? 'exit-a' : 'exit-b', 'Select'], rule: 'RuleSet', rulePayload: source === '192.168.1.10' ? 'export-set' : 'other-set',
    metadata: { network, type: inbound ? 'Tun' : '', sourceIP: source, sourcePort: '40000', destinationIP: '1.1.1.1', destinationPort: '443', host, inboundName: inbound, inboundUser: user },
  }
}
const fixture = [
  ...Array.from({ length: 36 }, (_, i) => row(`a-${i}`, `site-${i}.example`, undefined, undefined, undefined, i % 2 ? 'tcp' : 'udp')),
  ...Array.from({ length: 6 }, (_, i) => row(`b-${i}`, `other-${i}.example`, '192.168.1.20', 'in-b')),
  row('literal', '1.2.3.4'), row('unknown', '', '192.168.1.30', '', '', ''),
]
async function exportLines(page, testId) {
  const downloaded = page.waitForEvent('download')
  await page.getByTestId(testId).click()
  const file = await downloaded
  assert.match(file.suggestedFilename(), /^miboard-domains.*\.txt$/)
  const text = await readFile(await file.path(), 'utf8')
  assert.ok(text.endsWith('\n'))
  return text.trim().split('\n')
}
async function route(page, value) {
  await page.evaluate(value => { location.hash = `/${value}` }, value)
  await page.locator('h1').waitFor()
}
async function noOverflow(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label)
}

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], { cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mock.stdout.on('data', chunk => { output += chunk }); mock.stderr.on('data', chunk => { output += chunk })
  await until(async () => { if (mock.exitCode !== null) throw new Error(output); try { return (await fetch(origin + '/version', { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock ready')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert.ok(browser, 'Browser is available')
  for (const locale of ['en', 'ru']) for (const theme of ['light', 'dark']) {
    const width = locale === 'ru' ? 320 : 1530
    const context = await browser.newContext({ viewport: { width, height: 1050 }, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: true })
    await stubAppUpdates(context)
    await context.addInitScript(({ origin, locale, theme }) => {
      localStorage.setItem('miboard.backend', JSON.stringify({ url: origin, secret: 'test' }))
      localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme)
    }, { origin, locale, theme })
    const page = await context.newPage()
    page.setDefaultTimeout(12_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).origin === origin && !['GET', 'OPTIONS'].includes(request.method())) writes.push(request.url()) })
    let socket, latest = fixture
    const send = rows => {
      latest = rows
      socket?.send(JSON.stringify({ connections: rows, downloadTotal: rows.reduce((sum, r) => sum + r.download, 0), uploadTotal: rows.reduce((sum, r) => sum + r.upload, 0) }))
    }
    await page.routeWebSocket(/\/connections(?:\?|$)/, ws => { socket = ws; send(latest) })
    const timer = setInterval(() => send(latest), 1000)
    try {
      await page.goto(`${origin}/ui/#/analysis`)
      await page.getByTestId('analysis-export-domains').waitFor()
      send(fixture.map(r => ({ ...r, download: r.download + 1024 })))
      await page.getByRole('searchbox').fill('site-')
      assert.equal((await exportLines(page, 'analysis-export-domains')).length, 36, 'export includes domains beyond first 25 table rows')
      await page.getByRole('searchbox').fill('no-matching-domain')
      assert.equal(await page.getByTestId('analysis-export-domains').isDisabled(), true)
      await page.getByRole('searchbox').fill('')
      await page.getByRole('button', { name: locale === 'en' ? /^Proxies\s/ : /^Прокси\s/ }).click()
      await page.locator('tbody').getByRole('button', { name: 'exit-a', exact: true }).click()
      assert.equal((await exportLines(page, 'analysis-detail-export-domains')).length, 36)

      await page.getByRole('button', { name: locale === 'en' ? /^Inbound traffic/ : /^Входящий трафик/ }).click()
      await page.getByTestId('inbound-dimension').waitFor()
      await page.locator('tbody').getByRole('button', { name: 'in-a', exact: true }).waitFor()
      assert.match(await page.locator('tbody').innerText(), locale === 'en' ? /Unknown inbound/ : /Неизвестный вход/)
      await page.getByTestId('inbound-dimension').selectOption('protocols')
      await page.locator('tbody').getByRole('button', { name: 'TCP', exact: true }).waitFor()
      await page.locator('tbody').getByRole('button', { name: 'UDP', exact: true }).waitFor()
      await page.getByTestId('inbound-dimension').selectOption('users')
      assert.equal(await page.locator('tbody').getByRole('button', { name: 'alice', exact: true }).count(), 2, 'same login remains separated by inbound')
      await page.getByRole('searchbox').fill('in-a')
      assert.equal(await page.locator('tbody').getByRole('button', { name: 'alice', exact: true }).count(), 1)
      assert.equal((await exportLines(page, 'analysis-export-domains')).length, 36)
      await noOverflow(page, `${locale}/${theme}: inbound width ${width}`)
      await page.screenshot({ path: path.join(screenshots, `inbound-${locale}-${theme}-${width}.png`), fullPage: true })

      await route(page, 'devices')
      await page.getByTestId('device-row').filter({ hasText: '192.168.1.10' }).click()
      assert.equal(await page.getByTestId('device-detail-domain').count(), 8)
      assert.equal((await exportLines(page, 'device-export-domains')).length, 36, 'device exports complete list beyond top 8')
      await noOverflow(page, `${locale}/${theme}: devices width ${width}`)
      await page.screenshot({ path: path.join(screenshots, `device-${locale}-${theme}-${width}.png`), fullPage: true })
      await route(page, 'rules')
      await page.getByTestId('rule-export-domains').waitFor()
      assert.equal((await exportLines(page, 'rule-export-domains')).length, 36, 'rule exports complete list beyond top 10')
      await noOverflow(page, `${locale}/${theme}: rules width ${width}`)
      await page.screenshot({ path: path.join(screenshots, `rule-${locale}-${theme}-${width}.png`), fullPage: true })
    } finally { clearInterval(timer); await context.close() }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [], 'analytics and downloads never change the controller')
  console.log('PASS: full filtered TXT exports beyond page/chart limits; per-proxy/device/rule; inbound/protocol/user and unknown groups; RU/EN and light/dark at 320/1530px; no API mutations or browser errors.')
  console.log(`Screenshots: ${screenshots}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) { const stopped = once(mock, 'exit'); mock.kill(); await stopped }
}
