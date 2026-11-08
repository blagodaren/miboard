import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.proxy-selection-check')
const base = process.env.MIBOARD_PROXY_SELECTION_URL
const errors = []
const mocks = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const selectedNode = 'Chosen / node & 東京'
const videoGroup = 'Video / Europe & Asia'
let browser

async function poll(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout
  do { if (await check()) return; await delay(40) } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startMock() {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  mocks.push(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await poll(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok } catch { return false }
  }, 'isolated selection mock startup')
  return { origin, port }
}

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) } catch {}
  }
  throw new Error('No Chrome/Edge available')
}

const leaf = name => ({ name, type: 'Vless', history: [] })
const group = (name, all, now = all[0], extra = {}) => ({ name, type: 'Selector', all, now, history: [], ...extra })
function fixture() {
  return {
    GLOBAL: group('GLOBAL', ['Select', videoGroup, 'Closed', 'Filtered out', 'Hidden', 'Fallback', 'Missing', 'Already', 'Automatic', 'Failure', selectedNode]),
    Select: group('Select', ['Other', selectedNode], selectedNode),
    [videoGroup]: group(videoGroup, ['Other', selectedNode]),
    Closed: group('Closed', ['Other', selectedNode]),
    'Filtered out': group('Filtered out', ['Leaf', selectedNode]),
    Hidden: group('Hidden', ['Other', selectedNode], 'Other', { hidden: true }),
    Fallback: group('Fallback', ['Other', selectedNode], 'Other', { type: 'Fallback' }),
    Missing: group('Missing', ['Other', 'Leaf']),
    Already: group('Already', ['Other', selectedNode], selectedNode),
    Automatic: group('Automatic', ['Other', selectedNode], 'Other', { type: 'URLTest' }),
    Failure: group('Failure', ['Other', selectedNode]),
    Other: leaf('Other'), Leaf: leaf('Leaf'), [selectedNode]: leaf(selectedNode),
  }
}

function nestedFixture() {
  return {
    GLOBAL: group('GLOBAL', ['Select', videoGroup, 'Nested', 'Cycle target', 'Leaf only']),
    Select: group('Select', ['Other', 'Nested'], 'Nested'),
    [videoGroup]: group(videoGroup, ['Other', 'Nested']),
    Nested: group('Nested', ['Leaf', 'Cycle target'], 'Cycle target'),
    'Cycle target': group('Cycle target', ['Leaf', 'Nested']),
    'Leaf only': group('Leaf only', ['Leaf', 'Other']),
    Leaf: leaf('Leaf'), Other: leaf('Other'),
  }
}

const applyButton = (page, name = 'Select') => page.locator('[data-testid="proxy-selection-apply"]').and(page.locator(`[data-group="${name}"]`))
const notice = page => page.getByTestId('proxy-selection-notice')
const card = (page, name, locale = 'en') => page.locator('section').filter({ has: page.getByRole('button', { name: locale === 'ru' ? `Проверить задержку группы ${name}` : `Test latency for ${name}`, exact: true }) })
const sorting = page => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('miboard.proxy-sort.v1'))))
async function isSelected(page, name, node, locale = 'en') {
  return card(page, name, locale).locator('[data-proxy-node]').evaluateAll((elements, node) => elements.some(element => element.dataset.proxyNode === node && element.querySelector('button[aria-pressed="true"]')), node)
}

async function selectionStyles(page, name, locale = 'en') {
  return card(page, name, locale).locator('[data-proxy-node]').evaluateAll(elements => {
    const probe = document.createElement('span')
    document.body.append(probe)
    const color = (property, token) => {
      probe.style[property] = `var(${token})`
      return getComputedStyle(probe)[property]
    }
    const expected = {
      selectedBackground: color('backgroundColor', '--selected'),
      selectedBorder: color('borderTopColor', '--selected-border'),
      idleBackground: color('backgroundColor', '--card'),
      idleBorder: color('borderTopColor', '--line'),
    }
    probe.remove()
    return {
      expected,
      nodes: elements.map(element => {
        const button = element.querySelector('button[aria-pressed]')
        const style = getComputedStyle(button)
        return { name: element.dataset.proxyNode, selected: button.getAttribute('aria-pressed') === 'true', background: style.backgroundColor, border: style.borderTopColor }
      }),
    }
  })
}

async function assertSelectionStyle(page, group, locale = 'en') {
  // ARIA and checkmarks change immediately; the color transition takes 150ms.
  // Verify the final rendered colors before taking proof screenshots.
  let last
  await poll(async () => {
    const source = await selectionStyles(page, 'Select', locale)
    const target = await selectionStyles(page, group, locale)
    const selected = target.nodes.find(node => node.selected)
    const idle = target.nodes.find(node => !node.selected)
    const sourceSelected = source.nodes.find(node => node.selected)
    last = { source, target }
    return Boolean(selected && idle && sourceSelected
      && selected.background === target.expected.selectedBackground
      && selected.border === target.expected.selectedBorder
      && sourceSelected.background === source.expected.selectedBackground
      && sourceSelected.border === source.expected.selectedBorder
      && idle.background === target.expected.idleBackground
      && idle.border === target.expected.idleBorder)
  }, `${group}: selected and idle backgrounds/borders match the shared palette`).catch(error => {
    throw new Error(`${error.message}\nRendered selection colors: ${JSON.stringify(last)}`, { cause: error })
  })
  assert.notEqual(last.target.nodes.find(node => node.selected).background, last.target.nodes.find(node => !node.selected).background)
}

async function noticePaint(page) {
  return notice(page).evaluate(element => {
    const style = getComputedStyle(element)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const painter = canvas.getContext('2d')
    painter.fillStyle = style.backgroundColor
    painter.fillRect(0, 0, 1, 1)
    return { alpha: painter.getImageData(0, 0, 1, 1).data[3] / 255, opacity: Number(style.opacity) }
  })
}

async function session(server, { locale = 'en', theme = 'light', width = 1440, proxies = fixture(), failed = [], gate, seedSort = true, clock = false, hasTouch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1050 }, colorScheme: theme, reducedMotion: 'reduce', hasTouch })
  await context.addInitScript(({ locale, theme, origin, seedSort }) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.setItem('miboard.theme', theme)
    if (seedSort) {
      localStorage.setItem('miboard.proxy-sort.v1' + JSON.stringify([origin, 'Select']), JSON.stringify({ key: 'name', direction: 'desc' }))
      localStorage.setItem('miboard.proxy-sort.v1' + JSON.stringify([origin, 'Closed']), JSON.stringify({ key: 'latency', direction: 'asc' }))
    }
  }, { locale, theme, origin: server.origin, seedSort })
  const page = await context.newPage()
  if (clock) {
    const start = new Date('2026-11-09T00:00:00Z')
    await page.clock.install({ time: start })
    await page.clock.pauseAt(start)
  }
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  const requests = []
  const aborted = new Set()
  page.on('requestfailed', request => { if (request.method() === 'PUT') aborted.add(request) })
  await page.route(`${server.origin}/proxies`, route => route.fulfill({ json: { proxies } }))
  await page.route(`${server.origin}/providers/proxies`, route => route.fulfill({ json: { providers: {} } }))
  await page.route(`${server.origin}/proxies/**`, async route => {
    const request = route.request()
    if (request.method() !== 'PUT') return route.continue()
    const pathname = new URL(request.url()).pathname
    const name = decodeURIComponent(pathname.slice('/proxies/'.length))
    const body = request.postDataJSON()
    requests.push({ name, body, pathname, method: request.method(), authorization: request.headers().authorization })
    if (gate) await gate
    if (aborted.has(request)) return
    if (failed.includes(name)) return route.fulfill({ status: 503, json: { message: 'selection mock failure' } })
    assert.ok(proxies[name]?.all?.includes(body.name), `No request for an unavailable member: ${name}`)
    proxies[name].now = body.name
    try { await route.fulfill({ status: 204, body: '' }) } catch (error) { if (!aborted.has(request)) throw error }
  })
  const entry = new URL(base ?? `${server.origin}/ui/`)
  entry.hash = `/proxies?hostname=127.0.0.1&port=${server.port}&protocol=http&secret=test`
  await page.goto(entry.href)
  await applyButton(page).waitFor()
  return { context, page, requests, proxies, aborted, entry }
}

try {
  await mkdir(out, { recursive: true })
  const server = await startMock()
  browser = await launch()

  {
    const state = await session(server, { failed: ['Failure'] })
    const { page, requests, proxies } = state
    const originalSort = await sorting(page)
    await page.getByRole('searchbox').fill('Other')
    assert.equal(await card(page, 'Filtered out').count(), 0, 'Search excludes a target group from the visible list')
    await applyButton(page).click()
    await notice(page).waitFor()
    await poll(async () => await applyButton(page).isEnabled(), 'bulk selection finished')
    const changed = ['GLOBAL', videoGroup, 'Closed', 'Filtered out', 'Hidden', 'Fallback']
    assert.deepEqual(requests.map(item => item.name).sort(), [...changed, 'Failure'].sort())
    assert.ok(requests.every(item => item.method === 'PUT' && item.body.name === selectedNode && item.authorization === 'Bearer test'))
    assert.equal(requests.find(item => item.name === videoGroup).pathname, '/proxies/' + encodeURIComponent(videoGroup), 'Group names are encoded as one URL segment')
    for (const name of changed) assert.equal(proxies[name].now, selectedNode, name)
    for (const name of ['Missing', 'Automatic', 'Failure']) assert.equal(proxies[name].now, 'Other', `${name} keeps its previous selection`)
    assert.equal(proxies.Select.now, selectedNode)
    const text = await notice(page).innerText()
    for (const name of [selectedNode, 'Missing', 'Automatic', 'Failure', 'selection mock failure']) assert.ok(text.includes(name), `Notice identifies ${name}`)
    assert.deepEqual(await sorting(page), originalSort, 'Applying a node must not overwrite group sorting')
    await page.getByRole('searchbox').fill('')
    await poll(() => isSelected(page, videoGroup, selectedNode), 'another group shows the selected node')
    await assertSelectionStyle(page, videoGroup)
    await card(page, 'Closed').locator('button[aria-expanded]').click()
    await poll(() => isSelected(page, 'Closed', selectedNode), 'collapsed group shows its applied node when opened')
    await page.screenshot({ path: path.join(out, 'selection-partial-light-1440.png'), fullPage: true })
    await notice(page).getByRole('button').click()
    await notice(page).waitFor({ state: 'hidden' })
    await state.context.close()
    console.log('PASS: exact node applies to open/collapsed/search-hidden/hidden/GLOBAL/Fallback groups; missing/automatic/failed selections and sorting stay unchanged')
  }

  {
    const state = await session(server, { proxies: nestedFixture() })
    await applyButton(state.page).click()
    await notice(state.page).waitFor()
    assert.ok(state.requests.some(item => item.name === videoGroup && item.body.name === 'Nested'), 'The selected group name is copied exactly, without resolving its leaf')
    assert.ok(!state.requests.some(item => item.name === 'Cycle target'), 'Applying a group must not create a routing cycle')
    assert.ok(!state.requests.some(item => item.name === 'Leaf only'), 'A resolved leaf is not a substitute for the chosen member')
    for (const name of ['Cycle target', 'Leaf only']) assert.ok((await notice(state.page).innerText()).includes(name))
    await state.context.close()
    console.log('PASS: nested group selection uses the exact member name and skips routing cycles')
  }

  {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const state = await session(server, { gate })
    const initial = (await applyButton(state.page).textContent()).trim()
    await applyButton(state.page).click()
    await poll(() => state.requests.length > 0, 'bulk request starts')
    assert.equal(await applyButton(state.page).isDisabled(), true, 'Bulk action is disabled while requests run')
    const bounds = await applyButton(state.page).boundingBox()
    await state.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await state.page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    release()
    await notice(state.page).waitFor()
    await poll(async () => await applyButton(state.page).isEnabled(), 'busy state cleared')
    assert.equal(new Set(state.requests.map(item => item.name)).size, state.requests.length, 'Repeated clicks do not send duplicate group writes')
    await poll(async () => (await applyButton(state.page).textContent()).trim() === initial, 'button confirmation resets', 5000)
    await state.context.close()
    console.log('PASS: busy protection prevents duplicate writes and completion feedback resets')
  }

  {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const state = await session(server, { gate })
    await applyButton(state.page).click()
    await poll(() => state.requests.length > 0, 'pending request before navigation')
    const started = state.requests.length
    await state.page.getByRole('link', { name: 'Overview', exact: true }).click()
    await state.page.getByRole('heading', { name: 'Overview', exact: true }).waitFor()
    await poll(() => state.aborted.size > 0, 'leaving cancels pending requests')
    release()
    await delay(200)
    assert.equal(state.requests.length, started, 'Leaving the page does not start queued requests')
    await state.page.getByRole('link', { name: 'Proxies', exact: true }).click()
    await applyButton(state.page).waitFor()
    assert.equal(await notice(state.page).count(), 0, 'Late results do not populate the new page instance')
    await state.context.close()
    console.log('PASS: leaving cancels pending work, stops the queue and drops stale feedback')
  }

  {
    const state = await session(server, { clock: true })
    const { page } = state
    await page.mouse.move(0, 0)
    await applyButton(page).click()
    await notice(page).waitFor()
    const idlePaint = await noticePaint(page)
    assert.equal(idlePaint.alpha, 1, 'Notification uses an opaque surface so underlying cards do not reduce readability')
    assert.equal(idlePaint.opacity, 1, 'Text and controls remain fully opaque')
    await page.clock.fastForward(7900)
    assert.equal(await notice(page).count(), 1, 'Notification stays visible for nearly eight seconds')
    await page.clock.fastForward(200)
    await notice(page).waitFor({ state: 'hidden' })

    await applyButton(page).click()
    await notice(page).waitFor()
    await page.clock.fastForward(3000)
    await notice(page).hover()
    assert.equal((await noticePaint(page)).alpha, 1, 'Hovered notification keeps its opaque surface')
    await page.clock.fastForward(12000)
    assert.equal(await notice(page).count(), 1, 'Hover pauses the lifetime')
    await page.mouse.move(0, 0)
    await page.clock.fastForward(4900)
    assert.equal(await notice(page).count(), 1, 'Leaving hover resumes the remaining lifetime')
    await page.clock.fastForward(200)
    await notice(page).waitFor({ state: 'hidden' })

    await applyButton(page).click()
    await notice(page).waitFor()
    await page.clock.fastForward(2000)
    await notice(page).getByRole('button').focus()
    assert.equal((await noticePaint(page)).alpha, 1, 'Keyboard focus keeps the surface opaque')
    await page.clock.fastForward(12000)
    assert.equal(await notice(page).count(), 1, 'Keyboard focus pauses the lifetime')
    await applyButton(page).focus()
    await page.clock.fastForward(5900)
    assert.equal(await notice(page).count(), 1, 'Leaving focus resumes the remaining lifetime')
    await page.clock.fastForward(200)
    await notice(page).waitFor({ state: 'hidden' })

    await applyButton(page).click()
    await notice(page).waitFor()
    await page.clock.fastForward(6000)
    await applyButton(page).click()
    await notice(page).waitFor()
    await page.clock.fastForward(2100)
    assert.equal(await notice(page).count(), 1, 'A replacement is not closed by the old deadline')
    await page.clock.fastForward(5800)
    assert.equal(await notice(page).count(), 1, 'A replacement receives a fresh eight-second lifetime')
    await page.clock.fastForward(200)
    await notice(page).waitFor({ state: 'hidden' })

    await applyButton(page).click()
    await notice(page).waitFor()
    await notice(page).getByRole('button').click()
    await notice(page).waitFor({ state: 'hidden' })
    await page.clock.fastForward(12000)
    await state.context.close()
    console.log('PASS: opaque notification expires after eight seconds; hover/focus pause, replacement lifetime and manual close work')
  }

  for (const theme of ['light', 'dark']) {
    const state = await session(server, { locale: 'ru', width: 375, theme, failed: ['Failure'], hasTouch: true })
    await applyButton(state.page).click()
    await notice(state.page).waitFor()
    await assertSelectionStyle(state.page, videoGroup, 'ru')
    assert.match(await notice(state.page).innerText(), /Нода|нода/)
    assert.ok((await notice(state.page).innerText()).includes('Missing'))
    assert.equal((await noticePaint(state.page)).alpha, 1, 'Touch notification remains opaque without hover')
    assert.ok(await state.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: 375px has no horizontal overflow`)
    const bounds = await notice(state.page).boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 376, `${theme}: corner notice fits the mobile viewport`)
    await state.page.screenshot({ path: path.join(out, `selection-partial-ru-${theme}-375.png`), fullPage: false })
    await state.context.close()
  }
  assert.deepEqual(errors, [], 'No browser runtime errors')
  console.log(`PASS: selected backgrounds/borders match source and shared tokens; Russian mobile notices fit both themes; screenshots ${out}`)
} catch (error) {
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {})
  }
  throw error
} finally {
  await browser?.close()
  await Promise.all(mocks.map(async child => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000).unref())])
  }))
}
