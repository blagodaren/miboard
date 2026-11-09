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
const screenshotDir = await mkdtemp(path.join(os.tmpdir(), 'miboard-rules-'))
const errors = []
let browser
let mock
let mockOutput = ''
let base
let origin

async function poll(check, description, timeout = 10_000) {
  const deadline = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${description}`)
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function launchBrowser() {
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch({ headless: true, ...options })
    } catch {
      // Installed Chrome/Edge provide a fallback on Windows.
    }
  }
  throw new Error('No browser available. Run: npx playwright install chromium')
}

async function openRules(intercept, controlledConnections, prepare) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await stubAppUpdates(context)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.message))
  if (intercept) await page.route(`${origin}/providers/rules`, intercept)
  if (prepare) await prepare(page)
  let connectionsSocket
  const sendConnections = (connections) => connectionsSocket.send(JSON.stringify({
    connections,
    downloadTotal: connections.reduce((sum, connection) => sum + connection.download, 0),
    uploadTotal: connections.reduce((sum, connection) => sum + connection.upload, 0),
  }))
  if (controlledConnections) await page.routeWebSocket((url) => url.pathname === '/connections', (socket) => {
    connectionsSocket = socket
    sendConnections(controlledConnections)
  })
  await page.goto(`${base}#/rules?secret=test`)
  await page.getByRole('heading', { name: 'Rules', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Expand rule set ads', exact: true }).waitFor()
  return { context, page, sendConnections }
}

const expand = (page, name) => page.getByRole('button', { name: `Expand rule set ${name}`, exact: true })
const collapse = (page, name) => page.getByRole('button', { name: `Collapse rule set ${name}`, exact: true })
const region = (page, name) => page.getByRole('region', { name: `Rule set ${name}`, exact: true })
const providersPanel = (page) => page.getByTestId('rule-providers')
const providerSearch = (page) => page.getByRole('searchbox', { name: 'Find a rule provider', exact: true })

async function openProviders(page) {
  await page.getByRole('tab', { name: /^Rule providers(?:\s|$)/ }).click()
  await providersPanel(page).waitFor()
  return providersPanel(page)
}

async function showInline(page, name) {
  const details = region(page, name)
  const show = details.getByRole('button', { name: `Show rules in ${name}`, exact: true })
  if (await show.isVisible()) await show.click()
  return details
}

async function openSet(page, name) {
  await openProviders(page)
  await providerSearch(page).fill(name)
  const details = region(page, name)
  await details.waitFor()
  return details
}

async function setLanguage(page, locale) {
  await page.evaluate(() => { location.hash = '/settings' })
  await page.getByRole('combobox', { name: /^(Language|Язык)$/ }).selectOption(locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
  await page.evaluate(() => { location.hash = '/rules' })
  await page.getByRole('heading', { name: locale === 'ru' ? 'Правила' : 'Rules', exact: true }).waitFor()
}

async function checkColumns(page, width, columns, state) {
  await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
  await page.waitForFunction((expected) => {
    const table = document.querySelector('table')
    const headers = [...table.querySelectorAll('thead th')].filter((cell) => cell.getBoundingClientRect().width > 0)
    return headers.length === expected && table.querySelector('tbody tr:not([hidden]) td[colspan]')?.colSpan === expected
  }, columns)
  const geometry = await page.locator('table').evaluate((table) => {
    const bounds = table.getBoundingClientRect()
    const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.width > 0)
    return {
      tableRight: bounds.right,
      tableWidth: bounds.width,
      destinationRight: headers.at(-1).right,
      conditionWidth: headers.at(-2).width,
    }
  })
  assert(Math.abs(geometry.tableRight - geometry.destinationRight) < 4, `${state}/${width}: ghost columns leave space after Destination`)
  if (width < 768) assert(geometry.conditionWidth / geometry.tableWidth > 0.4, `${state}/${width}: Condition has less than 40% of the table`)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${state}/${width}: Rules page overflows the viewport`)
}

async function assertGraphLinksAvoidCards(dashboard) {
  const geometry = await dashboard.evaluate((panel) => {
    // SVG paths and inline card positions share graph-local coordinates, independent of zoom.
    const cards = [...panel.querySelectorAll('.chain-node[data-node-id]')].map((node) => ({
      id: node.dataset.nodeId,
      name: node.querySelector('.node-name strong')?.textContent.trim() || node.dataset.nodeId,
      x: Number.parseFloat(node.style.left),
      y: Number.parseFloat(node.style.top),
      width: Number.parseFloat(node.style.width),
      height: Number.parseFloat(node.style.height),
    }))
    for (const card of cards) {
      if (![card.x, card.y, card.width, card.height].every(Number.isFinite) || card.width <= 0 || card.height <= 0) {
        throw new Error(`Invalid graph-local card geometry: ${card.name}`)
      }
    }
    const edges = [...panel.querySelectorAll('svg .chain-edge[data-source][data-target]')]
    const intersections = []
    let samples = 0
    for (const edge of edges) {
      // The first path is the connection; the second is its arrowhead.
      const path = edge.querySelector('path')
      if (!(path instanceof SVGPathElement)) throw new Error('Graph edge is missing its connection path')
      const length = path.getTotalLength()
      if (!Number.isFinite(length) || length <= 0) throw new Error('Graph edge has no measurable connection path')
      const source = edge.dataset.source
      const target = edge.dataset.target
      const otherCards = cards.filter((card) => card.id !== source && card.id !== target)
      for (let step = 0; step <= Math.ceil(length / 8); step++) {
        const point = path.getPointAtLength(Math.min(step * 8, length))
        samples++
        const hit = otherCards.find((card) => point.x > card.x && point.x < card.x + card.width
          && point.y > card.y && point.y < card.y + card.height)
        if (hit) {
          intersections.push({
            source: cards.find((card) => card.id === source)?.name || source,
            target: cards.find((card) => card.id === target)?.name || target,
            card: hit.name,
            x: Math.round(point.x),
            y: Math.round(point.y),
          })
          break
        }
      }
    }
    return { cards: cards.length, edges: edges.length, samples, intersections }
  })
  assert(geometry.cards > 0 && geometry.edges > 0 && geometry.samples > 0, 'The graph collision check must sample rendered connection paths')
  assert.deepEqual(geometry.intersections, [], 'Connection paths must avoid every card except their source and target')
}

async function checkAnalytics() {
  const MB = 1024 ** 2
  const fixtureConnection = (id, host, rulePayload, policy, download, upload = 0) => ({
    id, rule: 'DomainSuffix', rulePayload, chains: policy === 'YouTube' ? ['Exit-A', policy] : ['Exit-B', 'Route-B', policy],
    download, upload, start: '2026-11-08T09:00:00Z',
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP: '1.1.1.1', destinationPort: '443', host,
    },
  })
  const fixture = [
    fixtureConnection('video-1', 'video.googlevideo.com', 'googlevideo.com', 'YouTube', 8 * MB, MB),
    fixtureConnection('video-2', 'static.googlevideo.com', 'googlevideo.com', 'YouTube', 2 * MB),
    fixtureConnection('github-1', 'github.com', 'github.com', 'Прокси', 4 * MB),
  ]
  const test = await openRules(undefined, fixture)
  const page = test.page
  const dashboard = page.locator('.rules-analytics')
  const total = dashboard.locator('.donut-center strong')
  const graphNodes = (kind) => dashboard.locator(`.chain-node[data-node-id][data-kind="${kind}"]`)
  const graphNode = (kind, name) => graphNodes(kind).filter({ has: page.getByText(name, { exact: true }) })
  const graphEdges = dashboard.locator('svg .chain-edge[data-source][data-target]')
  const graphIds = () => dashboard.locator('.chain-node[data-node-id]').evaluateAll((nodes) => nodes.map((node) => node.dataset.nodeId).sort())
  const nodeIds = (nodes) => Promise.all(nodes.map((node) => node.getAttribute('data-node-id')))
  async function assertEdge(source, target, description) {
    const sourceId = await source.getAttribute('data-node-id')
    const targetId = await target.getAttribute('data-node-id')
    const edges = await graphEdges.evaluateAll((elements) => elements.map((element) => ({
      source: element.getAttribute('data-source'), target: element.getAttribute('data-target'),
    })))
    assert.equal(edges.filter((edge) => edge.source === sourceId && edge.target === targetId).length, 1, description)
  }
  async function assertGraphHighlight(expectedNodeIds, expectedEdgeCount, description) {
    const state = await dashboard.evaluate((panel) => {
      const emphasis = (element) => ({
        highlighted: element.dataset.highlighted === 'true',
        muted: element.dataset.muted === 'true',
        highlightClass: element.classList.contains('is-highlighted'),
        mutedClass: element.classList.contains('is-muted'),
      })
      return {
        nodes: [...panel.querySelectorAll('.chain-node[data-node-id]')].map((node) => ({
          id: node.dataset.nodeId, ...emphasis(node),
        })),
        edges: [...panel.querySelectorAll('svg .chain-edge[data-source][data-target]')].map((edge) => ({
          source: edge.dataset.source, target: edge.dataset.target, ...emphasis(edge),
        })),
      }
    })
    const expectedNodes = [...expectedNodeIds].sort()
    const active = expectedNodes.length > 0
    const edgeId = (edge) => JSON.stringify([edge.source, edge.target])
    // Expected routes come from the fixture, so a shared tail must not pull in another policy's rules.
    const expectedEdges = state.edges.filter((edge) => expectedNodes.includes(edge.source) && expectedNodes.includes(edge.target)).map(edgeId).sort()
    assert.equal(expectedEdges.length, expectedEdgeCount, `${description}: fixture route edges`)
    assert.deepEqual(state.nodes.filter((node) => node.highlighted).map((node) => node.id).sort(), expectedNodes, `${description}: highlighted nodes`)
    assert.deepEqual(state.nodes.filter((node) => node.muted).map((node) => node.id).sort(),
      active ? state.nodes.filter((node) => !expectedNodes.includes(node.id)).map((node) => node.id).sort() : [], `${description}: unrelated nodes fade only during emphasis`)
    assert.deepEqual(state.edges.filter((edge) => edge.highlighted).map(edgeId).sort(), expectedEdges, `${description}: highlighted route edges`)
    assert.deepEqual(state.edges.filter((edge) => edge.muted).map(edgeId).sort(),
      active ? state.edges.filter((edge) => !expectedEdges.includes(edgeId(edge))).map(edgeId).sort() : [], `${description}: unrelated edges fade only during emphasis`)
    assert(state.nodes.concat(state.edges).every((element) => element.highlighted === element.highlightClass && element.muted === element.mutedClass),
      `${description}: visible emphasis classes must match the reported state`)
  }
  await poll(async () => (await total.innerText()) === '15 MB', 'connection traffic in donut')
  assert.equal(await dashboard.locator('.donut circle[stroke-dasharray]').count(), 2, 'Distribution should include both matched rules')
  assert.equal(await dashboard.locator('.ranked-rule').count(), 2, 'Connections sharing a rule should share its traffic row')
  assert.equal(await dashboard.locator('.domain-row').count(), 2, 'Selected video rule should expose its two domains')
  assert.equal(await graphNodes('rule').count(), 2, 'Both rules should appear without enabling a separate view')
  assert.equal(await graphNodes('group').count(), 3, 'The graph should expose every distinct policy and intermediate proxy group')
  assert.equal(await graphNodes('outbound').count(), 2, 'The graph should expose both distinct exit nodes')
  assert.equal(await graphEdges.count(), 5, 'Both routing paths should include every directed hop')
  assert.equal(await dashboard.locator('.panorama-button').count(), 0, 'The redundant panorama toggle should be absent')
  await assertGraphLinksAvoidCards(dashboard)
  const initialGraphIds = await graphIds()

  await dashboard.locator('.pause-button').click()
  assert.equal(await dashboard.locator('.pause-button').getAttribute('aria-pressed'), 'true')
  const updated = [...fixture.map((connection, index) => index ? connection : { ...connection, download: 18 * MB }),
    fixtureConnection('github-2', 'api.github.com', 'github.com', 'Прокси', 0)]
  test.sendConnections(updated)
  await poll(async () => (await page.locator('.sidebar-link[href="#/connections"] .num').innerText()) === '4', 'new frame received while analytics is paused')
  assert.equal(await total.innerText(), '15 MB', 'Paused traffic must remain frozen while the shared stream updates')
  assert.equal(await dashboard.locator('.scope-count').innerText(), '3', 'Paused connection count must remain frozen')

  const github = dashboard.locator('.ranked-rule').filter({ has: page.locator('.rule-name', { hasText: /^github\.com$/ }) })
  await github.click()
  assert.equal(await github.getAttribute('aria-pressed'), 'true')
  assert.equal((await dashboard.locator('.domain-selection').innerText()).trim(), 'github.com', 'Selecting a rule updates domain chart context')
  assert.equal(await dashboard.locator('.domain-row').count(), 1)
  assert.equal(await dashboard.locator('.domain-name').innerText(), 'github.com')
  assert.deepEqual(await graphIds(), initialGraphIds, 'Selecting a rule should keep the complete merged graph visible')
  const githubRule = graphNode('rule', 'github.com')
  const githubPolicy = graphNode('group', 'Прокси')
  const githubIntermediate = graphNode('group', 'Route-B')
  const githubExit = graphNode('outbound', 'Exit-B')
  for (const node of [githubRule, githubPolicy, githubIntermediate, githubExit]) assert.equal(await node.count(), 1)
  assert(await dashboard.locator('.chain-node[data-node-id]').evaluateAll((nodes) => nodes.every((node) => node instanceof HTMLButtonElement)),
    'Every graph card should support native keyboard focus')
  await assertEdge(githubRule, githubPolicy, 'The rule should lead to its configured policy')
  await assertEdge(githubPolicy, githubIntermediate, 'The policy should lead to the intermediate group in routing order')
  await assertEdge(githubIntermediate, githubExit, 'The intermediate group should lead to the observed exit')
  const githubRouteIds = await nodeIds([githubRule, githubPolicy, githubIntermediate, githubExit])
  const videoRouteIds = await nodeIds([graphNode('rule', 'googlevideo.com'), graphNode('group', 'YouTube'), graphNode('outbound', 'Exit-A')])
  const graphHeader = dashboard.locator('.chain-header')
  await githubRule.hover()
  await assertGraphHighlight(githubRouteIds, 3, 'Hovering a rule reveals its complete routing path')
  await graphHeader.hover()
  await assertGraphHighlight([], 0, 'Leaving a card restores the unfiltered graph')
  await githubRule.focus()
  await assertGraphHighlight(githubRouteIds, 3, 'Keyboard focus reveals the same routing path')
  await graphNode('group', 'YouTube').hover()
  await assertGraphHighlight(videoRouteIds, 2, 'Pointer inspection temporarily takes precedence over another focused path')
  await graphHeader.hover()
  await assertGraphHighlight(githubRouteIds, 3, 'Leaving the hovered card restores the keyboard-focused path')
  await page.keyboard.press('Escape')
  assert(await githubRule.evaluate((node) => document.activeElement !== node), 'Escape should release graph card focus')
  await assertGraphHighlight([], 0, 'Escape restores the complete graph appearance')

  await githubRule.hover()
  await githubRule.focus()
  // Selecting a filter starts over the dropdown, so a replacement card cannot inherit the pointer.
  await dashboard.locator('.policy-filter select').hover()
  await dashboard.locator('.policy-filter select').selectOption('YouTube')
  assert.equal(await graphNodes('rule').count(), 1, 'The policy filter should narrow the rules in the merged graph')
  assert.equal(await graphNodes('group').count(), 1, 'The policy filter should remove unrelated proxy groups')
  assert.equal(await graphNode('group', 'YouTube').count(), 1)
  assert.equal(await graphNodes('outbound').count(), 1)
  assert.equal(await graphEdges.count(), 2)
  await assertGraphHighlight([], 0, 'Filtering away the focused card clears stale emphasis')
  await assertEdge(graphNode('rule', 'googlevideo.com'), graphNode('group', 'YouTube'), 'The filtered video rule should keep its policy edge')
  await assertEdge(graphNode('group', 'YouTube'), graphNode('outbound', 'Exit-A'), 'The filtered policy should keep its exit edge')
  await dashboard.locator('.policy-filter select').selectOption('')
  assert.deepEqual(await graphIds(), initialGraphIds, 'Clearing the policy filter should restore the complete merged graph')
  await assertGraphHighlight([], 0, 'Restoring a filtered card must not revive stale hover or focus')
  const initialTransform = await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform)
  await dashboard.getByRole('button', { name: 'Zoom in', exact: true }).click()
  assert.notEqual(await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform), initialTransform, 'Zoom in changes graph scale')
  await dashboard.getByRole('button', { name: 'Zoom out', exact: true }).click()
  assert.equal(await dashboard.locator('.chain-graph').evaluate((graph) => graph.style.transform), initialTransform, 'Zoom out restores the previous scale')
  await dashboard.getByRole('button', { name: 'Fit to view', exact: true }).click()

  await dashboard.locator('.pause-button').click()
  assert.equal(await dashboard.locator('.pause-button').getAttribute('aria-pressed'), 'false')
  await poll(async () => (await total.innerText()) === '25 MB', 'resume shows latest connection traffic')
  assert.equal(await dashboard.locator('.scope-count').innerText(), '4')
  test.sendConnections([])
  await poll(async () => (await dashboard.locator('.ranked-rule').count()) === 0, 'closed connections leave analytics')
  assert.equal(await total.innerText(), '0 B')
  assert.equal(await dashboard.locator('.chain-node[data-node-id]').count(), 0)
  assert.equal(await graphEdges.count(), 0)
  assert(await dashboard.getByRole('button', { name: 'Zoom in', exact: true }).isDisabled(), 'Empty graph disables zoom')
  test.sendConnections(fixture)
  await poll(async () => (await dashboard.locator('.ranked-rule').count()) === 2, 'analytics recovers after an empty frame')

  const manyRoutes = Array.from({ length: 15 }, (_, index) => ({
    ...fixtureConnection(`route-${index}`, `host-${index}.example.com`, `route-${index}.example.com`,
      index % 2 ? 'Policy B' : 'Policy A', (15 - index) * MB),
    chains: ['ExitShared', 'SharedSelect', index % 2 ? 'Policy B' : 'Policy A'],
  }))
  test.sendConnections(manyRoutes)
  await poll(async () => (await graphNodes('rule').count()) === 15, 'all rule nodes beyond the former twelve-route limit')
  assert.equal(await graphNodes('group').count(), 3, 'The two policies and shared selector should each have one graph node')
  assert.equal(await graphNode('group', 'SharedSelect').count(), 1, 'A selector shared by fifteen routes must not be duplicated')
  assert.equal(await graphNodes('outbound').count(), 1, 'A shared exit should have one graph node')
  assert.equal(await graphNode('outbound', 'ExitShared').count(), 1)
  assert.equal(await graphEdges.count(), 18, 'Shared group and exit links should be merged rather than repeated for every rule')
  const manyRuleIds = await graphNodes('rule').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')))
  const manyEdgeSources = await graphEdges.evaluateAll((edges) => edges.map((edge) => edge.getAttribute('data-source')))
  for (const ruleId of manyRuleIds) assert.equal(manyEdgeSources.filter((source) => source === ruleId).length, 1,
    'Every rule should retain its route into the merged proxy groups')
  await assertEdge(graphNode('group', 'Policy A'), graphNode('group', 'SharedSelect'), 'The first policy should connect to the shared selector')
  await assertEdge(graphNode('group', 'Policy B'), graphNode('group', 'SharedSelect'), 'The second policy should connect to the same selector')
  await assertEdge(graphNode('group', 'SharedSelect'), graphNode('outbound', 'ExitShared'), 'The shared selector should have one edge to the shared exit')
  await assertGraphLinksAvoidCards(dashboard)
  assert.equal(await dashboard.locator('.chain-footer .show-more').count(), 0, 'All routes should be rendered without a show-more control')
  assert.equal(await graphNode('rule', 'route-14.example.com').count(), 1, 'The final fixture rule should already be rendered')
  const bottomRuleIndex = await graphNodes('rule').evaluateAll((nodes) => nodes.reduce((last, node, index) =>
    node.getBoundingClientRect().bottom > nodes[last].getBoundingClientRect().bottom ? index : last, 0))
  const lastNode = graphNodes('rule').nth(bottomRuleIndex)
  await lastNode.scrollIntoViewIfNeeded()
  assert(await lastNode.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    const viewport = node.closest('.chain-viewport').getBoundingClientRect()
    return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1
  }), 'The last rule node should be reachable through the existing graph viewport')
  const policyBRouteIds = await nodeIds([
    ...Array.from({ length: 7 }, (_, index) => graphNode('rule', `route-${index * 2 + 1}.example.com`)),
    graphNode('group', 'Policy B'), graphNode('group', 'SharedSelect'), graphNode('outbound', 'ExitShared'),
  ])
  await graphNode('group', 'Policy B').hover()
  await assertGraphHighlight(policyBRouteIds, 9, 'A policy highlights only its seven real routes through the shared selector')
  await graphHeader.hover()
  await assertGraphHighlight([], 0, 'Leaving a shared-route policy clears emphasis')
  await graphNode('group', 'SharedSelect').hover()
  await assertGraphHighlight(await graphIds(), 18, 'A shared selector highlights every route that actually passes through it')
  await graphHeader.hover()
  await assertGraphHighlight([], 0, 'Leaving the shared selector clears emphasis')
  await graphNode('group', 'Policy A').hover()
  await graphNode('group', 'Policy A').focus()
  await dashboard.locator('.policy-filter select').hover()
  await dashboard.locator('.policy-filter select').selectOption('Policy B')
  assert.equal(await graphNodes('rule').count(), 7, 'Policy filtering should include every matching rule beyond the old limit')
  assert.equal(await graphNodes('group').count(), 2, 'Filtered routes should retain only their policy and shared selector')
  assert.equal(await graphNode('group', 'SharedSelect').count(), 1)
  assert.equal(await graphNodes('outbound').count(), 1)
  assert.equal(await graphEdges.count(), 9)
  await assertGraphHighlight([], 0, 'Filtering out the focused shared-route policy clears stale emphasis')
  await dashboard.locator('.policy-filter select').selectOption('')
  assert.equal(await graphNodes('rule').count(), 15, 'Clearing the filter should restore every rule')
  assert.equal(await graphNodes('group').count(), 3)
  assert.equal(await graphNodes('outbound').count(), 1)
  assert.equal(await graphEdges.count(), 18)
  await assertGraphHighlight([], 0, 'Resetting the shared-route filter leaves every card readable')
  test.sendConnections(fixture)
  await poll(async () => (await graphNodes('rule').count()) === 2, 'the complete graph returns to the regular fixture')
  await dashboard.locator('.pause-button').click()
  for (const width of [320, 390, 700, 1400]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `analytics/${width}: viewport overflow`)
  }
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.screenshot({ path: path.join(screenshotDir, 'rules-analytics-dark.png'), fullPage: true, animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(screenshotDir, 'rules-analytics-mobile.png'), fullPage: true, animations: 'disabled' })
  await test.context.close()
  console.log('PASS: deterministic rule traffic/domains, merged graph nodes and directed edges, route hover/focus, all routes beyond twelve, pause/resume, policy filter/reset, zoom, empty/recovery and 320/390/700/1400px overflow')
}

async function checkRuleProviderUpdates() {
  const originalTime = '2025-05-06T07:08:09Z'
  const updatedTime = '2025-06-07T08:09:10Z'
  const latestTime = '2025-07-08T09:10:11Z'
  const encodedName = 'remote / rules?#'
  const provider = (name, vehicleType, updatedAt = originalTime) => ({
    name, type: 'Rule', behavior: 'Domain', format: 'yaml', vehicleType, ruleCount: 12, updatedAt,
    ...(vehicleType === 'Inline' ? { payload: ['example.com'] } : {}),
  })
  const providers = {
    ads: provider('ads', 'HTTP'),
    'ru-domains': provider('ru-domains', 'File'),
    telegram: provider('telegram', 'Inline'),
    [encodedName]: provider(encodedName, 'HTTP'),
  }
  let metadataRequests = 0
  const puts = []
  let nextPutError = null
  let nextReadError = null
  let serverTime = updatedTime
  let finishPending
  const pending = new Promise((resolve) => { finishPending = resolve })
  let holdFirstPut = true
  const test = await openRules(async (route) => {
    metadataRequests++
    if (nextReadError) {
      const message = nextReadError
      nextReadError = null
      await route.fulfill({ status: 503, json: { message } })
    } else {
      await route.fulfill({ json: { providers } })
    }
  }, undefined, async (page) => {
    await page.route(`${origin}/rules`, (route) => route.fulfill({ json: {
      rules: Object.keys(providers).map((name) => ({ type: 'RuleSet', payload: name, proxy: 'DIRECT' })),
    } }))
    await page.route(`${origin}/providers/rules/**`, async (route) => {
      const request = route.request()
      assert.equal(request.method(), 'PUT', 'A rule provider is refreshed by PUT; readback uses the collection endpoint')
      const pathname = new URL(request.url()).pathname
      const name = decodeURIComponent(pathname.slice('/providers/rules/'.length))
      assert(Object.hasOwn(providers, name), 'The requested provider name must survive URL encoding')
      puts.push({ name, pathname })
      if (holdFirstPut) {
        holdFirstPut = false
        await pending
      }
      if (nextPutError) {
        const message = nextPutError
        nextPutError = null
        await route.fulfill({ status: 502, json: { message } })
        return
      }
      providers[name] = { ...providers[name], updatedAt: serverTime, ruleCount: providers[name].ruleCount + 1 }
      await route.fulfill({ status: 204 })
    })
  })
  const page = test.page
  const update = (name) => region(page, name).getByRole('button', { name: `Update rule provider ${name}`, exact: true })
  const timestamp = (name) => region(page, name).locator('time').getAttribute('datetime')
  const updated = (name) => region(page, name).getByRole('status').filter({ hasText: /^Provider updated\.?$/ })
  try {
    assert.equal(metadataRequests, 0, 'Adding update controls must preserve lazy metadata loading')
    await openSet(page, 'ads')
    await update('ads').waitFor()
    assert.equal(await timestamp('ads'), originalTime)
    await update('ads').click()
    await poll(() => puts.length === 1, 'the first provider update starts')
    assert(await update('ads').isDisabled(), 'Updating disables the provider button')
    await region(page, 'ads').getByRole('status').filter({ hasText: /^Updating…$/ }).waitFor()
    assert.equal(await timestamp('ads'), originalTime, 'Pending updates retain the last confirmed server timestamp')
    await update('ads').evaluate((button) => button.click())
    assert.equal(puts.length, 1, 'Native disabled activation cannot submit a duplicate update')

    await page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
    await page.getByRole('table', { name: 'Rules', exact: true }).waitFor()
    await openSet(page, 'ru-domains')
    assert(await update('ru-domains').isEnabled(), 'Another provider must not inherit the pending provider state')
    await openSet(page, 'ads')
    assert(await update('ads').isDisabled(), 'Switching tabs and filtering providers must preserve its in-flight request')
    assert.equal(metadataRequests, 1, 'Tab and search changes should not refetch cached provider metadata')
    finishPending()
    await updated('ads').waitFor()
    assert.equal(await timestamp('ads'), updatedTime, 'Successful refresh displays updatedAt returned by the API, not local completion time')
    assert.equal(metadataRequests, 2, 'A successful PUT must reload provider metadata')
    assert.equal(puts.length, 1)

    nextPutError = 'Provider download failed'
    await update('ads').click()
    await region(page, 'ads').getByRole('alert').filter({ hasText: 'Provider download failed' }).waitFor()
    assert.equal(await timestamp('ads'), updatedTime, 'Failed refreshes preserve the confirmed timestamp')
    assert.equal(metadataRequests, 2, 'A failed PUT must not claim a successful metadata refresh')
    assert(await update('ads').isEnabled(), 'An update error must allow retry')
    await update('ads').click()
    await updated('ads').waitFor()
    assert.equal(await timestamp('ads'), updatedTime, 'A successful check may return the same updatedAt when the content did not change')
    assert.equal(puts.length, 3, 'Retry issues one new PUT after a failed update')

    serverTime = latestTime
    nextReadError = 'Metadata temporarily unavailable'
    await update('ads').click()
    await region(page, 'ads').getByRole('alert').filter({
      hasText: 'Provider updated, but its details could not be reloaded: Metadata temporarily unavailable',
    }).waitFor()
    assert.equal(await timestamp('ads'), updatedTime, 'Readback failure must not invent an updated timestamp')
    const reload = region(page, 'ads').getByRole('button', { name: 'Reload rule provider ads', exact: true })
    await reload.waitFor()
    const putsBeforeReload = puts.length
    const readsBeforeReload = metadataRequests
    await reload.click()
    await updated('ads').waitFor()
    assert.equal(puts.length, putsBeforeReload, 'Retrying metadata after successful PUT must not download the provider again')
    assert.equal(metadataRequests, readsBeforeReload + 1)
    assert.equal(await timestamp('ads'), latestTime)

    await openSet(page, 'ru-domains')
    assert.equal(await timestamp('ru-domains'), originalTime, 'Another provider retains its own timestamp')
    await update('ru-domains').click()
    await updated('ru-domains').waitFor()
    assert.equal(puts.at(-1).name, 'ru-domains', 'File providers support explicit refresh as well as HTTP providers')
    assert.equal(await timestamp('ru-domains'), latestTime)

    await openSet(page, 'telegram')
    assert(await update('telegram').isDisabled(), 'Inline providers cannot be downloaded independently of configuration')
    await region(page, 'telegram').getByText('Inline rules are part of the configuration. Change them in the configuration and reload it.', { exact: true }).waitFor()
    const putsBeforeInline = puts.length
    await update('telegram').evaluate((button) => button.click())
    assert.equal(puts.length, putsBeforeInline, 'Inline provider controls must not issue PUT requests')
    await showInline(page, 'telegram')
    await region(page, 'telegram').getByRole('listitem').filter({ hasText: 'example.com' }).waitFor()

    await openSet(page, encodedName)
    await update(encodedName).click()
    await updated(encodedName).waitFor()
    assert.equal(puts.at(-1).pathname, `/providers/rules/${encodeURIComponent(encodedName)}`,
      'Slashes, spaces and query/hash characters in provider names must stay inside one encoded path segment')
    assert.equal(await timestamp(encodedName), latestTime)
    console.log('PASS: rule provider update, server timestamps, unchanged content, busy/dedup, tab/filter persistence, failure/retry, readback-only retry, File/Inline and encoded names')
  } finally {
    finishPending()
    await test.context.close()
  }
}

async function checkRuleProviderBatchUpdates() {
  const originalTime = '2025-05-06T07:08:09Z'
  const updatedTime = '2025-06-07T08:09:10Z'
  const latestTime = '2025-07-08T09:10:11Z'
  const provider = (name, vehicleType) => ({
    name, type: 'Rule', behavior: 'Domain', format: 'yaml', vehicleType,
    ruleCount: 12, updatedAt: originalTime,
    ...(vehicleType === 'Inline' ? { payload: ['example.com'] } : {}),
  })
  // API order deliberately interleaves inline and downloadable providers.
  const providers = {
    'inline-first': provider('inline-first', 'Inline'),
    ads: provider('ads', 'HTTP'),
    'inline-second': provider('inline-second', 'Inline'),
    'file-provider': provider('file-provider', 'File'),
    'hidden-http': provider('hidden-http', 'HTTP'),
  }
  const puts = []
  const pending = new Map()
  let activePuts = 0
  let maxActivePuts = 0
  let automatic = false
  let metadataRequests = 0
  let holdReadback = false
  let finishReadback
  let failReadback = false
  let serverTime = updatedTime
  const failedPuts = new Set(['file-provider'])
  const test = await openRules(async (route) => {
    metadataRequests++
    if (holdReadback) await new Promise(resolve => { finishReadback = resolve })
    if (failReadback) {
      failReadback = false
      await route.fulfill({ status: 503, json: { message: 'Batch metadata unavailable' } })
    } else await route.fulfill({ json: { providers } })
  }, undefined, async (page) => {
    await page.route(`${origin}/providers/rules/**`, async (route) => {
      const request = route.request()
      assert.equal(request.method(), 'PUT')
      const name = decodeURIComponent(new URL(request.url()).pathname.slice('/providers/rules/'.length))
      assert(Object.hasOwn(providers, name), 'Bulk updates must target actual API providers')
      assert.notEqual(providers[name].vehicleType, 'Inline', 'Inline providers must never receive bulk PUT requests')
      puts.push(name)
      activePuts++
      maxActivePuts = Math.max(maxActivePuts, activePuts)
      try {
        if (!automatic) await new Promise(resolve => { pending.set(name, resolve) })
        if (failedPuts.has(name)) await route.fulfill({ status: 502, json: { message: `${name} download failed` } })
        else {
          providers[name] = { ...providers[name], updatedAt: serverTime }
          await route.fulfill({ status: 204 })
        }
      } finally {
        pending.delete(name)
        activePuts--
      }
    })
  })
  const page = test.page
  const panel = providersPanel(page)
  const batch = page.getByTestId('rule-provider-batch')
  const bulk = page.getByTestId('rule-providers-update-all')
  const progress = () => page.getByRole('progressbar', { name: 'Rule provider update progress', exact: true })
  const update = (name) => region(page, name).getByRole('button', { name: `Update rule provider ${name}`, exact: true })
  const timestamp = (name) => region(page, name).locator('time').getAttribute('datetime')
  const visibleNames = () => panel.getByRole('region').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  const finishPut = (name) => {
    assert(pending.has(name), `Expected an active PUT for ${name}`)
    pending.get(name)()
  }
  try {
    await openProviders(page)
    await region(page, 'hidden-http').waitFor()
    assert.deepEqual(await visibleNames(), ['Rule set ads', 'Rule set file-provider', 'Rule set hidden-http', 'Rule set inline-first', 'Rule set inline-second'],
      'Inline providers come last while API order within both partitions stays stable')
    await providerSearch(page).fill('ads')
    holdReadback = true
    await bulk.click()
    await poll(() => pending.size === 2, 'the first two bulk provider requests start')
    assert.equal(puts.length, 2, 'A bulk update starts at most two requests concurrently')
    assert(await bulk.isDisabled(), 'A running batch cannot be started again')
    assert(await panel.getByRole('button', { name: 'Reload list', exact: true }).isDisabled(), 'List refresh is locked during batch writes')
    assert(await update('ads').isDisabled(), 'Individual updates are locked during a batch')
    assert.equal(await progress().getAttribute('aria-valuenow'), '0')
    assert.equal(await progress().getAttribute('aria-valuemax'), '3')
    await batch.getByText('Updating providers: 0/3', { exact: true }).waitFor()
    await bulk.evaluate(button => button.click())
    assert.equal(puts.length, 2, 'Disabled bulk activation must not enqueue duplicate work')
    assert.equal(metadataRequests, 1, 'No provider metadata is reloaded before all batch writes finish')

    await page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
    await page.getByRole('table', { name: 'Rules', exact: true }).waitFor()
    await openProviders(page)
    assert.equal(await progress().getAttribute('aria-valuenow'), '0', 'Pending batch state survives tab switches')
    assert.equal(await providerSearch(page).inputValue(), 'ads')
    await panel.getByRole('button', { name: 'Clear search', exact: true }).click()
    assert(await update('file-provider').isDisabled())
    assert(await update('hidden-http').isDisabled(), 'Queued provider controls must be locked too')

    finishPut('ads')
    await poll(() => pending.has('hidden-http'), 'a completed request releases a slot for a provider hidden by the original search')
    await poll(async () => (await progress().getAttribute('aria-valuenow')) === '1', 'progress counts the first completed request')
    finishPut('file-provider')
    await poll(async () => (await progress().getAttribute('aria-valuenow')) === '2', 'a failed provider still advances batch progress')
    finishPut('hidden-http')
    await poll(() => metadataRequests === 2 && !!finishReadback, 'one shared metadata request follows all three writes')
    assert.equal(await progress().getAttribute('aria-valuenow'), '3')
    await batch.getByText('Loading updated provider details…', { exact: true }).waitFor()
    assert(await bulk.isDisabled(), 'Batch controls remain locked until the shared metadata readback completes')
    assert.equal(await timestamp('ads'), originalTime, 'Finishing must keep the last confirmed API timestamp')
    holdReadback = false
    finishReadback()
    await batch.getByText('Finished: 2/3 · Failed: 1', { exact: true }).waitFor()
    assert.equal(maxActivePuts, 2, 'Bulk concurrency must never exceed two requests')
    assert.deepEqual(puts, ['ads', 'file-provider', 'hidden-http'], 'A failure must not stop later providers or exclude providers hidden by search')
    assert.equal(metadataRequests, 2, 'The batch uses one collection readback, not one read per provider')
    assert.equal(await timestamp('ads'), updatedTime)
    assert.equal(await timestamp('hidden-http'), updatedTime)
    assert.equal(await timestamp('file-provider'), originalTime)
    await region(page, 'file-provider').getByRole('alert').filter({ hasText: 'file-provider download failed' }).waitFor()
    assert(await bulk.isEnabled())
    assert(await update('file-provider').isEnabled(), 'A failed provider remains individually retryable after the batch')

    automatic = true
    failedPuts.clear()
    await providerSearch(page).fill('ads')
    const retryFailed = page.getByTestId('rule-providers-retry-failed')
    await retryFailed.click()
    await batch.getByText('Updated: 1/1', { exact: true }).waitFor()
    assert.deepEqual(puts.slice(3), ['file-provider'], 'Retry failed uses the failed batch snapshot, independently of the visible search')
    assert.equal(metadataRequests, 3, 'Retry failed uses one shared metadata readback')
    await panel.getByRole('button', { name: 'Clear search', exact: true }).click()
    assert.equal(await timestamp('file-provider'), updatedTime)
    assert.equal(await retryFailed.count(), 0, 'A successful retry clears the failed-target action')

    serverTime = latestTime
    failReadback = true
    await bulk.click()
    await region(page, 'ads').getByRole('alert').filter({ hasText: 'Batch metadata unavailable' }).waitFor()
    await batch.getByText('Updated: 3/3', { exact: true }).waitFor()
    assert.equal(puts.length, 7, 'The next batch starts each eligible provider exactly once')
    assert.equal(metadataRequests, 4, 'Failed metadata readback is still shared by the whole batch')
    assert.equal(await retryFailed.count(), 0, 'A metadata-only failure must not offer another PUT batch')
    assert.equal(await timestamp('ads'), updatedTime, 'Failed batch readback must not replace the confirmed timestamp')
    for (const name of ['ads', 'file-provider', 'hidden-http']) {
      await region(page, name).getByRole('button', { name: `Reload rule provider ${name}`, exact: true }).waitFor()
    }
    const putsBeforeRetry = puts.length
    await region(page, 'ads').getByRole('button', { name: 'Reload rule provider ads', exact: true }).click()
    await region(page, 'ads').getByRole('status').filter({ hasText: /^Provider updated\.?$/ }).waitFor()
    assert.equal(puts.length, putsBeforeRetry, 'A successful bulk PUT with failed readback retries metadata only')
    assert.equal(metadataRequests, 5)
    assert.equal(await timestamp('ads'), latestTime)
    console.log('PASS: stable Inline-last ordering, unfiltered bulk targets, concurrency 2, progress, tab persistence, control locks, partial failure, shared readback and GET-only recovery')
  } finally {
    automatic = true
    holdReadback = false
    finishReadback?.()
    for (const finish of pending.values()) finish()
    await test.context.close()
  }

  const inlineOnly = await openRules(route => route.fulfill({ json: { providers: { telegram: provider('telegram', 'Inline') } } }))
  try {
    await openProviders(inlineOnly.page)
    await region(inlineOnly.page, 'telegram').waitFor()
    assert(await inlineOnly.page.getByTestId('rule-providers-update-all').isDisabled(), 'A collection with only Inline providers has no bulk update action')
  } finally { await inlineOnly.context.close() }
}

async function checkRuleProviderBatchCancellation() {
  const originalTime = '2025-05-06T07:08:09Z'
  const updatedTime = '2025-06-07T08:09:10Z'
  const names = ['ads', 'first-bad', 'second-bad', 'held-fourth', 'held-fifth', 'queued-sixth']
  const providers = Object.fromEntries(names.map(name => [name, {
    name, type: 'Rule', vehicleType: 'HTTP', behavior: 'Domain', format: 'yaml', ruleCount: 12, updatedAt: originalTime,
  }]))
  const puts = []
  const pending = new Map()
  const failedPuts = new Set(['first-bad', 'second-bad'])
  let automatic = false
  let metadataRequests = 0
  let holdMetadata = false
  let pendingMetadata
  const stoppedHint = 'Requests already sent may still finish in the core. Reload the list to check their status.'
  const test = await openRules(async (route) => {
    metadataRequests++
    const request = route.request()
    try {
      if (holdMetadata) await new Promise(resolve => { pendingMetadata = { request, resolve } })
      if (!request.failure()) await route.fulfill({ json: { providers } })
    } catch (error) {
      if (!request.failure()) throw error
    } finally {
      if (pendingMetadata?.request === request) pendingMetadata = null
    }
  }, undefined, async (page) => {
    // Release deliberately paused handlers when their fetch is aborted, as a server could still finish it.
    page.on('requestfailed', request => {
      for (const pendingRequest of pending.values()) {
        if (pendingRequest.request === request) pendingRequest.resolve()
      }
      if (pendingMetadata?.request === request) pendingMetadata.resolve()
    })
    await page.route(`${origin}/providers/rules/**`, async (route) => {
      const request = route.request()
      const name = decodeURIComponent(new URL(request.url()).pathname.slice('/providers/rules/'.length))
      assert.equal(request.method(), 'PUT')
      assert(Object.hasOwn(providers, name))
      puts.push(name)
      try {
        if (!automatic) await new Promise(resolve => { pending.set(name, { request, resolve }) })
        if (request.failure()) return
        if (failedPuts.has(name)) await route.fulfill({ status: 502, json: { message: `${name} download failed` } })
        else {
          providers[name] = { ...providers[name], updatedAt: updatedTime }
          await route.fulfill({ status: 204 })
        }
      } catch (error) {
        if (!request.failure()) throw error
      } finally {
        if (pending.get(name)?.request === request) pending.delete(name)
      }
    })
  })
  const page = test.page
  const panel = providersPanel(page)
  const bulk = page.getByTestId('rule-providers-update-all')
  const cancel = page.getByTestId('rule-providers-cancel')
  const retryFailed = page.getByTestId('rule-providers-retry-failed')
  const resume = page.getByTestId('rule-providers-resume')
  const batch = page.getByTestId('rule-provider-batch')
  const update = name => region(page, name).getByRole('button', { name: `Update rule provider ${name}`, exact: true })
  const finishPut = name => {
    assert(pending.has(name), `Expected a held PUT for ${name}`)
    pending.get(name).resolve()
  }
  try {
    await openProviders(page)
    await region(page, 'queued-sixth').waitFor()
    await bulk.click()
    await poll(() => pending.has('ads') && pending.has('first-bad'), 'cancellable batch starts its first two requests')
    finishPut('ads')
    await poll(() => pending.has('second-bad'), 'first success releases the next worker slot')
    finishPut('first-bad')
    await poll(() => pending.has('held-fourth'), 'first actual failure releases the next slot')
    finishPut('second-bad')
    await poll(() => pending.has('held-fifth'), 'second actual failure releases the next slot')
    await page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
    await page.getByRole('table', { name: 'Rules', exact: true }).waitFor()
    await openProviders(page)
    await batch.getByText('Updating providers: 3/6', { exact: true }).waitFor()
    await cancel.click()
    await batch.getByText('Stopped · Updated: 1/6 · Failed: 2', { exact: true }).waitFor()
    await batch.getByText(stoppedHint, { exact: true }).waitFor()
    await poll(() => pending.size === 0, 'in-flight provider fetches are aborted on cancellation')
    assert.deepEqual(puts, ['ads', 'first-bad', 'second-bad', 'held-fourth', 'held-fifth'], 'Cancellation must stop the remaining queued provider')
    assert.equal(metadataRequests, 1, 'Cancelling writes must not start a new metadata request')
    assert.equal(await cancel.count(), 0, 'The stop control disappears once the batch has settled')
    assert(await bulk.isEnabled(), 'Cancelling releases the bulk action lock')
    assert(await panel.getByRole('button', { name: 'Reload list', exact: true }).isEnabled(), 'Cancelling releases the metadata reload lock')
    for (const name of names) {
      const action = region(page, name).getByRole('button', { name: /^(?:Update|Reload) rule provider / })
      assert(await action.isEnabled(), `${name}: no provider action may remain busy after cancellation`)
      assert.notEqual(await action.getAttribute('aria-busy'), 'true')
    }
    for (const name of ['held-fourth', 'held-fifth', 'queued-sixth']) {
      assert.equal(await region(page, name).getByRole('alert').count(), 0, 'Interrupted and unstarted providers are not download failures')
    }
    await region(page, 'first-bad').getByRole('alert').filter({ hasText: 'first-bad download failed' }).waitFor()
    await region(page, 'second-bad').getByRole('alert').filter({ hasText: 'second-bad download failed' }).waitFor()
    assert(await retryFailed.isEnabled())
    assert(await resume.isEnabled())
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 3', 'Remaining work includes interrupted and queued targets, excluding known successes and real failures')
    await page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
    await openProviders(page)
    await batch.getByText('Stopped · Updated: 1/6 · Failed: 2', { exact: true }).waitFor()

    automatic = true
    failedPuts.clear()
    await update('first-bad').click()
    await region(page, 'first-bad').getByRole('status').filter({ hasText: /^Provider updated\.?$/ }).waitFor()
    const beforeRetry = puts.length
    await providerSearch(page).fill('ads')
    await retryFailed.click()
    await batch.getByText('Updated: 1/1', { exact: true }).waitFor()
    assert.deepEqual(puts.slice(beforeRetry), ['second-bad'], 'Retry excludes manually recovered, interrupted and queued providers, regardless of the visible search')
    assert.equal(await retryFailed.count(), 0)
    await panel.getByRole('button', { name: 'Clear search', exact: true }).click()
    assert(await bulk.isEnabled(), 'A new batch can complete after cancellation without inheriting an aborted page signal')
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 3', 'Retrying actual failures must preserve the separate remaining-work snapshot')

    await update('held-fourth').click()
    await region(page, 'held-fourth').getByRole('status').filter({ hasText: /^Provider updated\.?$/ }).waitFor()
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 2', 'A manually recovered interrupted provider leaves the remaining-work snapshot')
    automatic = false
    const beforeResume = puts.length
    await providerSearch(page).fill('ads')
    await resume.click()
    await poll(() => pending.has('held-fifth') && pending.has('queued-sixth'), 'Resume starts only interrupted and unstarted providers, independently of search')
    assert.deepEqual(puts.slice(beforeResume), ['held-fifth', 'queued-sixth'])
    finishPut('held-fifth')
    await batch.getByText('Updating providers: 1/2', { exact: true }).waitFor()
    await cancel.click()
    await batch.getByText('Stopped · Updated: 1/2 · Failed: 0', { exact: true }).waitFor()
    await poll(() => pending.size === 0, 'cancelling Resume releases its active request')
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 1', 'A second cancellation retains only unfinished work from Resume')
    assert.equal(await retryFailed.count(), 0, 'Interrupted Resume requests are not failed downloads')
    automatic = true
    const beforeSecondResume = puts.length
    await resume.click()
    await batch.getByText('Updated: 1/1', { exact: true }).waitFor()
    assert.deepEqual(puts.slice(beforeSecondResume), ['queued-sixth'], 'Repeated Resume never repeats confirmed successful PUTs whose metadata was not reloaded')
    assert.equal(await resume.count(), 0, 'Finishing the remaining work removes the Resume action')
    await panel.getByRole('button', { name: 'Clear search', exact: true }).click()

    holdMetadata = true
    const beforeMetadataCancellation = puts.length
    await bulk.click()
    await poll(() => !!pendingMetadata, 'successful batch enters the shared metadata readback')
    await batch.getByText('Loading updated provider details…', { exact: true }).waitFor()
    await cancel.click()
    await batch.getByText('Stopped · Updated: 6/6 · Failed: 0', { exact: true }).waitFor()
    await poll(() => pendingMetadata === null, 'cancelling aborts the shared metadata request')
    assert.equal(puts.length - beforeMetadataCancellation, names.length)
    assert.equal(await retryFailed.count(), 0, 'An interrupted GET is not a failed provider download')
    assert.equal(await resume.count(), 0, 'Cancelling only metadata readback leaves no unfinished PUTs to resume')
    assert(await bulk.isEnabled())
    holdMetadata = false
    const putsBeforeReload = puts.length
    const readsBeforeReload = metadataRequests
    await panel.getByRole('button', { name: 'Reload list', exact: true }).click()
    await poll(async () => metadataRequests === readsBeforeReload + 1 && await panel.getByRole('button', { name: 'Reload list', exact: true }).isEnabled(), 'Reload list completes the authoritative metadata readback after cancellation')
    assert.equal(await region(page, 'queued-sixth').locator('time').getAttribute('datetime'), updatedTime)
    assert.equal(metadataRequests, readsBeforeReload + 1)
    assert.equal(puts.length, putsBeforeReload, 'Rechecking cancelled metadata must not repeat any successful PUT')
    assert(await update('queued-sixth').isEnabled(), 'Successful metadata recovery clears readback-only states')
    console.log('PASS: cancel active/queued requests and metadata GET, release locks, preserve separate retry/resume snapshots, manual recovery, filtered Resume, repeated cancellation and no repeated successful PUTs')
  } finally {
    automatic = true
    holdMetadata = false
    for (const request of pending.values()) request.resolve()
    pendingMetadata?.resolve()
    await test.context.close()
  }
}

async function checkRuleProviderCancelledRetryQueue() {
  const names = ['ads', 'retry-b', 'retry-c', 'retry-d']
  const providers = Object.fromEntries(names.map(name => [name, {
    name, type: 'Rule', vehicleType: 'HTTP', behavior: 'Domain', format: 'yaml', ruleCount: 12,
    updatedAt: '2025-05-06T07:08:09Z',
  }]))
  const puts = []
  const pending = new Map()
  let phase = 'fail'
  const test = await openRules(route => route.fulfill({ json: { providers } }), undefined, async page => {
    page.on('requestfailed', request => {
      for (const held of pending.values()) if (held.request === request) held.resolve()
    })
    await page.route(`${origin}/providers/rules/**`, async route => {
      const request = route.request()
      const name = decodeURIComponent(new URL(request.url()).pathname.slice('/providers/rules/'.length))
      assert.equal(request.method(), 'PUT')
      assert(Object.hasOwn(providers, name))
      puts.push(name)
      const requestPhase = phase
      try {
        if (requestPhase === 'hold') await new Promise(resolve => { pending.set(name, { request, resolve }) })
        if (request.failure()) return
        if (requestPhase === 'fail') await route.fulfill({ status: 502, json: { message: `${name} initial failure` } })
        else {
          providers[name] = { ...providers[name], updatedAt: '2025-06-07T08:09:10Z' }
          await route.fulfill({ status: 204 })
        }
      } catch (error) {
        if (!request.failure()) throw error
      } finally {
        if (pending.get(name)?.request === request) pending.delete(name)
      }
    })
  })
  const page = test.page
  const batch = page.getByTestId('rule-provider-batch')
  const retry = page.getByTestId('rule-providers-retry-failed')
  const resume = page.getByTestId('rule-providers-resume')
  try {
    await openProviders(page)
    await region(page, 'retry-d').waitFor()
    await page.getByTestId('rule-providers-update-all').click()
    await batch.getByText('Finished: 0/4 · Failed: 4', { exact: true }).waitFor()
    assert.equal(puts.length, 4)
    assert.equal(await retry.getAttribute('title'), 'Retry only failed updates: 4')

    phase = 'hold'
    await retry.click()
    await poll(() => pending.has('ads') && pending.has('retry-b'), 'retry starts its first two failed providers')
    await page.getByTestId('rule-providers-cancel').click()
    await batch.getByText('Stopped · Updated: 0/4 · Failed: 0', { exact: true }).waitFor()
    await poll(() => pending.size === 0, 'cancelled retry releases its active requests')
    assert.deepEqual(puts.slice(4), ['ads', 'retry-b'], 'Cancellation must leave the remaining retry queue unstarted')
    assert(await retry.isEnabled(), 'Failures still queued when retry is cancelled must remain retryable')
    assert.equal(await retry.getAttribute('title'), 'Retry only failed updates: 2')
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 4', 'Cancelled retry retains both interrupted and queued work for Resume')
    for (const name of ['retry-c', 'retry-d']) {
      await region(page, name).getByRole('alert').filter({ hasText: `${name} initial failure` }).waitFor()
    }
    for (const name of ['ads', 'retry-b']) {
      assert.equal(await region(page, name).getByRole('alert').count(), 0, 'A started then interrupted retry has unknown status, not its previous failure')
    }

    phase = 'success'
    await providerSearch(page).fill('ads')
    await retry.click()
    await batch.getByText('Updated: 2/2', { exact: true }).waitFor()
    assert.deepEqual(puts.slice(6), ['retry-c', 'retry-d'], 'The next retry must include only known failures that never started during the cancelled retry')
    assert.equal(await retry.count(), 0)
    assert.equal(await resume.getAttribute('title'), 'Resume interrupted and not-started updates: 2', 'Successful retry removes the overlap from remaining work without losing the interrupted providers')
    console.log('PASS: cancelling Retry failed preserves unstarted failures while excluding interrupted retries')
  } finally {
    phase = 'success'
    for (const held of pending.values()) held.resolve()
    await test.context.close()
  }
}

try {
  const port = await freePort()
  origin = `http://127.0.0.1:${port}`
  base = `${origin}/ui/`
  mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SECRET: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  mock.stdout.on('data', (chunk) => { mockOutput += chunk })
  mock.stderr.on('data', (chunk) => { mockOutput += chunk })
  await poll(async () => {
    if (mock.exitCode !== null) throw new Error(`Mock exited: ${mockOutput}`)
    try {
      return (await fetch(`${origin}/version`, { headers: { Authorization: 'Bearer test' } })).ok
    } catch {
      return false
    }
  }, 'mock startup')
  browser = await launchBrowser()
  await checkAnalytics()
  await checkRuleProviderUpdates()
  await checkRuleProviderBatchUpdates()
  await checkRuleProviderBatchCancellation()
  await checkRuleProviderCancelledRetryQueue()

  let providerRequests = 0
  const main = await openRules(async (route) => {
    providerRequests++
    const response = await route.fetch()
    const data = await response.json()
    data.providers['unreferenced-provider'] = {
      name: 'unreferenced-provider', type: 'Rule', vehicleType: 'HTTP', behavior: 'Domain',
      ruleCount: 42, format: 'yaml', updatedAt: '2026-11-08T09:00:00Z',
    }
    await route.fulfill({ response, json: data })
  })
  const page = main.page
  const rulesTab = page.getByRole('tab', { name: /^Rules(?:\s|$)/ })
  const providerTab = page.getByRole('tab', { name: /^Rule providers(?:\s|$)/ })
  await page.getByRole('tablist', { name: 'Rules sections', exact: true }).waitFor()
  assert.equal(await rulesTab.getAttribute('aria-selected'), 'true')
  assert.equal(providerRequests, 0, 'Provider metadata stays lazy on the routing rules tab')
  const adsButton = expand(page, 'ads')
  assert.equal(await adsButton.getAttribute('aria-expanded'), 'false')
  await adsButton.focus()
  await adsButton.press('Enter')
  const controls = await collapse(page, 'ads').getAttribute('aria-controls')
  assert(controls, 'Rule disclosure must expose aria-controls')
  assert.equal(await page.locator(`[id="${controls}"]`).count(), 1)
  assert.equal(await collapse(page, 'ads').getAttribute('aria-expanded'), 'true')
  assert.equal(providerRequests, 0, 'Opening rule statistics must not load provider metadata')
  assert.equal(await region(page, 'ads').count(), 0, 'Provider details no longer live inside routing rule rows')
  await collapse(page, 'ads').press('Space')
  assert.equal(await adsButton.getAttribute('aria-expanded'), 'false')
  await adsButton.click()
  await page.getByRole('button', { name: 'Open rule provider ads', exact: true }).click()
  const ads = region(page, 'ads')
  await ads.getByText(/^HTTP$/i).waitFor()
  const providerHeading = ads.getByRole('heading', { name: 'Rule set ads', exact: true })
  const providerName = providerHeading.getByText('ads', { exact: true })
  const providerPrefix = providerHeading.getByText('Rule set', { exact: true })
  await providerName.waitFor()
  assert.notEqual(await providerName.evaluate(node => getComputedStyle(node).color),
    await providerPrefix.evaluate(node => getComputedStyle(node).color), 'Provider names have accent color while the Rule set prefix is subdued')
  assert.equal(await providerTab.getAttribute('aria-selected'), 'true')
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('tab'), 'providers')
  assert.equal(await providerSearch(page).inputValue(), 'ads', 'The rule shortcut filters the matching provider')
  assert.equal(await ads.getByRole('searchbox').count(), 0, 'Remote providers must not advertise payload search')
  await providersPanel(page).getByRole('button', { name: 'Clear search', exact: true }).click()
  await region(page, 'unreferenced-provider').waitFor()
  assert.equal(await providersPanel(page).getByRole('region').count(), 4, 'All API providers must appear, including providers absent from rule rows')
  assert.equal(providerRequests, 1)
  assert.equal(await page.locator('.rules-analytics').isVisible(), false, 'Provider management must not keep the routing graph visible')
  console.log('PASS: separate accessible tabs, lazy provider data, rule shortcut and providers not referenced by rules')

  await rulesTab.click()
  const rulesSearch = page.getByRole('searchbox', { name: 'Domain, type, proxy', exact: true })
  await rulesSearch.fill('youtube.com')
  await providerTab.click()
  await providerSearch(page).fill('ru-domains')
  await rulesTab.click()
  assert.equal(await rulesSearch.inputValue(), 'youtube.com', 'Routing-rule search survives tab switches')
  await page.goBack()
  await providersPanel(page).waitFor()
  assert.equal(await providerSearch(page).inputValue(), 'ru-domains', 'Provider search is independent and survives Back')
  await page.goForward()
  await page.getByRole('table', { name: 'Rules', exact: true }).waitFor()
  assert.equal(await rulesSearch.inputValue(), 'youtube.com')
  await rulesSearch.fill('')
  await rulesTab.focus()
  await rulesTab.press('ArrowRight')
  await providersPanel(page).waitFor()
  assert.equal(await providerTab.getAttribute('aria-selected'), 'true', 'Tabs support keyboard arrow navigation')
  assert.equal(providerRequests, 1, 'Tab navigation reuses provider metadata')
  await page.reload()
  await providersPanel(page).waitFor()
  await region(page, 'unreferenced-provider').waitFor()
  assert.equal(await providerTab.getAttribute('aria-selected'), 'true', 'A provider-tab URL reloads into the same tab')
  assert.equal(providerRequests, 2)
  console.log('PASS: independent tab searches, keyboard navigation, browser Back/Forward and provider deep-link reload')

  const telegram = await openSet(page, 'telegram')
  assert.equal(await telegram.getByRole('listitem').count(), 0, 'Inline payload starts collapsed in the provider list')
  const inlineToggle = telegram.getByRole('button', { name: 'Show rules in telegram', exact: true })
  assert.equal(await inlineToggle.getAttribute('aria-expanded'), 'false')
  await inlineToggle.press('Enter')
  await telegram.getByRole('listitem').filter({ hasText: 'DOMAIN-SUFFIX,telegram.org' }).waitFor()
  assert.equal(await telegram.getByRole('listitem').count(), 3)
  const inlineControls = await telegram.getByRole('button', { name: 'Hide rules in telegram', exact: true }).getAttribute('aria-controls')
  assert(inlineControls, 'Inline disclosure must identify its contents')
  assert.equal(await page.locator(`[id="${inlineControls}"]`).count(), 1)
  const search = telegram.getByRole('searchbox', { name: 'Find a rule in this set', exact: true })
  await search.fill('TELEGRAM.ORG')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 1, 'case-insensitive inline search')
  assert.match(await telegram.getByRole('listitem').innerText(), /telegram\.org/)
  await search.fill('no-such-domain.example')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 0, 'empty inline search result')
  await search.fill('149.154')
  await telegram.getByRole('listitem').filter({ hasText: '149.154.160.0/20' }).waitFor()
  await search.fill('')
  await poll(async () => (await telegram.getByRole('listitem').count()) === 3, 'clearing inline search')
  await telegram.getByRole('button', { name: 'Hide rules in telegram', exact: true }).press('Space')
  assert.equal(await telegram.getByRole('listitem').count(), 0)
  await showInline(page, 'telegram')
  const file = await openSet(page, 'ru-domains')
  await file.getByText(/^File$/i).waitFor()
  assert.equal(await file.getByRole('searchbox').count(), 0)
  assert.equal(providerRequests, 2)
  await providerSearch(page).fill('no-such-provider')
  await providersPanel(page).getByText('No matching rule providers', { exact: true }).waitFor()
  await providersPanel(page).getByRole('button', { name: 'Clear search', exact: true }).click()
  await region(page, 'telegram').waitFor()
  console.log('PASS: inline disclosure, domain/IP search, empty results, File provider, independent provider search and shared cache')

  await setLanguage(page, 'ru')
  await page.getByRole('tab', { name: /^Провайдеры правил(?:\s|$)/ }).click()
  await providersPanel(page).getByRole('searchbox').fill('telegram')
  const russian = page.getByRole('region', { name: 'Набор правил telegram', exact: true })
  await russian.getByRole('button', { expanded: false }).click()
  await russian.getByRole('searchbox', { name: 'Найти правило в наборе', exact: true }).waitFor()
  await russian.getByRole('listitem').first().waitFor()
  await page.screenshot({ path: path.join(screenshotDir, 'rule-providers-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: path.join(screenshotDir, 'rule-providers-dark.png'), fullPage: true, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
  for (const [width, columns] of [[390, 2], [700, 3], [1400, 4]]) {
    await page.setViewportSize({ width, height: width < 640 ? 844 : 900 })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `providers/${width}: viewport overflow`)
    if (width === 390 || width === 700) {
      await page.screenshot({ path: path.join(screenshotDir, `rule-providers-${width === 390 ? 'mobile' : 'tablet'}.png`), fullPage: true, animations: 'disabled' })
    }
    await page.getByRole('tab', { name: /^Правила(?:\s|$)/ }).click()
    const russianRule = page.getByRole('button', { name: 'Раскрыть набор telegram', exact: true })
    if (await russianRule.isVisible()) await russianRule.click()
    await checkColumns(page, width, columns, 'expanded rule statistics')
    const russianRulesSearch = page.getByRole('searchbox', { name: 'Домен, тип, прокси', exact: true })
    await russianRulesSearch.fill('no-such-top-level-rule.example')
    await page.getByText('Ничего не найдено', { exact: true }).waitFor()
    await checkColumns(page, width, columns, 'no results')
    await russianRulesSearch.fill('')
    await page.getByRole('tab', { name: /^Провайдеры правил(?:\s|$)/ }).click()
    await russian.waitFor()
  }
  await setLanguage(page, 'en')
  await openSet(page, 'telegram')
  await showInline(page, 'telegram')
  await region(page, 'telegram').getByRole('searchbox', { name: 'Find a rule in this set', exact: true }).waitFor()
  await main.context.close()
  console.log('PASS: Russian/English tabs and provider labels; 390/700/1400px provider layout and rule table columns')

  let attempts = 0
  const failed = await openRules(async (route) => {
    if (++attempts === 1) await route.fulfill({ status: 503, json: { message: 'Provider temporarily unavailable' } })
    else await route.continue()
  })
  const failedPanel = await openProviders(failed.page)
  await failedPanel.getByRole('alert').filter({ hasText: 'Provider temporarily unavailable' }).waitFor()
  await failedPanel.getByRole('button', { name: 'Retry', exact: true }).click()
  await region(failed.page, 'telegram').waitFor()
  await showInline(failed.page, 'telegram')
  await region(failed.page, 'telegram').getByRole('listitem').first().waitFor()
  assert.equal(attempts, 2, 'Explicit Retry should refetch providers once')
  await failed.page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
  await failed.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await failed.context.close()
  console.log('PASS: provider request errors do not break routing rules; Retry recovers providers')

  const missing = await openRules((route) => route.fulfill({ json: { providers: {} } }))
  const missingPanel = await openProviders(missing.page)
  await missingPanel.getByText('No rule providers', { exact: true }).waitFor()
  assert.equal(await missingPanel.getByRole('region').count(), 0)
  await missing.page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
  await missing.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await missing.context.close()
  console.log('PASS: empty provider collection has an explicit empty state and routing rules remain available')

  const unsupported = await openRules((route) => route.fulfill({ status: 404, json: { message: 'Not Found' } }))
  const unsupportedPanel = await openProviders(unsupported.page)
  await unsupportedPanel.getByRole('alert').filter({ hasText: 'This core does not provide rule set details.' }).waitFor()
  await unsupported.page.getByRole('tab', { name: /^Rules(?:\s|$)/ }).click()
  await unsupported.page.getByRole('table').getByText('youtube.com', { exact: true }).waitFor()
  await unsupported.context.close()

  for (const [ruleCount, expected] of [
    [0, 'This rule set is empty.'],
    [3, 'The API did not return the rules in this inline set.'],
  ]) {
    const inline = await openRules((route) => route.fulfill({ json: { providers: { telegram: {
      name: 'telegram', behavior: 'Classical', vehicleType: 'Inline', type: 'Rule', ruleCount,
    } } } }))
    const details = await openSet(inline.page, 'telegram')
    await showInline(inline.page, 'telegram')
    await details.getByText(expected, { exact: true }).waitFor()
    assert.equal(await details.getByRole('searchbox').count(), 0)
    assert.equal(await details.getByRole('listitem').count(), 0)
    await inline.context.close()
  }
  console.log('PASS: unsupported provider API; empty inline set differs from omitted inline payload')

  const payload = Array.from({ length: 275 }, (_, index) => `DOMAIN-SUFFIX,entry-${index}.example.com`)
  const large = await openRules((route) => route.fulfill({
    json: { providers: { telegram: {
      name: 'telegram', behavior: 'Classical', vehicleType: 'Inline', type: 'Rule',
      ruleCount: payload.length, updatedAt: '2026-11-08T09:00:00Z', payload,
    } } },
  }))
  const largeDetails = await openSet(large.page, 'telegram')
  await showInline(large.page, 'telegram')
  await poll(async () => (await largeDetails.getByRole('listitem').count()) === 200, 'bounded rendering for large inline payload')
  await largeDetails.getByText(/first 200/i).waitFor()
  await largeDetails.getByRole('searchbox').fill('entry-274.example.com')
  await poll(async () => (await largeDetails.getByRole('listitem').count()) === 1, 'search reaches rules outside the render limit')
  assert.match(await largeDetails.getByRole('listitem').innerText(), /entry-274\.example\.com/)
  await large.context.close()
  console.log('PASS: large inline sets render at most 200 entries while search covers the complete payload')

  assert.deepEqual(errors, [], 'Unexpected browser runtime errors')
  console.log(`Screenshots: ${screenshotDir}`)
} finally {
  await browser?.close()
  if (mock && mock.exitCode === null) {
    const stopped = once(mock, 'exit')
    mock.kill()
    await stopped
  }
}
