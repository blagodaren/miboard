import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { GeoDatabase, publicIp } from '../src/lib/geo-db.ts'
import { compileCountryCsv } from './geodb-compiler.mjs'

const compressed = readFileSync(new URL('../public/geodb/country.bin.gz', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../public/geodb/manifest.json', import.meta.url), 'utf8'))
const unpacked = gunzipSync(compressed)
const database = new GeoDatabase(unpacked)

test('bundled GeoDB matches manifest and resolves public IPv4 and IPv6 samples', () => {
  assert.equal(manifest.provider, 'DB-IP Country Lite')
  assert.equal(manifest.license, 'CC-BY-4.0')
  assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/)
  assert.equal(compressed.length, manifest.bytes)
  assert.equal(unpacked.length, manifest.unpackedBytes)
  assert.equal(createHash('sha256').update(compressed).digest('hex'), manifest.sha256)
  const header = new DataView(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength)
  assert.equal(header.getUint16(4, true), manifest.countries)
  assert.equal(header.getUint32(6, true), manifest.ranges.ipv4)
  assert.equal(header.getUint32(10, true), manifest.ranges.ipv6)
  for (const ip of ['8.8.8.8', '1.1.1.1', '149.154.167.51', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.match(database.lookup(ip) ?? '', /^[A-Z]{2}$/, ip)
  }
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
      assert.equal(options.cache, 'no-cache')
      calls++
      return calls === 1 ? new Response('missing', { status: 404 }) : new Response(compressed)
    }
    const packedModule = await import('../src/lib/geo-db.ts?loader-packed')
    await assert.rejects(packedModule.loadGeoDatabase(), /Cannot load/)
    const pending = packedModule.loadGeoDatabase()
    assert.equal(pending, packedModule.loadGeoDatabase())
    assert.equal((await pending).lookup('8.8.8.8'), database.lookup('8.8.8.8'))
    assert.equal(calls, 2)
    assert.equal(await packedModule.loadGeoDatabase(), await pending)
    assert.equal(calls, 2)

    // Vite sets Content-Encoding:gzip on *.gz files. fetch has already decoded
    // their body, while mihomo's plain file server may send the gzip as bytes.
    globalThis.fetch = async () => new Response(unpacked, { headers: { 'Content-Encoding': 'gzip' } })
    const plainModule = await import('../src/lib/geo-db.ts?loader-http-decoded')
    assert.equal((await plainModule.loadGeoDatabase()).lookup('8.8.8.8'), database.lookup('8.8.8.8'))
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})

const fixtureCsv = {
  ipv4: '"1.1.1.0","1.1.1.127","AU"\r\n1.1.1.128,1.1.1.255,AU\n1.1.3.0,1.1.3.255,US\n',
  ipv6: '"2606:4700::","2606:4700::ff","AU"\r\n2606:4700::100,2606:4700::1ff,AU\n2606:4700::300,2606:4700::3ff,US\n',
}

test('CSV compiler fills unknown gaps and coalesces adjacent countries in both families', () => {
  const compiled = compileCountryCsv(fixtureCsv.ipv4, fixtureCsv.ipv6)
  assert.ok(compiled.binary instanceof Uint8Array)
  assert.deepEqual(compiled.sourceRows, { ipv4: 3, ipv6: 3 })
  assert.deepEqual(compiled.ranges, { ipv4: 5, ipv6: 5 })
  assert.equal(compiled.countries, 3)
  const db = new GeoDatabase(compiled.binary)
  for (const [ip, country] of [
    ['1.1.0.255', null], ['1.1.1.0', 'AU'], ['1.1.1.127', 'AU'],
    ['1.1.1.128', 'AU'], ['1.1.1.255', 'AU'], ['1.1.2.0', null],
    ['1.1.2.255', null], ['1.1.3.0', 'US'], ['1.1.3.255', 'US'], ['1.1.4.0', null],
    ['2606:46ff:ffff:ffff:ffff:ffff:ffff:ffff', null], ['2606:4700::', 'AU'],
    ['2606:4700::ff', 'AU'], ['2606:4700::100', 'AU'], ['2606:4700::1ff', 'AU'],
    ['2606:4700::200', null], ['2606:4700::2ff', null],
    ['2606:4700::300', 'US'], ['2606:4700::3ff', 'US'], ['2606:4700::400', null],
  ]) assert.equal(db.lookup(ip), country, ip)
})

test('decimal and literal CSVs produce the same deterministic binary', () => {
  const number4 = (ip) => ip.split('.').reduce((value, part) => value * 256n + BigInt(part), 0n)
  const decimalCsv = (csv, number) => csv.trim().split(/\r?\n/).map((line) => {
    const [first, last, country] = line.replaceAll('"', '').split(',')
    return `"${number(first)}","${number(last)}","${country}"`
  }).join('\n')
  const literal = compileCountryCsv(fixtureCsv.ipv4, fixtureCsv.ipv6)
  const decimal = compileCountryCsv(decimalCsv(fixtureCsv.ipv4, number4), decimalCsv(fixtureCsv.ipv6, number6))
  assert.deepEqual(decimal, literal)
  assert.deepEqual(compileCountryCsv(fixtureCsv.ipv4, fixtureCsv.ipv6), literal)
})

test('CSV compiler accepts inclusive minimum and maximum endpoints', () => {
  const compiled = compileCountryCsv('0,4294967295,US\n', `0,${(1n << 128n) - 1n},AU\n`)
  assert.deepEqual(compiled.ranges, { ipv4: 1, ipv6: 1 })
  const db = new GeoDatabase(compiled.binary)
  assert.equal(db.lookup('1.1.1.1'), 'US')
  assert.equal(db.lookup('223.255.255.255'), 'US')
  assert.equal(db.lookup('2000::'), 'AU')
  assert.equal(db.lookup('3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), 'AU')
  assert.equal(db.lookup('127.0.0.1'), null)
  assert.equal(db.lookup('2001:db8::1'), null)
})

test('CSV compiler rejects malformed, overlapping, unsorted and out-of-family ranges', () => {
  for (const invalid of [
    '', '\n',
    '1.1.1.0,1.1.1.100,US\n1.1.1.100,1.1.1.200,AU\n',
    '1.1.1.128,1.1.1.255,US\n1.1.1.0,1.1.1.127,AU\n',
    '1.1.1.255,1.1.1.0,US\n', '1.1.1.0,1.1.1.255,us\n',
    '1.1.1.0,1.1.1.255,U\n', '1.1.1.0,1.1.1.255,USA\n', '1.1.1.0,1.1.1.255,\n',
    '1.1.1.0,1.1.1.255,US,extra\n', '"1.1.1.0,1.1.1.255,US\n',
    '256.1.1.0,256.1.1.255,US\n', '001.1.1.0,1.1.1.255,US\n',
    '-1,10,US\n', '0,4294967296,US\n',
    '2606:4700::,2606:4700::ff,US\n', '1.1.1.0,2606:4700::ff,US\n',
  ]) assert.throws(() => compileCountryCsv(invalid, fixtureCsv.ipv6), undefined, invalid)
  for (const invalid of [
    '', '\n',
    '2606:4700::100,2606:4700::1ff,US\n2606:4700::,2606:4700::ff,AU\n',
    '2606:4700::,2606:4700::ff,US\n2606:4700::ff,2606:4700::1ff,AU\n',
    '2606::4700::,2606:4700::ff,US\n', '2606:4700::100,2606:4700::ff,US\n',
    `0,${1n << 128n},US\n`, '-1,10,US\n', '1.1.1.0,1.1.1.255,US\n',
  ]) assert.throws(() => compileCountryCsv(fixtureCsv.ipv4, invalid), undefined, invalid)
})

function runGenerator(sourceFile, outputDirectory, releaseArgs = ['2026-11'], extraArgs = []) {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./update-geodb.mjs', import.meta.url)),
    ...releaseArgs, '--source-file', sourceFile, '--output-dir', outputDirectory,
    '--generated-at', '2026-11-08T00:00:00.000Z',
    ...extraArgs,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.ifError(result.error)
  return result
}

test('DB-IP CLI accepts equivalent release forms and preserves assets after source or checksum failure', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'miboard-geodb-fixture-'))
  const sourceFile = path.join(directory, 'combined.csv.gz')
  const destination = path.join(directory, 'assets')
  const repeatedDestination = path.join(directory, 'repeated-assets')
  const unverifiedDestination = path.join(directory, 'unverified-assets')
  const readAsset = (name, output = destination) => readFileSync(path.join(output, name))
  try {
    const source = gzipSync(fixtureCsv.ipv4 + fixtureCsv.ipv6)
    const sourceSha256 = createHash('sha256').update(source).digest('hex')
    const checksumArgs = ['--source-sha256', sourceSha256]
    writeFileSync(sourceFile, source)
    const compiled = compileCountryCsv(fixtureCsv.ipv4, fixtureCsv.ipv6)
    const generated = runGenerator(sourceFile, destination, ['2026-11'], checksumArgs)
    assert.equal(generated.status, 0, generated.stderr || generated.stdout)
    const assetBefore = readAsset('country.bin.gz')
    const manifestBefore = readAsset('manifest.json')
    const generatedManifest = JSON.parse(manifestBefore)
    assert.deepEqual(gunzipSync(assetBefore), Buffer.from(compiled.binary))
    assert.equal(generatedManifest.format, 'MIG1')
    assert.equal(generatedManifest.provider, 'DB-IP Country Lite')
    assert.equal(generatedManifest.release, '2026-11')
    assert.equal(generatedManifest.source, 'https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz')
    assert.equal(generatedManifest.sourceSha256, sourceSha256)
    assert.equal(generatedManifest.sourceBytes, source.length)
    assert.equal(generatedManifest.sourceChecksumVerified, true)
    assert.equal(generatedManifest.license, 'CC-BY-4.0')
    assert.match(generatedManifest.attribution, /DB-IP/)
    assert.equal(generatedManifest.attributionUrl, 'https://db-ip.com')
    assert.equal(generatedManifest.attributionRequired, true)
    assert.equal(generatedManifest.generatedAt, '2026-11-08T00:00:00.000Z')
    assert.equal(generatedManifest.bytes, assetBefore.length)
    assert.equal(generatedManifest.unpackedBytes, compiled.binary.length)
    assert.equal(generatedManifest.sha256, createHash('sha256').update(assetBefore).digest('hex'))
    assert.deepEqual(generatedManifest.ranges, compiled.ranges)
    assert.deepEqual(generatedManifest.sourceRows, compiled.sourceRows)
    assert.equal(generatedManifest.countries, compiled.countries)
    const repeated = runGenerator(sourceFile, repeatedDestination, ['--release', '2026-11'], checksumArgs)
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout)
    assert.deepEqual(readAsset('country.bin.gz', repeatedDestination), assetBefore)
    assert.deepEqual(readAsset('manifest.json', repeatedDestination), manifestBefore)

    const unverified = runGenerator(sourceFile, unverifiedDestination)
    assert.equal(unverified.status, 0, unverified.stderr || unverified.stdout)
    assert.equal(JSON.parse(readAsset('manifest.json', unverifiedDestination)).sourceChecksumVerified, false)
    assert.deepEqual(readAsset('country.bin.gz', unverifiedDestination), assetBefore)

    writeFileSync(sourceFile, gzipSync(fixtureCsv.ipv4 + '2606:4700::100,2606:4700::ff,US\n'))
    const invalid = runGenerator(sourceFile, destination)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stderr, /invalid|range|CSV/i)
    assert.deepEqual(readAsset('country.bin.gz'), assetBefore)
    assert.deepEqual(readAsset('manifest.json'), manifestBefore)

    writeFileSync(sourceFile, source)
    const wrongChecksum = runGenerator(sourceFile, destination, ['2026-11'], ['--source-sha256', '0'.repeat(64)])
    assert.notEqual(wrongChecksum.status, 0)
    assert.match(wrongChecksum.stderr, /checksum|sha-?256|digest/i)
    assert.deepEqual(readAsset('country.bin.gz'), assetBefore)
    assert.deepEqual(readAsset('manifest.json'), manifestBefore)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('DB-IP CLI rejects missing, empty and invalid release months', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'miboard-geodb-release-'))
  const sourceFile = path.join(directory, 'combined.csv.gz')
  const destination = path.join(directory, 'assets')
  try {
    writeFileSync(sourceFile, gzipSync(fixtureCsv.ipv4 + fixtureCsv.ipv6))
    for (const releaseArgs of [
      [''], ['--release', ''], ['--release'], ['2026-00'], ['2026-13'],
      ['--release', '2026-1'], ['--release', 'not-a-month'],
    ]) {
      const result = runGenerator(sourceFile, destination, releaseArgs)
      assert.notEqual(result.status, 0, JSON.stringify(releaseArgs))
      assert.match(result.stderr, /release|YYYY-MM|month|argument/i)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
