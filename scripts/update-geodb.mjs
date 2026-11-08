// DB-IP Country Lite -> bundled, compact IPv4+IPv6 lookup database.
// node scripts/update-geodb.mjs [YYYY-MM | --release YYYY-MM] [--source-file input.csv.gz]
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, unlink, mkdtemp, rmdir } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { GeoDatabase } from '../src/lib/geo-db.ts'
import { compileCountryCsv } from './geodb-compiler.mjs'

const args = process.argv.slice(2)
const options = new Map()
let positionalRelease
for (let index = 0; index < args.length; index++) {
  const key = args[index]
  if (!key.startsWith('--')) {
    if (positionalRelease !== undefined) throw new Error('Expected one release YYYY-MM')
    positionalRelease = key
    continue
  }
  if (!['--release', '--source-file', '--output-dir', '--generated-at', '--source-sha256'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--') || options.has(key)) throw new Error(`Invalid option: ${key}`)
  options.set(key, args[++index])
}
if (positionalRelease !== undefined && options.has('--release')) throw new Error('Specify release once: YYYY-MM or --release YYYY-MM')
const release = positionalRelease ?? options.get('--release') ?? new Date().toISOString().slice(0, 7)
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(release)) throw new Error('Expected release YYYY-MM')
const generatedAt = options.get('--generated-at') ?? new Date().toISOString()
if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid --generated-at date')
const expected = options.get('--source-sha256')
if (expected !== undefined && !/^[a-f\d]{64}$/i.test(expected)) throw new Error('Invalid --source-sha256 digest')
const local = options.has('--source-file')
const source = `https://download.db-ip.com/free/dbip-country-lite-${release}.csv.gz`
let compressed
if (local) compressed = await readFile(options.get('--source-file'))
else {
  const response = await fetch(source, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`DB-IP download failed: HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > 16 * 1024 * 1024) throw new Error('Unexpected DB-IP source size')
  compressed = Buffer.from(await response.arrayBuffer())
}
if (compressed.length > 16 * 1024 * 1024) throw new Error('Unexpected DB-IP source size')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceSha256 = sha256(compressed)
if (expected !== undefined && sourceSha256 !== expected.toLowerCase()) throw new Error('Source SHA-256 mismatch')
const csv = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8')
const families = [[], []]
for (const line of csv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
  if (!line.trim()) continue
  const first = line.split(',', 1)[0]
  families[first.includes(':') ? 1 : 0].push(line)
}
const result = compileCountryCsv(families[0].join('\n'), families[1].join('\n'))
if (!local && (result.sourceRows.ipv4 < 100_000 || result.sourceRows.ipv6 < 100_000)) throw new Error('Unexpected DB-IP coverage')
// Validate the full MIG1 before staging any replacement files.
new GeoDatabase(result.binary)
const packed = gzipSync(result.binary, { level: 9 })
if (packed.length > 8 * 1024 * 1024) throw new Error('GeoDB exceeds browser compressed size limit')
const manifest = {
  format: 'MIG1', provider: 'DB-IP Country Lite', release, source, sourceSha256,
  sourceBytes: compressed.length, sourceChecksumVerified: expected !== undefined,
  sourceMode: local ? 'local-file' : 'release-download',
  generatedAt, ranges: result.ranges, sourceRows: result.sourceRows, countries: result.countries,
  bytes: packed.length, unpackedBytes: result.binary.length, sha256: sha256(packed),
  license: 'CC-BY-4.0', attribution: 'IP Geolocation by DB-IP',
  attributionUrl: 'https://db-ip.com', attributionRequired: true,
}
const notice = `# Offline GeoIP country data\n\nSource: DB-IP Country Lite, release ${release}.\nSnapshot generated: ${generatedAt}.\n\n- Original download: ${source}\n- Provider and terms: https://db-ip.com/db/download/ip-to-country-lite\n- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/\n- Required web attribution: [IP Geolocation by DB-IP](https://db-ip.com).\n- Source and generated SHA-256 snapshots are recorded in manifest.json.\n\nThe source CSV ranges are validated for order and overlap, uncovered ranges become ZZ,\nand adjacent ranges with the same country are merged before encoding. Country labels\nare dataset estimates, not precise locations or a measured accuracy claim.\n\ncountry.bin.gz is bundled with the dashboard. IP lookup runs locally in the browser;\ndestination IPs are never submitted to DB-IP or a geolocation service.\nRebuild: npm run update:geodb -- ${release}\nLocal snapshot: node scripts/update-geodb.mjs --release ${release} --source-file input.csv.gz\nUse --source-sha256 with an expected source digest to verify a pinned snapshot.\n\n## MIG1 binary format\n\nAll header integers are little-endian. Header: ASCII MIG1, uint16 country count,\nuint32 IPv4 range count, uint32 IPv6 range count; then two ASCII characters per country.\nIPv4 records precede IPv6 records. Each record is an unsigned LEB128 delta from the\nprevious inclusive endpoint (initially -1), followed by one uint8 country index.\nRanges cover each complete address family; ZZ means unknown. Lookup rejects private,\nfake, documentation and other non-public ranges before consulting the database.\n`
const destination = options.has('--output-dir') ? path.resolve(options.get('--output-dir')) : fileURLToPath(new URL('../public/geodb/', import.meta.url))
await mkdir(destination, { recursive: true })
const stage = await mkdtemp(path.join(destination, '.geodb-stage-'))
const files = [['country.bin.gz', packed], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'], ['NOTICE.md', notice]]
const originals = new Map()
const written = []
try {
  for (const [name, bytes] of files) {
    try { originals.set(name, await readFile(path.join(destination, name))) }
    catch (error) { if (error.code !== 'ENOENT') throw error; originals.set(name, null) }
    await writeFile(path.join(stage, name), bytes)
  }
  for (const [name] of files) {
    await rename(path.join(stage, name), path.join(destination, name))
    written.push(name)
  }
} catch (error) {
  for (const name of written.reverse()) {
    const original = originals.get(name)
    if (original === null) await unlink(path.join(destination, name)).catch(() => {})
    else await writeFile(path.join(destination, name), original)
  }
  throw error
} finally {
  for (const [name] of files) await unlink(path.join(stage, name)).catch(() => {})
  await rmdir(stage)
}
console.log(`DB-IP ${release}: ${result.sourceRows.ipv4} IPv4 + ${result.sourceRows.ipv6} IPv6 source rows -> ${result.ranges.ipv4} + ${result.ranges.ipv6} MIG1 ranges, ${packed.length} compressed bytes`)
