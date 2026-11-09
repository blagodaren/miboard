// Isolated API fixtures. Set MIBOARD_RULES_DNS_DEV=1 to start a separate Vite server without a build.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { stubAppUpdates } from './app-update-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const screenshots = await mkdtemp(path.join(os.tmpdir(), 'miboard-rules-dns-'))
const children = [], errors = [], patches = [], queries = []
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
const makeRule = (index, payload, hits) => ({ index, type: 'DomainSuffix', payload, proxy: 'Select', extra: {
  disabled: false, hitCount: hits, missCount: 40, hitAt: '0001-01-01T00:00:00Z', missAt: '2026-11-10T05:00:00Z',
} })
const fixture = () => [makeRule(0, 'first.test', 1), makeRule(17, 'second.test', 100), makeRule(99, 'third.test', 10)]

try {
  const apiPort = await port(), origin = `http://127.0.0.1:${apiPort}`
  const alive = child([path.join(root, 'mock/server.js')], { PORT: String(apiPort), SECRET: 'test' })
  await poll(async () => { alive(); try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false } }, 'mock starts')
  let base = `${origin}/ui/`
  if (process.env.MIBOARD_RULES_DNS_DEV === '1') {
    const devPort = await port()
    const live = child([path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'])
    base = `http://127.0.0.1:${devPort}/`
    await poll(async () => { live(); try { return (await fetch(base)).ok } catch { return false } }, 'isolated Vite starts')
  }
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'Install a supported Playwright browser')
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
  await stubAppUpdates(context)
  await context.addInitScript(() => localStorage.setItem('miboard.locale', localStorage.getItem('miboard.locale') || 'en'))
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket(/\/connections(?:\?|$)/, socket => socket.send(JSON.stringify({ connections: [], downloadTotal: 0, uploadTotal: 0 })))
  let rules = fixture(), getCount = 0, patchMode = 'apply', failReads = false
  await page.route(`${origin}/rules`, route => {
    getCount++
    return route.fulfill(failReads ? { status: 500, json: { message: 'fixture read error' } } : { json: { rules } })
  })
  await page.route(`${origin}/rules/disable`, async route => {
    assert.equal(route.request().method(), 'PATCH')
    assert.equal(route.request().headers().authorization, 'Bearer test')
    const body = route.request().postDataJSON()
    patches.push(body)
    if (patchMode === 'error') return route.fulfill({ status: 500, json: { message: 'fixture patch error' } })
    if (patchMode !== 'ignore') for (const [index, disabled] of Object.entries(body)) rules.find(rule => rule.index === Number(index)).extra.disabled = disabled
    if (patchMode === 'lost') failReads = true
    await route.fulfill({ status: 204 })
  })
  const open = route => page.goto(`${base}#/${route}?hostname=127.0.0.1&port=${apiPort}&http=true&secret=test`)
  await open('rules')
  await page.locator('[data-testid="rule-row"]').first().waitFor()
  await page.getByTestId('rule-sort').selectOption('hits')
  assert.equal(await page.getByTestId('rule-row').first().getAttribute('data-rule-index'), '17')
  await page.getByRole('searchbox').fill('first.test')
  await page.getByRole('button', { name: 'Expand rule 1', exact: true }).click()
  const detail = page.getByRole('region', { name: 'Rule 1 details', exact: true })
  assert.equal(await detail.getByText('Last match', { exact: true }).locator('..').locator('dd').innerText(), '—')
  await page.getByTestId('rule-toggle').click()
  await poll(async () => await page.getByTestId('rule-row').getAttribute('data-rule-disabled') === 'true', 'server confirms disable')
  assert.deepEqual(patches, [{ 0: true }], 'uses server zero, never filtered/sorted index')
  assert(getCount >= 3, 'reads before and after mutation')
  await page.getByTestId('rule-toggle').click()
  await poll(async () => await page.getByTestId('rule-row').getAttribute('data-rule-disabled') === 'false', 'server confirms re-enable')
  assert.deepEqual(patches.at(-1), { 0: false })
  console.log('PASS: rule counters, unset time, sorting/filtering preserve index zero, confirmed disable/enable')

  patchMode = 'ignore'
  await page.getByTestId('rule-toggle').click()
  await page.getByRole('alert').filter({ hasText: 'did not confirm' }).waitFor()
  assert.equal(await page.getByTestId('rule-row').getAttribute('data-rule-disabled'), 'false')
  patchMode = 'error'
  const readsBefore = getCount
  await page.getByTestId('rule-toggle').click()
  await page.getByRole('alert').filter({ hasText: 'fixture patch error' }).waitFor()
  await poll(() => getCount >= readsBefore + 2, 'error refresh')
  const patchesBefore = patches.length
  rules[0] = makeRule(0, 'reloaded-config.test', 3)
  await page.getByTestId('rule-toggle').click()
  await page.getByRole('alert').filter({ hasText: 'configuration changed' }).waitFor()
  assert.equal(patches.length, patchesBefore, 'preflight reload cannot disable the new rule occupying index zero')
  await page.getByRole('searchbox').fill('reloaded-config.test')
  patchMode = 'lost'
  await page.getByTestId('rule-toggle').click()
  await page.getByRole('status').filter({ hasText: 'last confirmed snapshot' }).waitFor()
  assert(await page.getByTestId('rule-toggle').isDisabled())
  failReads = false
  await page.getByTestId('rules-refresh').click()
  await poll(async () => await page.getByTestId('rule-row').getAttribute('data-rule-disabled') === 'true', 'manual refresh recovers authoritative state')
  console.log('PASS: ignored PATCH, error refresh, changed-config guard and uncertain-state recovery')

  rules = [{ type: 'Match', payload: '', proxy: 'DIRECT' }]
  await page.getByTestId('rules-refresh').click()
  await poll(async () => await page.getByTestId('rule-sort').count() === 0, 'legacy core without extras')
  assert.equal(await page.getByTestId('rule-toggle').count(), 0)
  assert(await page.getByText('This core does not report rule check statistics.', { exact: true }).first().isVisible())
  console.log('PASS: older cores remain readable without statistics or unsafe controls')

  rules = fixture()
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => localStorage.setItem('miboard.theme', theme), theme)
    await page.reload()
    await page.getByRole('button', { name: 'Expand rule 1', exact: true }).click()
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1100 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `rules ${theme} ${width} overflow`)
      await page.screenshot({ path: path.join(screenshots, `rules-${theme}-${width}.png`), fullPage: true })
    }
  }

  await page.route(`${origin}/dns/query?*`, route => {
    const url = new URL(route.request().url()), name = url.searchParams.get('name'), type = url.searchParams.get('type')
    queries.push({ name, type })
    const codes = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, CAA: 257 }
    return route.fulfill({ json: {
      Status: name === 'missing.test' ? 3 : 0, Question: [{ Name: `${name}.`, Qtype: codes[type], Qclass: 1 }],
      Answer: name === 'missing.test' ? [] : [{ name, type: codes[type], TTL: 0, data: `ANSWER-${type}` }],
      Authority: [{ name: 'test.', type: 6, TTL: 60, data: 'AUTHORITY-SOA' }],
      Additional: [{ name: 'ns.test.', type: 1, TTL: 60, data: '192.0.2.53' }], TC: false, RD: true, RA: true, AD: false, CD: false,
    } })
  })
  await open('analysis')
  await page.getByRole('button', { name: 'Diagnose domain', exact: true }).click()
  const panel = page.locator('#domain-diagnostics'), input = panel.locator('#diagnostic-domain')
  const submit = () => panel.getByRole('button', { name: 'Check', exact: true }).click()
  const ready = () => panel.getByText('DNS check finished', { exact: true }).waitFor()
  await input.fill('https://Example.com/path?secret=private')
  await submit(); await ready()
  assert.deepEqual(queries.slice(-2), [{ name: 'example.com', type: 'A' }, { name: 'example.com', type: 'AAAA' }])
  for (const type of ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'PTR', 'CAA']) {
    await panel.getByTestId('dns-query-type').selectOption(type)
    await input.fill(type === 'PTR' ? '2001:db8::1' : type === 'TXT' ? '_dmarc.example.com' : 'example.com')
    await submit(); await ready()
    assert.equal(queries.at(-1).type, type)
    assert(await panel.getByText(`ANSWER-${type}`, { exact: true }).isVisible())
    assert(await panel.getByTestId('dns-question').isVisible())
    assert(await panel.getByTestId('dns-section-Authority').isVisible())
    assert(await panel.getByTestId('dns-section-Additional').isVisible())
    assert.match(await panel.getByTestId('dns-flags').innerText(), /AD\s*no/)
    if (type === 'PTR') assert.equal(queries.at(-1).name, '20010db8000000000000000000000001'.split('').reverse().join('.') + '.ip6.arpa')
  }
  await input.fill('missing.test'); await submit(); await ready()
  assert(await panel.getByText('Domain not found (NXDOMAIN)', { exact: true }).isVisible())
  assert(await panel.getByTestId('dns-section-Authority').isVisible(), 'negative answers retain Authority')
  await panel.getByTestId('dns-query-type').selectOption('PTR')
  await input.fill('[::1]:80')
  const queriesBefore = queries.length
  await submit()
  await panel.getByRole('alert').waitFor()
  assert.equal(queries.length, queriesBefore)
  console.log('PASS: all DNS types, Question/Authority/Additional/flags, PTR conversion and invalid inputs')

  for (const locale of ['en', 'ru']) for (const theme of ['light', 'dark']) {
    await page.evaluate(({ locale, theme }) => { localStorage.setItem('miboard.locale', locale); localStorage.setItem('miboard.theme', theme) }, { locale, theme })
    await page.reload()
    await page.getByRole('button', { name: locale === 'en' ? 'Diagnose domain' : 'Диагностика домена', exact: true }).click()
    await input.fill('example.com')
    await panel.getByTestId('dns-query-type').selectOption('MX')
    await panel.getByRole('button', { name: locale === 'en' ? 'Check' : 'Проверить', exact: true }).click()
    await panel.getByTestId('dns-section-Answer').waitFor()
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1100 })
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${locale} ${theme} ${width} overflow`)
      await page.screenshot({ path: path.join(screenshots, `dns-${locale}-${theme}-${width}.png`), fullPage: true })
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`PASS: RU/EN, light/dark, 320/1440px. Screenshots: ${screenshots}`)
  await context.close()
} finally {
  await browser?.close()
  for (const process_ of children.reverse()) if (process_.exitCode === null) { const stopped = once(process_, 'exit'); process_.kill(); await stopped }
}
