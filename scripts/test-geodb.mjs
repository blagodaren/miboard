import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { GeoDatabase, publicIp } from '../src/lib/geo-db.ts'

const compressed = readFileSync(new URL('../public/geodb/country.bin.gz', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../public/geodb/manifest.json', import.meta.url), 'utf8'))
const unpacked = gunzipSync(compressed)
const database = new GeoDatabase(unpacked)

test('bundled GeoDB matches manifest, validates real IPv4 and IPv6 samples', () => {
  assert.equal(compressed.length, manifest.bytes)
  assert.equal(unpacked.length, manifest.unpackedBytes)
  assert.equal(createHash('sha256').update(compressed).digest('hex'), manifest.sha256)
  assert.equal(database.lookup('8.8.8.8'), 'US')
  assert.equal(database.lookup('1.1.1.1'), 'AU')
  // DB-IP's country, rather than an inference from Telegram's corporate address.
  assert.equal(database.lookup('149.154.167.51'), 'GB')
  assert.equal(database.lookup('2001:4860:4860::8888'), 'CA')
  assert.equal(database.lookup('2606:4700:4700::1111'), 'US')
  assert.equal(database.lookup('::ffff:8.8.8.8'), database.lookup('8.8.8.8'))
  assert.equal(database.lookup('2606:4700:4700:0:0:0:0:1111'), database.lookup('2606:4700:4700::1111'))
})

test('private, fake, documentation and special-use IPs never acquire a false country', () => {
  for (const address of [
    '0.0.0.0', '10.23.4.5', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.3.4', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.1',
    '192.0.2.42', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.9',
    '203.0.113.9', '224.0.0.1', '239.1.2.3', '255.255.255.255',
    '::', '::1', '::ffff:192.168.1.1', '::ffff:c612:1', 'fc00::1', 'fd12::1',
    'fe80::1', 'ff02::1', '64:ff9b::808:808', '2001:db8::1', '2001:2::1',
    '2001:10::1', '2001:20::1', '3fff::1',
  ]) {
    assert.equal(publicIp(address), null, address)
    assert.equal(database.lookup(address), null, address)
  }
})

test('strict literals normalize brackets, IPv6 compression and IPv4-mapped IPv6', () => {
  assert.equal(publicIp(' 8.8.8.8 '), '8.8.8.8')
  assert.equal(publicIp('[2606:4700:4700::1111]'), '2606:4700:4700:0:0:0:0:1111')
  assert.equal(publicIp('::FFFF:8.8.8.8'), '8.8.8.8')
  assert.equal(publicIp('::ffff:0808:0808'), '8.8.8.8')
  for (const address of [undefined, null, {}, 1234, '', 'example.com', '8.8.8.8:53',
    '008.8.8.8', '256.1.1.1', '1.1.1', '1.1.1.1.1', '1e1.1.1.1',
    '[::1]:53', '2606::4700::1111', '2606:::1111', '2606:4700::1111%eth0',
    '2606:4700:4700:0:0:0:1111', '2606:4700:4700:0:0:0:0:0:1111',
    '2606:4700:4700:0:0:0:0:xyz', '2606:4700:4700:0:0:0:0:11111']) {
    assert.equal(publicIp(address), null, String(address))
  }
  assert.equal(publicIp('100.63.255.255'), '100.63.255.255')
  assert.equal(publicIp('100.128.0.0'), '100.128.0.0')
  assert.equal(publicIp('172.15.255.255'), '172.15.255.255')
  assert.equal(publicIp('172.32.0.0'), '172.32.0.0')
  assert.equal(publicIp('198.17.255.255'), '198.17.255.255')
  assert.equal(publicIp('198.20.0.0'), '198.20.0.0')
})

function number6(ip) {
  const [left, right = ''] = ip.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  return [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
    .reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n)
}

function fixture(v4, v6 = []) {
  const countries = ['ZZ', 'AU', 'US']
  const header = Buffer.alloc(14)
  header.write('MIG1')
  header.writeUInt16LE(countries.length, 4)
  header.writeUInt32LE(v4.length, 6)
  header.writeUInt32LE(v6.length, 10)
  const bytes = [...header, ...Buffer.from(countries.join(''))]
  for (const family of [v4, v6]) {
    let previous = -1n
    for (const [endpoint, country] of family) {
      let delta = BigInt(endpoint) - previous
      while (delta > 127n) { bytes.push(Number(delta & 127n) | 128); delta >>= 7n }
      bytes.push(Number(delta), countries.indexOf(country))
      previous = BigInt(endpoint)
    }
  }
  return Uint8Array.from(bytes)
}

test('inclusive range boundaries and unknown gaps work in both address families', () => {
  const start6 = number6('2606:4700:4700::1111')
  const end6 = number6('2606:4700:4700::2222')
  const bytes = fixture(
    [[0x010100ff, 'ZZ'], [0x010101ff, 'AU'], [0xffffffff, 'ZZ']],
    [[start6 - 1n, 'ZZ'], [end6, 'US'], [(1n << 128n) - 1n, 'ZZ']],
  )
  const db = new GeoDatabase(bytes)
  assert.equal(db.lookup('1.1.0.255'), null)
  assert.equal(db.lookup('1.1.1.0'), 'AU')
  assert.equal(db.lookup('1.1.1.255'), 'AU')
  assert.equal(db.lookup('1.1.2.0'), null)
  assert.equal(db.lookup('2606:4700:4700::1110'), null)
  assert.equal(db.lookup('2606:4700:4700::1111'), 'US')
  assert.equal(db.lookup('2606:4700:4700::2222'), 'US')
  assert.equal(db.lookup('2606:4700:4700::2223'), null)
  assert.equal(new GeoDatabase(fixture([[0xffffffff, 'ZZ']])).lookup('2606:4700:4700::1111'), null)
})

test('malformed, truncated and incompatible payloads fail before lookup', () => {
  const valid = fixture([[0x010100ff, 'ZZ'], [0x010101ff, 'AU'], [0xffffffff, 'ZZ']])
  const mutated = (change) => { const bytes = valid.slice(); change(bytes); return bytes }
  for (const bytes of [new Uint8Array(), valid.slice(0, 13), valid.slice(0, -1),
    mutated((bytes) => { bytes[3] = 50 }),
    mutated((bytes) => { bytes[14] = 49 }),
    mutated((bytes) => { bytes[bytes.length - 1] = 255 }),
    mutated((bytes) => { bytes[20] = 0 }),
    Uint8Array.from([...valid, 0]), fixture([[0x010101ff, 'AU']]),
  ]) assert.throws(() => new GeoDatabase(bytes), /Invalid offline GeoIP database/)
  const hugeCount = valid.slice()
  new DataView(hugeCount.buffer).setUint32(6, 0xffffffff, true)
  assert.throws(() => new GeoDatabase(hugeCount), /Invalid offline GeoIP database/)
})

test('loader handles plain and HTTP-decoded gzip assets, caches success and retries failure', async () => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  globalThis.document = { baseURI: 'http://127.0.0.1:9090/ui/miboard/' }
  try {
    let calls = 0
    globalThis.fetch = async (url, options) => {
      assert.equal(url.href, 'http://127.0.0.1:9090/ui/miboard/geodb/country.bin.gz')
      assert.ok(options.signal instanceof AbortSignal)
      calls++
      return calls === 1 ? new Response('missing', { status: 404 }) : new Response(compressed)
    }
    const packedModule = await import('../src/lib/geo-db.ts?loader-packed')
    await assert.rejects(packedModule.loadGeoDatabase(), /Cannot load/)
    const pending = packedModule.loadGeoDatabase()
    assert.equal(pending, packedModule.loadGeoDatabase())
    assert.equal((await pending).lookup('8.8.8.8'), 'US')
    assert.equal(calls, 2)
    assert.equal(await packedModule.loadGeoDatabase(), await pending)
    assert.equal(calls, 2)

    // Vite sets Content-Encoding:gzip on *.gz files. fetch has already decoded
    // their body, while mihomo's plain file server may send the gzip as bytes.
    globalThis.fetch = async () => new Response(unpacked, { headers: { 'Content-Encoding': 'gzip' } })
    const plainModule = await import('../src/lib/geo-db.ts?loader-http-decoded')
    assert.equal((await plainModule.loadGeoDatabase()).lookup('8.8.8.8'), 'US')
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

test('failed database generation preserves the committed asset and manifest', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'miboard-geodb-invalid-'))
  const source = path.join(directory, 'invalid.csv.gz')
  const manifestBefore = readFileSync(new URL('../public/geodb/manifest.json', import.meta.url))
  try {
    // Valid gzip/CSV, but incomplete coverage: it must never replace the full DB.
    writeFileSync(source, gzipSync('0.0.0.0,255.255.255.255,US\n'))
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./update-geodb.mjs', import.meta.url)), '2026-11', '--source-file', source,
    ], { encoding: 'utf8', windowsHide: true })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unexpected DB-IP coverage/)
    assert.deepEqual(readFileSync(new URL('../public/geodb/country.bin.gz', import.meta.url)), compressed)
    assert.deepEqual(readFileSync(new URL('../public/geodb/manifest.json', import.meta.url)), manifestBefore)
  } finally {
    unlinkSync(source)
    rmdirSync(directory)
  }
})
