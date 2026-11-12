// Isolated controller fixtures; no user profile or real core is read or mutated.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const children = [], errors = []
let browser
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}
async function poll(check, message) {
  const until = Date.now() + 15000
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  throw new Error(`Timed out: ${message}`)
}
function child(args, env = {}) {
  const process_ = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  process_.stdout.on('data', chunk => output += chunk)
  process_.stderr.on('data', chunk => output += chunk)
  children.push(process_)
  return () => { if (process_.exitCode !== null) throw new Error(output) }
}

try {
  const apiPort = await port(), origin = `http://127.0.0.1:${apiPort}`
  const alive = child([path.join(root, 'mock/server.js')], { PORT: String(apiPort), SECRET: 'test' })
  await poll(async () => { alive(); try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock starts')
  const devPort = await port(), base = `http://127.0.0.1:${devPort}/`
  const live = child([path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'])
  await poll(async () => { live(); try { return (await fetch(base)).ok } catch { return false } }, 'Vite starts')
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'Install a supported Playwright browser')
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(() => localStorage.setItem('miboard.locale', 'en'))
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket(/\/connections(?:\?|$)/, socket => socket.send(JSON.stringify({ connections: [], downloadTotal: 0, uploadTotal: 0 })))
  const rules = Array.from({ length: 1400 }, (_, index) => ({ index, type: 'DomainSuffix', payload: `rule-${index}.example.test`, proxy: index % 2 ? 'Select' : 'DIRECT', size: index % 11 ? 0 : 9,
    extra: { disabled: index % 7 === 0, hitCount: index, missCount: 40, hitAt: '2026-11-10T05:00:00Z', missAt: '2026-11-10T05:00:00Z' },
  }))
  await page.route(`${origin}/rules`, route => route.fulfill({ json: { rules } }))
  await page.goto(`${base}#/rules?hostname=127.0.0.1&port=${apiPort}&http=true&secret=test`)
  const table = page.getByTestId('rules-table')
  await page.getByTestId('rule-row').first().waitFor()
  assert(await page.getByTestId('rule-row').count() < 40, 'initial window stays bounded')
  await table.evaluate(element => { element.scrollTop = element.scrollHeight * .62 })
  await poll(async () => Number(await page.getByTestId('rule-row').first().getAttribute('data-rule-index')) > 500, 'scroll reaches rules past the former cap')
  const index = await table.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [...element.querySelectorAll('[data-testid="rule-row"]')].find(row => {
      const box = row.getBoundingClientRect(); return box.top >= bounds.top + 40 && box.bottom < bounds.bottom
    })?.dataset.ruleIndex
  })
  assert(index && Number(index) > 500)
  const chosen = page.locator(`[data-testid="rule-row"][data-rule-index="${index}"]`)
  await chosen.getByRole('button').click()
  const details = page.getByRole('region', { name: `Rule ${new Intl.NumberFormat('en-US').format(Number(index) + 1)} details`, exact: true })
  await details.waitFor()
  await details.getByTestId('rule-toggle').focus()
  await table.evaluate(element => { element.scrollTop = element.scrollHeight })
  await poll(async () => await page.locator('[data-rule-index="1399"]').count() === 1, 'last rule remains reachable with expanded details above')
  assert(await details.count() === 1, 'expanded detail stays mounted when scrolled away')
  assert(await details.getByTestId('rule-toggle').evaluate(element => element === document.activeElement), 'focused detail retains keyboard focus')
  assert(await page.getByTestId('rule-row').count() < 45, 'pinning does not fill the distance between rows')
  await page.getByRole('searchbox').fill('rule-1399.example.test')
  await poll(async () => await page.getByTestId('rule-row').count() === 1, 'filter resets virtual scroll')
  assert.equal(await page.getByTestId('rule-row').getAttribute('data-rule-index'), '1399')
  assert.equal(await table.evaluate(element => element.scrollTop), 0)
  await page.getByRole('searchbox').fill('')
  await page.setViewportSize({ width: 390, height: 844 })
  await table.evaluate(element => { element.scrollTop = element.scrollHeight })
  await poll(async () => await page.locator('[data-rule-index="1399"]').count() === 1, 'mobile variable heights reach final rule')
  await page.locator('[data-rule-index="1399"]').getByRole('button').click()
  await page.getByRole('region', { name: 'Rule 1,400 details', exact: true }).waitFor()
  assert(await page.getByTestId('rule-row').count() < 45)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile viewport does not overflow')
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log('PASS: 1,400 variable-height rules, beyond row 500, expanded/focused row pinning, final row, filtering and mobile resizing')

  const focusPage = await context.newPage()
  focusPage.on('pageerror', error => errors.push(error.message))
  let socket
  const connections = Array.from({ length: 600 }, (_, index) => ({ id: `focus-${index}`, start: '2026-11-13T00:00:00Z', upload: 0, download: (600 - index) * 100,
    metadata: { type: 'Tun', network: 'tcp', sourceIP: '192.168.1.2', destinationIP: '192.0.2.1', destinationPort: '443', host: `focus-${index}.test` },
    chains: ['DIRECT'], rule: 'MATCH', rulePayload: '',
  }))
  const send = () => socket.send(JSON.stringify({ connections, uploadTotal: 0, downloadTotal: 60000 }))
  await focusPage.routeWebSocket(/\/connections(?:\?|$)/, stream => { socket = stream; send() })
  await focusPage.goto(`${base}#/connections?hostname=127.0.0.1&port=${apiPort}&http=true&secret=test`)
  const focusTable = focusPage.getByTestId('connections-table')
  const focusRow = focusPage.locator('[data-connection-key="focus-0"]')
  await focusRow.waitFor()
  await focusRow.getByRole('button').first().click()
  await focusPage.getByTestId('connection-details').waitFor()
  for (const connection of connections) if (connection.id !== 'focus-0') connection.download += 1_000_000
  send()
  await poll(async () => await focusRow.getAttribute('aria-rowindex') === '601', 'live sorting moves the selected row beyond the window')
  assert(await focusPage.getByTestId('active-connection-row').count() < 50, 'dialog trigger pinning keeps a bounded window')
  await focusPage.keyboard.press('Escape')
  await poll(async () => focusRow.getByRole('button').first().evaluate(element => element === document.activeElement), 'dialog returns focus to its pinned trigger')
  await focusTable.evaluate(element => { element.scrollTop = 0 })
  assert(await focusRow.getByRole('button').first().evaluate(element => element === document.activeElement), 'scrolling keeps the focused connection mounted')
  assert.deepEqual(errors, [], 'no browser runtime errors after live sorting')
  console.log('PASS: 600 live connections retain dialog trigger and keyboard focus across reordering and scrolling')
} finally {
  await browser?.close()
  for (const child of children.reverse()) child.kill()
}
