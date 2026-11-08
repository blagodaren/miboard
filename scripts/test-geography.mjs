import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countryName, destinationCountry, summarizeGeography } from '../src/lib/geography.ts'

const connection = (codes, options = {}) => ({
  id: 'connection',
  metadata: {
    network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '50000',
    destinationIP: '1.1.1.1', destinationPort: '443', host: 'example.ru',
    destinationGeoIP: codes,
  },
  upload: 10, download: 100, start: '2026-11-08T00:00:00Z', chains: ['nl-ams-01'],
  rule: 'GeoIP', rulePayload: 'ru', dl: 4, ul: 2,
  ...options,
})

test('страна берётся из метаданных назначения, без догадок по домену, правилу и прокси', () => {
  assert.equal(destinationCountry(connection([' de '])), 'DE')
  for (const codes of [undefined, null, [], ['private'], ['ZZ'], ['EU'], 'US']) {
    assert.equal(destinationCountry(connection(codes)), null)
  }
  assert.equal(destinationCountry(connection(['cloudflare', 'us'])), 'US')
  assert.equal(countryName('DE'), 'Германия')
  assert.equal(countryName('DE', 'en-US'), 'Germany')
  assert.equal(countryName('DE', 'ru-RU'), 'Германия')
})

test('несколько меток GeoIP не дублируют активное соединение', () => {
  const summary = summarizeGeography([connection(['us', 'us', 'ca']), connection(['US'])])
  assert.equal(summary.total, 2)
  assert.equal(summary.located, 2)
  assert.equal(summary.unknown, 0)
  assert.deepEqual(summary.countries.map(({ code, count }) => ({ code, count })), [{ code: 'US', count: 2 }])
  assert.equal(summary.countries[0].download, 200)
  assert.equal(summary.countries[0].upload, 20)
  assert.equal(summary.countries[0].dl, 8)
  assert.equal(summary.countries[0].ul, 4)
})

test('неизвестные страны входят в общие итоги, без привязки к карте', () => {
  const summary = summarizeGeography([connection(['DE']), connection(null, { download: 500, upload: 40 })])
  assert.equal(summary.total, 2)
  assert.equal(summary.located, 1)
  assert.equal(summary.unknown, 1)
  assert.equal(summary.download, 600)
  assert.equal(summary.upload, 50)
  assert.equal(summary.countries[0].download, 100)
})

test('повторный снимок не накапливает соединения; пустой сбрасывает итоги', () => {
  const current = [connection(['US']), connection(['DE']), connection(['DE'])]
  assert.deepEqual(summarizeGeography(current), summarizeGeography(current))
  assert.deepEqual(summarizeGeography(current).countries.map((c) => c.code), ['DE', 'US'])
  assert.equal(summarizeGeography([connection(['JP'])]).countries.length, 1)
  assert.deepEqual(summarizeGeography([]), {
    countries: [], total: 0, located: 0, unknown: 0, download: 0, upload: 0,
  })
})

test('некорректные счётчики трафика не ломают масштаб и итоги', () => {
  const summary = summarizeGeography([connection(['US'], { download: NaN, upload: -5, dl: Infinity, ul: -1 })])
  assert.equal(summary.download, 0)
  assert.equal(summary.upload, 0)
  assert.equal(summary.countries[0].dl, 0)
  assert.equal(summary.countries[0].ul, 0)
})

test('локальное определение дополняет отсутствующий GeoIP, сохраняя приоритет ядра и общие итоги', () => {
  const fallback = () => 'US'
  assert.equal(destinationCountry(connection(['DE']), fallback), 'DE')
  assert.equal(destinationCountry(connection(null), fallback), 'US')
  assert.equal(destinationCountry(connection(null), () => 'ZZ'), null)
  const summary = summarizeGeography([connection(null), connection(['DE'])], fallback)
  assert.equal(summary.located, 2)
  assert.equal(summary.unknown, 0)
  assert.equal(summary.download, 200)
  assert.deepEqual(summary.countries.map(({ code }) => code).sort(), ['DE', 'US'])
})
