import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib'
import { FONT_SOURCES } from './font-sources.mjs'

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const sha256 = data => createHash('sha256').update(data).digest('hex')
const required = ['index.html', 'favicon.svg', 'geodb/manifest.json', 'geodb/country.bin.gz', 'geodb/NOTICE.md']
const cdnFonts = new Set(FONT_SOURCES.map(font => font.cdn))

export function releaseOptionsFromArgs(args) {
  const positional = args.filter(arg => arg !== '--cdn-fonts')
  if (positional.some(arg => arg.startsWith('--')) || positional.length > 2 || args.filter(arg => arg === '--cdn-fonts').length > 1) {
    throw new Error('Usage: [directory] [archive.zip] [--cdn-fonts]')
  }
  const fontMode = args.includes('--cdn-fonts') ? 'cdn' : 'local'
  return {
    directory: positional[0] ?? (fontMode === 'cdn' ? 'dist-cdn-fonts' : 'dist'),
    archivePath: positional[1] ?? (fontMode === 'cdn' ? 'dist-cdn-fonts.zip' : 'dist.zip'),
    fontMode,
  }
}

function allowedFile(name) {
  if (/[\\\u0000-\u001f]/.test(name)) return false
  if (name.split('/').some(part => !part || part.startsWith('.') || part === '..')) return false
  if (['index.html', 'favicon.svg'].includes(name)) return true
  if (/^assets\/(?:[^/]+\/)*[^/]+\.(?:js|css|woff2?|ttf|svg|png|jpe?g|webp|avif)$/.test(name)) return true
  if (/^licenses\/(?:[^/]+\/)*[^/]+\.(?:md|txt)$/.test(name)) return true
  return required.includes(name)
}

export function readDistribution(directory = 'dist', { fontMode = 'local' } = {}) {
  if (!['local', 'cdn'].includes(fontMode)) throw new Error(`Unknown font mode: ${fontMode}`)
  const files = []
  function visit(folder, prefix = '') {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + entry.name
      const filename = path.join(folder, entry.name)
      const info = lstatSync(filename)
      if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a release: ${name}`)
      if (info.isDirectory()) {
        if (!/^(?:assets|licenses|geodb)(?:\/[^/.][^/]*)*$/.test(name)) throw new Error(`Unexpected release directory: ${name}`)
        visit(filename, `${name}/`)
      } else {
        if (!info.isFile() || !allowedFile(name)) throw new Error(`Unexpected release file: ${name}`)
        files.push({ name, data: readFileSync(filename) })
      }
    }
  }
  visit(path.resolve(directory))
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const contents = new Map(files.map(file => [file.name, file.data]))
  if (new Set(files.map(file => file.name.toLowerCase())).size !== files.length) throw new Error('Release filenames differ only by case')
  for (const name of required) if (!contents.has(name)) throw new Error(`Missing release file: ${name}`)
  for (const extension of fontMode === 'local' ? ['js', 'css', 'woff2'] : ['js', 'css']) {
    if (!files.some(file => file.name.startsWith('assets/') && file.name.endsWith(`.${extension}`))) throw new Error(`Missing built .${extension} assets`)
  }
  if (fontMode === 'cdn' && files.some(file => /\.(?:woff2?|ttf|otf)$/i.test(file.name))) throw new Error('CDN font release must not contain bundled fonts')
  if (!files.some(file => /^licenses\/.*NOTICE\.(?:md|txt)$/i.test(file.name))) throw new Error('Missing third-party notices')
  if (!files.some(file => /^licenses\/.*LICENSE\.(?:md|txt)$/i.test(file.name))) throw new Error('Missing third-party license texts')

  // Every local reference in the entry page and CSS must resolve in the archive.
  const usedCdnFonts = new Set()
  for (const file of files.filter(file => file.name === 'index.html' || file.name.endsWith('.css'))) {
    const source = file.data.toString('utf8')
    const refs = file.name.endsWith('.css')
      ? [...source.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map(match => match[1])
      : [...source.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1])
    for (const ref of refs) {
      if (/^(?:data:|#)/i.test(ref)) continue
      if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(ref)) {
        if (fontMode === 'cdn' && file.name.endsWith('.css') && cdnFonts.has(ref)) {
          usedCdnFonts.add(ref)
          continue
        }
        throw new Error(fontMode === 'local'
          ? `Release must use relative assets: ${ref}`
          : `Unapproved external asset in CDN font release: ${ref}`)
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.name), ref.split(/[?#]/)[0]))
      if (!contents.has(target)) throw new Error(`Missing referenced asset: ${file.name} → ${ref}`)
    }
  }
  if (fontMode === 'cdn') {
    for (const font of cdnFonts) if (!usedCdnFonts.has(font)) throw new Error(`Missing CDN font reference: ${font}`)
  }

  const manifest = JSON.parse(contents.get('geodb/manifest.json').toString('utf8'))
  const compressed = contents.get('geodb/country.bin.gz')
  if (manifest.format !== 'MIG1' || manifest.bytes !== compressed.length || manifest.sha256 !== sha256(compressed)) throw new Error('GeoDB does not match its manifest')
  const database = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 })
  if (database.length !== manifest.unpackedBytes || database.subarray(0, 4).toString() !== 'MIG1') throw new Error('Invalid GeoDB data')
  return files
}

// Read the standard ZIP 2.0 subset emitted by zip.js; validate both directories.
export function readReleaseArchive(archive) {
  const fail = message => { throw new Error(`Invalid release ZIP: ${message}`) }
  const end = archive.length - 22
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) fail('missing end record')
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 20)) fail('unsupported split archive or comment')
  const count = archive.readUInt16LE(end + 10)
  if (archive.readUInt16LE(end + 8) !== count) fail('entry count differs')
  const directorySize = archive.readUInt32LE(end + 12)
  const directoryOffset = archive.readUInt32LE(end + 16)
  if (directoryOffset + directorySize !== end) fail('central directory bounds differ')
  const files = new Map()
  let cursor = directoryOffset
  let localCursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) fail('missing central entry')
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const checksum = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const offset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    if (flags !== 0x0800 || method !== 8 || !allowedFile(name) || files.has(name)) fail(`unsupported or duplicate entry: ${name}`)
    if (size > 32 * 1024 * 1024 || offset !== localCursor || offset + 30 > directoryOffset || archive.readUInt32LE(offset) !== 0x04034b50) fail(`invalid local entry: ${name}`)
    const localNameLength = archive.readUInt16LE(offset + 26)
    const localExtraLength = archive.readUInt16LE(offset + 28)
    if (archive.readUInt16LE(offset + 6) !== flags || archive.readUInt16LE(offset + 8) !== method || archive.readUInt32LE(offset + 14) !== checksum || archive.readUInt32LE(offset + 18) !== compressedSize || archive.readUInt32LE(offset + 22) !== size) fail(`local metadata differs: ${name}`)
    if (archive.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name) fail(`local filename differs: ${name}`)
    const start = offset + 30 + localNameLength + localExtraLength
    const finish = start + compressedSize
    if (finish > directoryOffset) fail(`entry outside data area: ${name}`)
    const data = inflateRawSync(archive.subarray(start, finish), { maxOutputLength: Math.max(size, 1) })
    if (data.length !== size || crc32(data) !== checksum) fail(`CRC or size differs: ${name}`)
    files.set(name, data)
    localCursor = finish
    cursor += 46 + nameLength + extraLength + commentLength
  }
  if (cursor !== end || localCursor !== directoryOffset) fail('unlisted data or entries')
  return files
}

export function checkRelease({ directory = 'dist', archivePath = 'dist.zip', maxBytes = MAX_ARCHIVE_BYTES, fontMode = 'local' } = {}) {
  const distribution = readDistribution(directory, { fontMode })
  const archive = readFileSync(archivePath)
  if (archive.length > maxBytes) throw new Error('Release archive exceeds 10 MiB')
  const checksum = sha256(archive)
  const expected = `${checksum}  ${path.basename(archivePath)}\n`
  if (readFileSync(`${archivePath}.sha256`, 'utf8') !== expected) throw new Error('Release SHA-256 checksum differs')
  const files = readReleaseArchive(archive)
  if (files.size !== distribution.length) throw new Error('Archive file count differs from dist/')
  for (const file of distribution) {
    if (!files.get(file.name)?.equals(file.data)) throw new Error(`Archive differs from dist/: ${file.name}`)
  }
  return { size: archive.length, files: files.size, sha256: checksum }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkRelease(releaseOptionsFromArgs(process.argv.slice(2)))
    console.log(`PASS: ${result.files} release files, ZIP integrity, SHA-256, local assets and GeoDB (${(result.size / 1024).toFixed(0)} KiB)`)
  } catch (error) {
    console.error(`Release validation failed: ${error.message}`)
    process.exitCode = 1
  }
}
