// sapics server-country -> bundled, compact IPv4+IPv6 lookup database.
// Comparison snapshots: node scripts/update-geodb-server-country.mjs --output-dir reports/snapshot
// Local: --ipv4-file file.csv --ipv6-file file.csv --output-dir directory
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, unlink, mkdtemp, rmdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { GeoDatabase } from '../src/lib/geo-db.ts'
import { compileCountryCsv } from './geodb-compiler.mjs'

const args = process.argv.slice(2)
const options = new Map()
for (let index = 0; index < args.length; index += 2) {
  const key = args[index]
  if (!['--ipv4-file', '--ipv6-file', '--output-dir', '--generated-at', '--source-commit', '--ipv4-sha256', '--ipv6-sha256'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${key}`)
  options.set(key, args[index + 1])
}
const local = options.has('--ipv4-file') || options.has('--ipv6-file')
if (!options.has('--output-dir')) throw new Error('The comparison updater requires --output-dir; DB-IP remains the default bundled database')
if (local && !(options.has('--ipv4-file') && options.has('--ipv6-file'))) throw new Error('Both --ipv4-file and --ipv6-file are required')
const generatedAt = options.get('--generated-at') ?? new Date().toISOString()
if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid --generated-at date')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const base = 'https://github.com/sapics/ip-location-db/releases/download/'
async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`GeoDB download failed: HTTP ${response.status} (${url})`)
  if (Number(response.headers.get('content-length')) > limit) throw new Error('GeoDB source exceeds size limit')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > limit) throw new Error('GeoDB source exceeds size limit')
  return bytes
}
const inputs = await Promise.all(['ipv4', 'ipv6'].map(async (family) => {
  const filename = `server-country-${family}.csv`
  const url = `${base}latest/${filename}`
  const checksumUrl = `${base}checksum/${filename}.sha256`
  const bytes = local ? await readFile(options.get(`--${family}-file`)) : await download(url, 64 * 1024 * 1024)
  if (bytes.length > 64 * 1024 * 1024) throw new Error('GeoDB source exceeds size limit')
  const expected = options.get(`--${family}-sha256`) ?? (local ? null : (await download(checksumUrl, 1024)).toString('utf8').trim().split(/\s+/)[0])
  const digest = sha256(bytes)
  if (expected !== null && (!/^[a-f\d]{64}$/i.test(expected) || digest !== expected.toLowerCase())) throw new Error(`SHA-256 mismatch for ${filename}`)
  return { bytes, metadata: { family, url, checksumUrl, sha256: digest, bytes: bytes.length, checksumVerified: expected !== null } }
}))
const result = compileCountryCsv(inputs[0].bytes.toString('utf8'), inputs[1].bytes.toString('utf8'))
if (!local && (result.sourceRows.ipv4 < 100_000 || result.sourceRows.ipv6 < 100_000)) throw new Error('Unexpected server-country coverage')
// Decode before touching assets. The source may have gaps, the compiled MIG1 must not.
new GeoDatabase(result.binary)
const packed = gzipSync(result.binary, { level: 9 })
const manifest = {
  format: 'MIG1', provider: 'sapics/ip-location-db server-country', release: 'latest',
  source: 'https://github.com/sapics/ip-location-db',
  ...(options.has('--source-commit') ? {
    sourceCommit: options.get('--source-commit'),
    sourceCommitRole: 'Repository HEAD observed at download; release asset identity is pinned by each source SHA-256',
  } : {}),
  sources: inputs.map((input) => input.metadata),
  sourceMode: local ? 'local-files' : 'verified-release-download',
  generatedAt, ranges: result.ranges, sourceRows: result.sourceRows, countries: result.countries,
  bytes: packed.length, unpackedBytes: result.binary.length, sha256: sha256(packed),
  license: 'PDDL-1.0', attribution: 'sapics/ip-location-db server-country',
  attributionUrl: 'https://github.com/sapics/ip-location-db', attributionRequired: false,
}
const notice = `# Offline GeoIP country data\n\nSource: sapics/ip-location-db, server-country (IPv4 and IPv6).\nSnapshot generated: ${generatedAt}.\n\n- Project and source description: https://github.com/sapics/ip-location-db\n- IPv4 CSV: ${inputs[0].metadata.url}\n- IPv6 CSV: ${inputs[1].metadata.url}\n- License: Open Data Commons Public Domain Dedication and Licence v1.0 (PDDL-1.0), https://opendatacommons.org/licenses/pddl/1-0/\n- The publisher offers server-country under PDDL; attribution is not required.\n- Source SHA-256 snapshots, checksum URLs and output checksum are recorded in manifest.json.\n\nThe publisher describes server-country as prioritizing the physical server or relay point.\nCountry labels are dataset estimates, not precise locations or a measured accuracy claim.\nThe source CSV ranges are validated for order and overlap, uncovered ranges become ZZ,\nand adjacent ranges with the same country are merged before encoding.\n\ncountry.bin.gz is bundled with the dashboard. IP lookup runs locally in the browser;\ndestination IPs are never submitted to the dataset publisher or a geolocation service.\nRebuild from the current checksum-verified release: npm run update:geodb.\nLocal snapshots: node scripts/update-geodb.mjs --ipv4-file ipv4.csv --ipv6-file ipv6.csv.\n\n## MIG1 binary format\n\nAll header integers are little-endian. Header: ASCII MIG1, uint16 country count,\nuint32 IPv4 range count, uint32 IPv6 range count; then two ASCII characters per country.\nIPv4 records precede IPv6 records. Each record is an unsigned LEB128 delta from the\nprevious inclusive endpoint (initially -1), followed by one uint8 country index.\nRanges cover each complete address family; ZZ means unknown. Lookup rejects private,\nfake, documentation and other non-public ranges before consulting the database.\n`
const destination = options.has('--output-dir') ? path.resolve(options.get('--output-dir')) : fileURLToPath(new URL('../public/geodb/', import.meta.url))
const comparisonNotice = notice
  .replace('npm run update:geodb.', 'node scripts/update-geodb-server-country.mjs --output-dir snapshot.')
  .replace('node scripts/update-geodb.mjs --ipv4-file', 'node scripts/update-geodb-server-country.mjs --output-dir snapshot --ipv4-file')
await mkdir(destination, { recursive: true })
const stage = await mkdtemp(path.join(destination, '.geodb-stage-'))
const files = [['country.bin.gz', packed], ['manifest.json', JSON.stringify(manifest, null, 2) + '\n'], ['NOTICE.md', comparisonNotice]]
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
console.log(`server-country: ${result.sourceRows.ipv4} IPv4 + ${result.sourceRows.ipv6} IPv6 source rows -> ${result.ranges.ipv4} + ${result.ranges.ipv6} MIG1 ranges, ${packed.length} compressed bytes`)
