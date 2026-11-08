// DB-IP Country Lite -> bundled, compact IPv4+IPv6 lookup database.
// Usage: node scripts/update-geodb.mjs [YYYY-MM] [--source-file path-to-csv.gz]
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { GeoDatabase } from '../src/lib/geo-db.ts'

const args = process.argv.slice(2)
const release = args.find((arg) => /^\d{4}-\d{2}$/.test(arg)) ?? '2026-11'
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(release)) throw new Error('Expected release YYYY-MM')
const source = `https://download.db-ip.com/free/dbip-country-lite-${release}.csv.gz`
const sourceFile = args.indexOf('--source-file')
let compressed
if (sourceFile !== -1) {
  if (!args[sourceFile + 1]) throw new Error('Missing --source-file path')
  compressed = await readFile(args[sourceFile + 1])
} else {
  const response = await fetch(source, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`DB-IP download failed: HTTP ${response.status}`)
  compressed = Buffer.from(await response.arrayBuffer())
}
if (compressed.length > 16 * 1024 * 1024) throw new Error('Unexpected source size')
const csv = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')

function address(value) {
  if (!value.includes(':')) return value.split('.').reduce((result, part) => result * 256n + BigInt(part), 0n)
  const [left, right = ''] = value.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const words = [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
  if (words.length !== 8 || words.some((word) => !/^[\da-f]{1,4}$/i.test(word))) throw new Error(`Invalid IPv6: ${value}`)
  return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n)
}

const families = [[], []]
const codes = new Set()
for (const [lineNumber, line] of csv.trim().split(/\r?\n/).entries()) {
  const [first, last, country, extra] = line.split(',')
  if (!first || !last || !/^[A-Z]{2}$/.test(country) || extra !== undefined) throw new Error(`Invalid CSV line ${lineNumber + 1}`)
  const family = first.includes(':') ? 1 : 0
  const start = address(first)
  const end = address(last)
  if (start > end || Boolean(family) !== last.includes(':')) throw new Error(`Invalid range at line ${lineNumber + 1}`)
  const rows = families[family]
  if (start !== (rows.length ? rows.at(-1).end + 1n : 0n)) throw new Error(`Non-consecutive source ranges at line ${lineNumber + 1}`)
  rows.push({ end, country })
  codes.add(country)
}
if (families[0].length < 100_000 || families[1].length < 100_000 || codes.size > 256) throw new Error('Unexpected DB-IP coverage')
const countries = [...codes].sort()
const indices = new Map(countries.map((country, index) => [country, index]))
const output = []
const header = Buffer.alloc(14)
header.write('MIG1')
header.writeUInt16LE(countries.length, 4)
header.writeUInt32LE(families[0].length, 6)
header.writeUInt32LE(families[1].length, 10)
output.push(...header, ...Buffer.from(countries.join('')))
for (const family of families) {
  let previous = -1n
  for (const { end, country } of family) {
    let delta = end - previous
    while (delta > 127n) { output.push(Number(delta & 127n) | 128); delta >>= 7n }
    output.push(Number(delta), indices.get(country))
    previous = end
  }
}
const binary = Uint8Array.from(output)
// Decode before touching committed assets, so a corrupt source never replaces the last working DB.
const database = new GeoDatabase(binary)
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
  if (!database.lookup(ip)) throw new Error(`Missing smoke-test IP ${ip}`)
}
const packed = gzipSync(binary, { level: 9 })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifest = {
  format: 'MIG1', provider: 'DB-IP Country Lite', release,
  source, sourceSha256: sha256(compressed), sha256: sha256(packed),
  generatedAt: new Date().toISOString(),
  ranges: { ipv4: families[0].length, ipv6: families[1].length },
  countries: countries.length, bytes: packed.length, unpackedBytes: binary.length,
  license: 'CC-BY-4.0', attribution: 'IP Geolocation by DB-IP', attributionUrl: 'https://db-ip.com',
}
const destination = fileURLToPath(new URL('../public/geodb/', import.meta.url))
await mkdir(destination, { recursive: true })
await writeFile(`${destination}country.bin.gz.tmp`, packed)
await writeFile(`${destination}manifest.json.tmp`, JSON.stringify(manifest, null, 2) + '\n')
await rename(`${destination}country.bin.gz.tmp`, `${destination}country.bin.gz`)
await rename(`${destination}manifest.json.tmp`, `${destination}manifest.json`)
console.log(`DB-IP ${release}: ${families[0].length} IPv4 + ${families[1].length} IPv6 ranges, ${packed.length} compressed bytes`)
