// npm run dev в другом терминале; node scripts/check-geography.mjs.
// MIBOARD_TEST_URL позволяет проверить также preview или собранную /ui/.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { GeoDatabase } from '../src/lib/geo-db.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.geography-check')
const base = process.env.MIBOARD_TEST_URL ?? 'http://127.0.0.1:5173'
const mockPort = 19091
const mockUrl = `http://127.0.0.1:${mockPort}`
const secret = 'geography-check'
const entry = new URL(base)
entry.hash = `/geography?hostname=127.0.0.1&port=${mockPort}&protocol=http&secret=${secret}`

const mock = spawn(process.execPath, [path.join(root, 'mock/server.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(mockPort), SECRET: secret },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let mockOutput = ''
let mockError
mock.stdout.on('data', (chunk) => (mockOutput += chunk))
mock.stderr.on('data', (chunk) => (mockOutput += chunk))
mock.on('error', (error) => (mockError = error))
let browser
const errors = []
const externalRequests = []

function sample(id, host, country, download, destinationIP = '203.0.113.1') {
  return {
    id,
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.25', sourcePort: '49152',
      destinationIP, destinationPort: '443', host,
      destinationGeoIP: country ? [country] : null,
    },
    upload: 125_000, download, start: '2026-11-08T10:00:00Z',
    chains: ['DIRECT'], rule: 'Match', rulePayload: '',
  }
}

const fixture = [
  sample('us-1', 'github.com', 'US', 84_500_000),
  sample('us-2', 'objects.githubusercontent.com', 'US', 37_400_000),
  sample('de-1', 'cdn.example.de', 'DE', 4_210_000_000),
  sample('nl-1', 'web.telegram.org', 'NL', 12_700_000),
  sample('jp-1', 'api.example.jp', 'JP', 9_300_000),
  sample('br-1', 'media.example.com.br', 'BR', 7_100_000),
  sample('au-1', 'static.example.com.au', 'AU', 5_700_000),
  sample('za-1', 'assets.example.co.za', 'ZA', 3_200_000),
  sample('private', '', null, 128_000, '192.168.1.1'),
  sample('unknown', 'unresolved.example.net', null, 63_000),
]

function snapshot(connections) {
  return JSON.stringify({
    uploadTotal: connections.reduce((sum, connection) => sum + connection.upload, 0),
    downloadTotal: connections.reduce((sum, connection) => sum + connection.download, 0),
    connections,
  })
}

async function eventually(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    if (mockError) throw mockError
    if (mock.exitCode !== null) throw new Error(`Мок завершился: ${mockOutput}`)
    await delay(50)
  }
  throw new Error(message)
}

async function newPage(viewport = { width: 1440, height: 1000 }, colorScheme = 'light', locale = 'ru') {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' })
  await context.addInitScript((locale) => {
    localStorage.setItem('miboard.locale', locale)
    localStorage.removeItem('miboard.theme')
  }, locale)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !expectedFailures.some((part) => message.location().url.includes(part))) errors.push(message.text())
  })
  const expectedFailures = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!['http:', 'https:'].includes(url.protocol)) return
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) externalRequests.push(request.url())
  })
  return { context, page, expectedFailures }
}

async function noOverflow(page, label) {
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  assert.ok(widths.document <= widths.viewport + 1 && widths.body <= widths.viewport + 1,
    `${label}: горизонтальный скролл ${JSON.stringify(widths)}`)
}

async function checkDenseMarkers(page, label) {
  for (const code of ['DE', 'NL']) {
    const country = page.locator(`g.country[data-country="${code}"]`)
    const marker = page.locator(`[data-marker-country="${code}"] .point`)
    await marker.scrollIntoViewIfNeeded()
    const bounds = await marker.boundingBox()
    assert.ok(bounds, `${label}: не найден маркер ${code}`)
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    assert.equal(await country.getAttribute('aria-pressed'), 'true',
      `${label}: клик по центру ${code} перехвачен соседней страной`)
    await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()
  }
  await page.mouse.move(0, 0)
  await page.evaluate(() => window.scrollTo(0, 0))
}

async function camera(page) {
  return page.getByTestId('map-transform').evaluate((element) => {
    const matrix = element.transform.baseVal.consolidate()?.matrix
    return { scale: matrix?.a ?? 1, x: matrix?.e ?? 0, y: matrix?.f ?? 0 }
  })
}

async function worldAt(page, point) {
  return page.getByTestId('map-transform').evaluate((element, point) => {
    const matrix = element.getScreenCTM()
    const world = new DOMPoint(point.x, point.y).matrixTransform(matrix.inverse())
    return { x: world.x, y: world.y }
  }, point)
}

async function mapStillVisible(page, label) {
  const viewport = await page.getByTestId('map-viewport').boundingBox()
  const world = await page.locator('.ocean').boundingBox()
  assert.ok(viewport && world, `${label}: исчезла геометрия карты`)
  const visibleWidth = Math.min(viewport.x + viewport.width, world.x + world.width) - Math.max(viewport.x, world.x)
  const visibleHeight = Math.min(viewport.y + viewport.height, world.y + world.height) - Math.max(viewport.y, world.y)
  assert.ok(visibleWidth >= 40 && visibleHeight >= 40, `${label}: мир можно утащить за границы карты`)
}

async function checkLightContrast(page) {
  const contrasts = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const luminance = (color) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data
      const linear = (value) => value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }
    const ocean = luminance(getComputedStyle(document.querySelector('.ocean')).fill)
    const colors = [...document.querySelectorAll('.land path')].map((element) => getComputedStyle(element).fill)
    const frequencies = new Map()
    for (const color of colors) frequencies.set(color, (frequencies.get(color) ?? 0) + 1)
    const commonLandColor = [...frequencies].sort((a, b) => b[1] - a[1])[0][0]
    const land = luminance(commonLandColor)
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    return { land: ratio(ocean, land), colors: new Set(colors).size }
  })
  assert.ok(contrasts.land >= 1.15, `Светлая карта: суша сливается с океаном (${contrasts.land.toFixed(2)}:1)`)
  assert.ok(contrasts.colors > 1, 'Светлая карта: страны с трафиком не выделены цветом')
}

async function regionCards(page) {
  return page.getByTestId('region-details').getByTestId('region-card').evaluateAll((elements) =>
    elements.map((element) => Object.fromEntries([
      ['code', element.getAttribute('data-country')],
      ...['total', 'download', 'upload', 'count', 'share'].map((name) => [name, Number(element.getAttribute(`data-${name}`) ?? 'NaN')]),
    ])),
  )
}

async function checkRegionDetails(page, sendSnapshot) {
  const panel = page.getByTestId('region-details')
  const cards = panel.getByTestId('region-card')
  const traffic = page.getByTestId('region-metric-traffic')
  const connections = page.getByTestId('region-metric-connections')
  const expand = page.getByTestId('region-show-all')
  // A large unlocated total makes an incorrect share denominator visible.
  const regionFixture = fixture.map((connection) => connection.metadata.destinationGeoIP ? connection : {
    ...connection, download: 37_000_000_000, upload: 1_000_000_000,
  })
  const known = regionFixture.filter((connection) => connection.metadata.destinationGeoIP)
  const locatedTraffic = known.reduce((sum, connection) => sum + connection.download + connection.upload, 0)
  sendSnapshot(regionFixture)
  await cards.first().waitFor()
  await panel.getByRole('heading', { name: 'Детали по странам', exact: true }).waitFor()
  assert.equal(await traffic.getAttribute('aria-label'), 'Ранжировать страны по трафику')
  assert.equal(await connections.getAttribute('aria-label'), 'Ранжировать страны по соединениям')
  assert.equal(await expand.textContent(), 'Показать все страны (7)')
  assert.equal(await cards.count(), 6, 'Начальный список регионов должен показывать первые шесть стран')
  assert.equal((await regionCards(page))[0].code, 'DE', 'Карточки по умолчанию не отсортированы по трафику')
  assert.equal(await traffic.getAttribute('aria-pressed'), 'true')
  assert.equal((await page.locator('.country-code').first().textContent()).trim(), 'US',
    'Рейтинг карточек изменил независимый показатель карты')

  const us = panel.locator('[data-testid="region-card"][data-country="US"]')
  const initialUS = (await regionCards(page)).find((country) => country.code === 'US')
  assert.deepEqual({ download: initialUS.download, upload: initialUS.upload, total: initialUS.total, count: initialUS.count },
    { download: 121_900_000, upload: 250_000, total: 122_150_000, count: 2 },
    'Карточка не суммирует счётчики всех соединений страны')
  assert.ok(Math.abs(initialUS.share - initialUS.total / locatedTraffic * 100) < 0.05,
    'Доля трафика учитывает неизвестные страны или не соответствует объёму')
  await us.click()
  assert.equal(await us.getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('g.country[data-country="US"]').getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('.country-row').filter({ hasText: /\bUS\b/ }).getAttribute('aria-pressed'), 'true')
  assert.equal(await page.locator('tbody tr').count(), 2, 'Карточка не фильтрует хосты выбранной страны')
  await us.click()
  assert.equal(await us.getAttribute('aria-pressed'), 'false', 'Повторный выбор карточки не сбрасывает фильтр')

  // Selecting a country below the initial ranking keeps its card available.
  const hiddenCountry = page.locator('g.country[data-country="ZA"]')
  assert.equal(await panel.locator('[data-country="ZA"]').count(), 0)
  await hiddenCountry.focus()
  await page.keyboard.press('Enter')
  await panel.locator('[data-testid="region-card"][data-country="ZA"]').waitFor()
  assert.equal(await cards.count(), 6, 'Выбор страны вне топа меняет размер свёрнутого списка')
  assert.equal(await panel.locator('[data-testid="region-card"][data-country="ZA"]').getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()

  await expand.click()
  assert.equal(await expand.getAttribute('aria-expanded'), 'true')
  assert.equal(await cards.count(), 7, 'Раскрытие списка не показывает все страны')
  const all = await regionCards(page)
  assert.ok(all.every((country) => ['total', 'download', 'upload', 'count', 'share'].every((key) => Number.isFinite(country[key]))),
    'Карточки содержат нечисловые показатели')
  assert.ok(Math.abs(all.reduce((sum, country) => sum + country.share, 0) - 100) < 0.2,
    'Доли известных стран не составляют 100%')
  await connections.click()
  assert.equal(await connections.getAttribute('aria-pressed'), 'true')
  assert.equal((await regionCards(page))[0].code, 'US', 'Рейтинг по соединениям не ставит US на первое место')
  assert.ok(Math.abs((await regionCards(page))[0].share - 25) < 0.05,
    'Доля соединений должна считаться среди восьми соединений известных стран')
  await page.getByRole('radio', { name: 'Трафик', exact: true }).click()
  assert.equal(await connections.getAttribute('aria-pressed'), 'true', 'Показатель карты изменяет рейтинг карточек')
  assert.equal((await regionCards(page))[0].code, 'US', 'Показатель карты изменяет порядок карточек')
  await page.getByRole('radio', { name: 'Соединения', exact: true }).click()
  await expand.click()
  assert.equal(await expand.getAttribute('aria-expanded'), 'false')
  assert.equal(await cards.count(), 6)

  await page.getByRole('button', { name: 'Пауза', exact: true }).click()
  const frozenCards = await regionCards(page)
  const changed = [...regionFixture, sample('regions-us-3', 'card.example.com', 'US', 900_000_000)]
  sendSnapshot(changed)
  await delay(150)
  assert.deepEqual(await regionCards(page), frozenCards, 'Пауза не зафиксировала показатели карточек')
  await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
  await eventually(async () => (await regionCards(page)).find((country) => country.code === 'US')?.count === 3,
    'Продолжение не применяет новый снимок к карточкам')
  sendSnapshot(changed.filter((connection) => connection.metadata.destinationGeoIP?.[0] !== 'DE'))
  await eventually(async () => await panel.locator('[data-testid="region-card"][data-country="DE"]').count() === 0,
    'Закрытые соединения страны остаются в карточках')

  await traffic.click()
  sendSnapshot(['DE', 'US'].map((country) => ({ ...sample(`zero-${country}`, 'zero.example.com', country, 0), upload: 0 })))
  await eventually(async () => (await regionCards(page)).length === 2 && (await regionCards(page)).every((country) => country.total === 0),
    'Нулевые показатели не применились')
  assert.ok((await regionCards(page)).every((country) => country.share === 0), 'Нулевая сумма создаёт ненулевые или бесконечные доли')
  assert.ok(!/NaN|Infinity/.test(await panel.textContent()), 'В карточках видны NaN/Infinity')
  sendSnapshot([])
  await eventually(async () => await cards.count() === 0, 'Пустой снимок не удалил карточки')
  assert.ok((await panel.textContent()).trim().length > 0, 'Пустое состояние деталей стран отсутствует')
  sendSnapshot(fixture)
  await cards.first().waitFor()
  await noOverflow(page, 'Детали стран, desktop')
  await panel.screenshot({ path: path.join(out, 'region-details-light.png') })
}

async function checkMapNavigation(page, sendSnapshot) {
  const viewport = page.getByTestId('map-viewport')
  const zoomIn = page.getByRole('button', { name: 'Приблизить карту', exact: true })
  const zoomOut = page.getByRole('button', { name: 'Отдалить карту', exact: true })
  const reset = page.getByRole('button', { name: 'Показать весь мир', exact: true })
  await viewport.waitFor()
  for (const control of [zoomIn, zoomOut, reset]) {
    const bounds = await control.boundingBox()
    assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, 'Контрол карты слишком мал для нажатия')
  }
  assert.equal((await camera(page)).scale, 1)
  assert.equal(await page.getByTestId('map-zoom-value').textContent(), '100%')
  await zoomIn.click()
  await eventually(async () => (await camera(page)).scale > 1, 'Кнопка приближения не меняет масштаб')
  const zoomed = await camera(page)
  await zoomOut.click()
  await eventually(async () => (await camera(page)).scale < zoomed.scale, 'Кнопка отдаления не меняет масштаб')
  if ((await camera(page)).scale !== 1) await reset.click()

  // Зум колесом сохраняет географическую точку под курсором.
  const area = await page.getByTestId('map-svg').boundingBox()
  const anchor = { x: area.x + area.width * 0.37, y: area.y + area.height * 0.58 }
  const beforeWheel = await worldAt(page, anchor)
  await page.mouse.move(anchor.x, anchor.y)
  await page.mouse.wheel(0, -360)
  await eventually(async () => (await camera(page)).scale > 1, 'Колесо мыши не приближает карту')
  const afterWheel = await worldAt(page, anchor)
  assert.ok(Math.hypot(beforeWheel.x - afterWheel.x, beforeWheel.y - afterWheel.y) < 2,
    'Колесо мыши смещает точку под курсором')
  const beforeOutsideWheel = await camera(page)
  await page.mouse.move(80, 120)
  await page.mouse.wheel(0, -180)
  await delay(60)
  assert.deepEqual(await camera(page), beforeOutsideWheel, 'Колесо мыши за пределами карты меняет её масштаб')
  await reset.click()

  // Клавиатура и явные кнопки дают альтернативу перетаскиванию.
  await viewport.focus()
  await page.keyboard.press('+')
  await eventually(async () => (await camera(page)).scale > 1, 'Клавиша + не приближает карту')
  const beforeArrow = await camera(page)
  await page.keyboard.press('ArrowRight')
  await eventually(async () => (await camera(page)).x !== beforeArrow.x, 'Стрелка не двигает карту')
  await page.keyboard.press('Home')
  await eventually(async () => (await camera(page)).scale === 1, 'Home не возвращает весь мир')
  await zoomIn.click()
  await zoomIn.click()

  const moveMap = page.getByRole('button', { name: 'Переместить карту', exact: true })
  await moveMap.click()
  assert.equal(await moveMap.getAttribute('aria-expanded'), 'true', 'Не открылась панель перемещения')
  const beforeMoveButton = await camera(page)
  await page.getByRole('button', { name: 'Переместить вид вправо', exact: true }).click()
  await eventually(async () => (await camera(page)).x !== beforeMoveButton.x,
    'Кнопка перемещения вправо не двигает карту')
  const beforeMoveUp = await camera(page)
  await page.getByRole('button', { name: 'Переместить вид вверх', exact: true }).click()
  await eventually(async () => (await camera(page)).y !== beforeMoveUp.y,
    'Кнопка перемещения вверх не двигает карту')
  await page.keyboard.press('Escape')
  assert.equal(await moveMap.getAttribute('aria-expanded'), 'false', 'Escape не закрыл панель перемещения')
  assert.ok(await moveMap.evaluate((element) => element === document.activeElement),
    'Escape не вернул фокус кнопке перемещения')
  await reset.click()
  await zoomIn.click()
  await zoomIn.click()

  // Drag начинается на стране, но не должен превращаться в выбор этой страны.
  const dragArea = await viewport.boundingBox()
  let from
  let dragCode
  for (const marker of await page.locator('[data-marker-country] .point').all()) {
    const bounds = await marker.boundingBox()
    if (!bounds) continue
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    if (center.x > dragArea.x + 10 && center.x < dragArea.x + dragArea.width - 80 &&
      center.y > dragArea.y + 10 && center.y < dragArea.y + dragArea.height - 50) {
      from = center
      dragCode = await marker.locator('..').getAttribute('data-marker-country')
      break
    }
  }
  assert.ok(from && dragCode, 'Нет видимого маркера внутри viewport для проверки drag')
  const beforeDrag = await camera(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(from.x + 58, from.y + 29, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  await eventually(async () => (await camera(page)).x !== beforeDrag.x || (await camera(page)).y !== beforeDrag.y,
    'Перетаскивание ЛКМ не двигает карту')
  assert.equal(await page.locator(`g.country[data-country="${dragCode}"]`).getAttribute('aria-pressed'), 'false',
    'Перетаскивание случайно выбирает страну')
  const movedMarker = await page.locator(`[data-marker-country="${dragCode}"] .point`).boundingBox()
  await page.mouse.click(movedMarker.x + movedMarker.width / 2, movedMarker.y + movedMarker.height / 2)
  assert.equal(await page.locator(`g.country[data-country="${dragCode}"]`).getAttribute('aria-pressed'), 'true',
    'Обычный клик по видимой стране не работает после drag')
  await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()

  // После нового кадра соединений камера остаётся на выбранном пользователем месте.
  const preserved = await camera(page)
  sendSnapshot([...fixture, sample('navigation-ca', 'camera.example.ca', 'CA', 50_000)])
  await eventually(async () => await page.locator('.country-row').count() === 8, 'Новый снимок не применился')
  assert.deepEqual(await camera(page), preserved, 'Обновление соединений сбросило камеру карты')

  // Reset selection is in the host table, below the region cards.
  // Return to the map before sending pointer coordinates.
  await viewport.scrollIntoViewIfNeeded()
  const box = await viewport.boundingBox()
  assert.ok(box.y >= 0 && box.y + box.height <= page.viewportSize().height,
    `Карта не видна перед жестом: ${JSON.stringify(box)}`)
  const start = { x: box.x + box.width * 0.52, y: box.y + box.height * 0.58 }
  await page.mouse.move(start.x, start.y)
  const beforeRight = await camera(page)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(start.x + 35, start.y + 20, { steps: 4 })
  await page.mouse.up({ button: 'right' })
  await page.keyboard.press('Escape')
  assert.deepEqual(await camera(page), beforeRight, 'Правая кнопка мыши двигает карту')

  // Захват указателя продолжает drag за краем viewport и корректно завершается снаружи.
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(box.x + box.width + 100, start.y + 20, { steps: 8 })
  await page.mouse.up({ button: 'left' })
  const released = await camera(page)
  await page.mouse.move(start.x, start.y)
  await delay(60)
  assert.deepEqual(await camera(page), released, 'Карта продолжает двигаться после отпускания ЛКМ снаружи')
  await mapStillVisible(page, 'После выхода указателя за карту')

  // Даже первый move уже снаружи не должен оставлять незавершённый gesture.
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(box.x - 30, box.y + box.height / 2)
  await page.mouse.up({ button: 'left' })
  const beforeEdgeWheel = await camera(page)
  await page.mouse.move(start.x, start.y)
  await page.mouse.wheel(0, -100)
  await eventually(async () => (await camera(page)).scale > beforeEdgeWheel.scale,
    'Отпускание ЛКМ за краем после первого move блокирует следующие жесты')

  await viewport.focus()
  for (let index = 0; index < 16; index++) await page.keyboard.press('+')
  const maximum = await camera(page)
  assert.ok(Math.abs(maximum.scale - 8) < 0.001, `Максимальный зум: ${maximum.scale}, ожидалось 8`)
  for (let index = 0; index < 16; index++) await page.keyboard.press('-')
  const minimum = await camera(page)
  assert.ok(Math.abs(minimum.scale - 1) < 0.001, `Минимальный зум: ${minimum.scale}, ожидалось 1`)
  await zoomIn.click()
  await reset.click()
  assert.deepEqual(await camera(page), { scale: 1, x: 0, y: 0 }, 'Сброс не возвращает исходную камеру')
  await noOverflow(page, 'Зум и перетаскивание')
}

try {
  await eventually(async () => {
    try {
      return (await fetch(`${mockUrl}/version`, { headers: { Authorization: `Bearer ${secret}` } })).ok
    } catch {
      return false
    }
  }, 'Мок mihomo не запустился на порту 19091')
  assert.ok((await fetch(base)).ok, `Недоступен frontend: ${base}. Запусти npm run dev.`)

  const executablePath = [
    process.env.MIBOARD_BROWSER_PATH,
    chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate && existsSync(candidate))
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  await mkdir(out, { recursive: true })

  // Сначала проверяем настоящий WebSocket мока с его обновляющимися данными.
  {
    const { context, page } = await newPage()
    await page.goto(entry.href)
    await page.locator('.country-row').first().waitFor()
    assert.ok(await page.locator('g.country').count() > 0, 'На карте нет стран из мока')
    assert.equal(await page.locator('.unknown-stat').isEnabled(), true, 'Нет соединений без GeoIP из мока')
    await noOverflow(page, 'Мок, desktop')
    await context.close()
    console.log('✓ Подключение к моку, GeoIP и неизвестные страны')
  }

  // Управляемые кадры позволяют проверить паузу и пустые состояния без случайности.
  {
    const { context, page } = await newPage()
    let socket
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => { socket = ws })
    await page.goto(entry.href)
    await eventually(() => Boolean(socket), 'Не открыт поток соединений')
    await page.locator('.map-message').filter({ hasText: 'Получаем соединения' }).waitFor()
    socket.send(snapshot(fixture))
    await page.locator('.country-row').first().waitFor()
    assert.equal(await page.locator('.country-row').count(), 7)
    assert.equal((await page.locator('.country-code').first().textContent()).trim(), 'US')

    const us = page.locator('.country-row').filter({ hasText: /\bUS\b/ })
    const mapUs = page.locator('g.country[data-country="US"]')
    await us.click()
    assert.equal(await us.getAttribute('aria-pressed'), 'true')
    assert.equal(await mapUs.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('tbody tr').count(), 2)
    await us.click()
    assert.equal(await us.getAttribute('aria-pressed'), 'false')
    await mapUs.focus()
    await page.keyboard.press('Enter')
    assert.equal(await mapUs.getAttribute('aria-pressed'), 'true')
    await page.keyboard.press('Escape')
    assert.equal(await mapUs.getAttribute('aria-pressed'), 'false')

    await page.getByRole('radio', { name: 'Трафик', exact: true }).click()
    await eventually(async () => (await page.locator('.country-code').first().textContent()).trim() === 'DE',
      'Переключение показателя не отсортировало страны по трафику')
    await page.getByRole('radio', { name: 'Соединения', exact: true }).click()
    await page.locator('.unknown-stat').click()
    assert.equal(await page.locator('#hosts-title').textContent(), 'Без геоданных')
    assert.equal(await page.locator('tbody tr').count(), 2)
    assert.ok((await page.locator('tbody').textContent()).includes('192.168.1.1'))
    await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()

    await page.getByRole('button', { name: 'Пауза', exact: true }).click()
    const frozenStats = await page.locator('.geo-stats').textContent()
    socket.send(snapshot([...fixture, sample('ca-1', 'api.example.ca', 'CA', 21_700_000)]))
    await delay(150)
    assert.equal(await page.locator('.geo-stats').textContent(), frozenStats, 'Пауза изменила показанный снимок')
    assert.equal(await page.locator('.country-row').count(), 7)
    await page.getByRole('button', { name: 'Продолжить', exact: true }).click()
    await eventually(async () => await page.locator('.country-row').count() === 8, 'Продолжение не применило свежий снимок')

    socket.send(snapshot(fixture.filter((connection) => !connection.metadata.destinationGeoIP)))
    await eventually(async () => await page.locator('g.country').count() === 0, 'Не очищены страны для снимка без геоданных')
    await page.locator('.map-message').waitFor()
    socket.send(snapshot([]))
    await page.locator('.map-message').filter({ hasText: 'Нет активных соединений' }).waitFor()
    assert.equal(await page.locator('.country-row').count(), 0)
    assert.equal(await page.locator('.unknown-stat').isDisabled(), true)
    await context.close()
    console.log('✓ Выбор страны, клавиатура, показатели, пауза, неизвестные и пустой снимок')
  }

  // Навигация картой проверяется на реальных событиях указателя, колеса и клавиатуры.
  {
    const { context, page } = await newPage()
    let socket
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => { socket = ws; ws.send(snapshot(fixture)) })
    await page.goto(entry.href)
    await page.locator('.country-row').first().waitFor()
    await checkLightContrast(page)
    await checkMapNavigation(page, (connections) => socket.send(snapshot(connections)))
    await context.close()
    console.log('✓ Зум кнопками/колесом/клавиатурой, ЛКМ drag, границы и сохранение камеры')
  }

  // Карточки регионов используют текущий снимок и связаны с выбором страны.
  {
    const { context, page } = await newPage()
    let socket
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => { socket = ws })
    await page.goto(entry.href)
    await eventually(() => Boolean(socket), 'Не открыт поток для деталей стран')
    await page.getByTestId('region-details').waitFor()
    assert.equal(await page.getByTestId('region-card').count(), 0, 'Во время загрузки показаны выдуманные карточки')
    await checkRegionDetails(page, (connections) => socket.send(snapshot(connections)))
    await context.close()
    console.log('✓ Детали стран: суммы и доли, независимый рейтинг, выбор, пауза, пустой и нулевой снимок')
  }

  // Реальная локальная база + DNS только через контроллер, даже без destinationGeoIP.
  {
    const database = new GeoDatabase(gunzipSync(await readFile(path.join(root, 'public/geodb/country.bin.gz'))))
    const ipv6Country = database.lookup('2606:4700:4700::1111')
    assert.ok(ipv6Country, 'Тестовый публичный IPv6 отсутствует в GeoDB')
    const fallback = [
      sample('ip-v4', 'public-ip.example.test', null, 500_000, '8.8.8.8'),
      sample('ip-v6', 'public-v6.example.test', null, 600_000, '2606:4700:4700::1111'),
      sample('dns', 'dns-only.miboard.example.com', null, 700_000, ''),
      sample('private', 'private.miboard.example.com', null, 800_000, '192.168.1.1'),
      sample('fake', 'fake-ip.miboard.example.com', null, 900_000, '198.18.1.2'),
      sample('native', 'native.example.test', 'DE', 1_000_000, '8.8.8.8'),
      sample('dns-v6', 'ipv6-only.miboard.example.com', null, 1_100_000, ''),
    ]
    const { context, page } = await newPage()
    let socket
    const dnsRequests = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/dns/query') dnsRequests.push({ origin: url.origin, name: url.searchParams.get('name'), type: url.searchParams.get('type') })
    })
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => { socket = ws; ws.send(snapshot(fallback)) })
    await page.goto(entry.href)
    const sources = page.getByTestId('geo-sources')
    await eventually(async () => await sources.getAttribute('data-dns') === '3' && await sources.getAttribute('data-pending') === '0',
      'DNS/GeoDB не определили страны без метаданных ядра', 20_000)
    assert.equal(await sources.getAttribute('data-metadata'), '1')
    assert.equal(await sources.getAttribute('data-ip'), '2')
    assert.ok(await page.locator('g.country[data-country="US"]').count() > 0, 'IPv4 не отмечен на карте')
    assert.ok(await page.locator(`g.country[data-country="${ipv6Country}"]`).count() > 0, 'IPv6 не отмечен на карте')
    const de = page.locator('g.country[data-country="DE"]')
    await de.focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('tbody tr').count(), 1, 'Страна из ядра не имеет приоритета перед GeoDB')
    assert.ok((await page.locator('tbody').textContent()).includes('native.example.test'))
    await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()
    await page.locator('.unknown-stat').click()
    assert.equal(await page.locator('tbody tr').count(), 1, 'Частный IP ошибочно определён по DNS')
    assert.ok((await page.locator('tbody').textContent()).includes('private.miboard.example.com'))
    await page.getByRole('button', { name: 'Сбросить выбор страны' }).click()
    assert.ok(dnsRequests.length >= 4, 'Не проверен fallback A → AAAA')
    assert.ok(dnsRequests.every((request) => request.origin === mockUrl), 'DNS отправлен за пределы подключённого контроллера')
    assert.deepEqual(new Set(dnsRequests.map((request) => request.name)), new Set(['dns-only.miboard.example.com', 'fake-ip.miboard.example.com', 'ipv6-only.miboard.example.com']))
    assert.ok(dnsRequests.some((request) => request.name === 'ipv6-only.miboard.example.com' && request.type === 'AAAA'))
    const requestsBefore = dnsRequests.length
    for (let i = 0; i < 4; i++) socket.send(snapshot(fallback))
    await delay(150)
    assert.equal(dnsRequests.length, requestsBefore, 'Повторные снимки обошли DNS-кэш')
    await page.getByRole('button', { name: 'Пауза', exact: true }).click()
    const frozen = await page.locator('.geo-stats').textContent()
    socket.send(snapshot([]))
    await delay(150)
    assert.equal(await page.locator('.geo-stats').textContent(), frozen, 'Пауза не сохранила результаты GeoDB/DNS')
    assert.equal(dnsRequests.length, requestsBefore, 'Пауза повторно запросила DNS')
    await noOverflow(page, 'GeoDB/DNS, desktop')
    await page.screenshot({ path: path.join(out, 'geography-geodb-dns.png'), fullPage: true })
    await context.close()
    console.log('✓ Локальная GeoDB IPv4/IPv6, DNS через ядро, fake-IP, приоритет метаданных и кэш')
  }

  // Ошибка загрузки базы видна; native GeoIP работает, повтор восстанавливает fallback.
  {
    const { context, page, expectedFailures } = await newPage()
    expectedFailures.push('country.bin.gz')
    await page.route('**/geodb/country.bin.gz', (route) => route.fulfill({ status: 503, body: 'Temporary test failure' }))
    const recoverable = [sample('native-error', 'native.example.test', 'DE', 100_000), sample('ip-error', 'ip.example.test', null, 200_000, '8.8.8.8')]
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => ws.send(snapshot(recoverable)))
    await page.goto(entry.href)
    await page.getByTestId('geo-db-error').waitFor()
    assert.equal(await page.locator('g.country[data-country="DE"]').count(), 1, 'Ошибка GeoDB отключила данные ядра')
    assert.equal(await page.locator('g.country[data-country="US"]').count(), 0)
    await page.unroute('**/geodb/country.bin.gz')
    // Статика mihomo не добавляет Content-Encoding: браузер должен распаковать .gz сам.
    const compressedDatabase = await readFile(path.join(root, 'public/geodb/country.bin.gz'))
    await page.route('**/geodb/country.bin.gz', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: compressedDatabase }))
    await page.getByRole('button', { name: 'Повторить', exact: true }).click()
    await page.locator('g.country[data-country="US"]').waitFor()
    assert.equal(await page.getByTestId('geo-db-error').count(), 0, 'Ошибка GeoDB осталась после успешного повтора')
    await context.close()
    console.log('✓ Ошибка загрузки GeoDB, сохранение native GeoIP и успешный повтор')
  }

  {
    const { context, page } = await newPage(undefined, 'light', 'en')
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => ws.send(snapshot(fixture)))
    await page.goto(entry.href)
    await page.getByRole('heading', { name: 'Geography', exact: true }).waitFor()
    await page.locator('.country-row').filter({ hasText: 'Germany' }).waitFor()
    await page.locator('.country-row').filter({ hasText: 'Netherlands' }).waitFor()
    const regions = page.getByTestId('region-details')
    await regions.getByRole('heading', { name: /region details/i }).waitFor()
    assert.ok((await regions.textContent()).includes('Germany'), 'Имена стран в деталях не переключились на English')
    assert.equal(await page.getByTestId('region-metric-traffic').getAttribute('aria-label'), 'Rank regions by traffic')
    await regions.getByRole('button', { name: 'Rank regions by connections', exact: true }).click()
    assert.equal(await page.getByTestId('region-metric-connections').getAttribute('aria-pressed'), 'true')
    await page.getByRole('radio', { name: 'Traffic', exact: true }).click()
    assert.equal(await page.getByRole('radio', { name: 'Traffic', exact: true }).getAttribute('aria-checked'), 'true')
    await page.getByRole('radio', { name: 'Connections', exact: true }).click()
    assert.equal(await page.getByRole('radio', { name: 'Connections', exact: true }).getAttribute('aria-checked'), 'true')
    await context.close()
    console.log('✓ Английская локализация: заголовок, страны и переключение показателя')
  }

  for (const colorScheme of ['light', 'dark']) {
    for (const width of [1920, 1440, 390]) {
      const { context, page } = await newPage({ width, height: width === 390 ? 844 : 1000 }, colorScheme)
      await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => ws.send(snapshot(fixture)))
      await page.goto(entry.href)
      await page.locator('.country-row').first().waitFor()
      await page.evaluate(() => document.fonts.ready)
      await noOverflow(page, `${colorScheme} ${width}px`)
      await checkDenseMarkers(page, `${colorScheme} ${width}px`)
      if (colorScheme === 'light') await checkLightContrast(page)
      await page.screenshot({ path: path.join(out, `geography-${colorScheme}-${width}.png`), fullPage: true })
      const regions = page.getByTestId('region-details')
      await regions.getByTestId('region-card').first().waitFor()
      const cardWidths = await regions.locator('.region-main').evaluateAll((elements) => elements.map((element) => ({
        client: element.clientWidth, scroll: element.scrollWidth,
      })))
      assert.ok(cardWidths.every(({ client, scroll }) => scroll <= client + 1),
        `${colorScheme} ${width}px: сумма и доля выходят за границы карточки: ${JSON.stringify(cardWidths)}`)
      if (width === 1920) {
        const cardRows = await regions.getByTestId('region-card').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))
        assert.ok(cardRows.every((top) => Math.abs(top - cardRows[0]) < 1), 'На широком экране шесть карточек не выстроились в ряд')
      }
      // Sticky app navigation crosses a tall element screenshot on narrow screens.
      await regions.screenshot({ path: path.join(out, `region-details-${colorScheme}-${width}.png`), style: '.sticky, nav.fixed { visibility: hidden !important; }' })
      await page.getByRole('button', { name: 'Приблизить карту', exact: true }).click()
      await page.getByRole('button', { name: 'Приблизить карту', exact: true }).click()
      await page.screenshot({ path: path.join(out, `geography-${colorScheme}-${width}-zoom.png`), fullPage: true })
      await context.close()
    }
  }
  {
    const { context, page } = await newPage({ width: 320, height: 844 })
    await page.routeWebSocket(/\/connections(?:\?|$)/, (ws) => ws.send(snapshot(fixture)))
    await page.goto(entry.href)
    const regions = page.getByTestId('region-details')
    await regions.getByTestId('region-card').first().waitFor()
    await noOverflow(page, 'Детали стран, 320px')
    await page.getByTestId('region-show-all').click()
    assert.equal(await regions.getByTestId('region-card').count(), 7)
    await noOverflow(page, 'Все страны, 320px')
    await context.close()
  }
  assert.deepEqual(errors, [], `Ошибки браузера:\n${errors.join('\n')}`)
  assert.deepEqual(externalRequests, [], 'Страница отправила запрос за пределы localhost/контроллера')
  console.log(`✓ 1920/1440/390/320px, светлая/тёмная темы, без горизонтального скролла и ошибок браузера\nСкриншоты: ${out}`)
} catch (error) {
  console.error('Ошибки браузера:', errors)
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      await page.screenshot({ path: path.join(out, 'geography-failure.png'), fullPage: true }).catch(() => {})
      console.error('Страница:', page.url(), (await page.locator('body').textContent().catch(() => '')).slice(0, 1200))
    }
  }
  throw error
} finally {
  await browser?.close()
  if (mock.exitCode === null) {
    const exited = once(mock, 'exit')
    mock.kill()
    await Promise.race([exited, delay(5000, undefined, { ref: false })])
  }
}
