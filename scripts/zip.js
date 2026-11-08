// dist/ → dist.zip; файлы в корне архива, как ожидает mihomo.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { MAX_ARCHIVE_BYTES, readDistribution } from './check-release.mjs'

function zipBuffer(files) {
  if (files.length > 0xffff) throw new Error('Too many files for a ZIP archive')
  const local = []
  const central = []
  let offset = 0
  let centralSize = 0
  for (const { name, data } of files) {
    const filename = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const checksum = crc32(data)
    if (filename.length > 0xffff || data.length > 0xffffffff || compressed.length > 0xffffffff) throw new Error(`File exceeds ZIP limits: ${name}`)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 filenames
    header.writeUInt16LE(8, 8) // raw DEFLATE
    header.writeUInt16LE(33, 12) // 1980-01-01; reproducible across time zones
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, compressed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE((3 << 8) | 20, 4) // Unix, ZIP 2.0
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(8, 10)
    record.writeUInt16LE(33, 14)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(compressed.length, 20)
    record.writeUInt32LE(data.length, 24)
    record.writeUInt16LE(filename.length, 28)
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, filename)
    offset += header.length + filename.length + compressed.length
    centralSize += record.length + filename.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}

// Сначала готовы оба временных файла. Старые результаты возвращаются при ошибке.
function publishFiles(files) {
  for (const file of files) {
    if (existsSync(file.filename) && !lstatSync(file.filename).isFile()) throw new Error(`Release output is not a regular file: ${file.filename}`)
  }
  const pending = files.map(({ filename, data }) => ({ filename, data, temporary: `${filename}.${randomUUID()}.tmp`, backup: null, installed: false }))
  try {
    for (const file of pending) writeFileSync(file.temporary, file.data, { flag: 'wx' })
    for (const file of pending) {
      if (existsSync(file.filename)) {
        const backup = `${file.filename}.${randomUUID()}.bak`
        renameSync(file.filename, backup)
        file.backup = backup
      }
      renameSync(file.temporary, file.filename)
      file.installed = true
    }
  } catch (error) {
    const failures = [error]
    for (const file of pending.toReversed()) {
      try {
        if (file.installed) unlinkSync(file.filename)
        if (file.backup) renameSync(file.backup, file.filename)
      } catch (rollbackError) { failures.push(rollbackError) }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Could not restore previous release files')
    throw error
  } finally {
    for (const file of pending) if (existsSync(file.temporary)) unlinkSync(file.temporary)
  }
  for (const file of pending) if (file.backup) unlinkSync(file.backup)
}

export function packageRelease({ directory = 'dist', archivePath = 'dist.zip', maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const root = path.resolve(directory)
  const output = path.resolve(archivePath)
  const relative = path.relative(root, output)
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('The release archive must be outside the distribution directory')
  const files = readDistribution(root)
  const archive = zipBuffer(files)
  if (archive.length > maxBytes) throw new Error(`Archive exceeds ${(maxBytes / 1024 / 1024).toFixed(2)} MiB: ${archive.length} bytes`)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const checksumPath = `${output}.sha256`
  mkdirSync(path.dirname(output), { recursive: true })
  publishFiles([
    { filename: output, data: archive },
    { filename: checksumPath, data: `${sha256}  ${path.basename(output)}\n` },
  ])
  return { archivePath: output, checksumPath, size: archive.length, files: files.length, sha256 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = packageRelease({ directory: process.argv[2], archivePath: process.argv[3] })
    console.log(`${path.basename(release.archivePath)}: ${(release.size / 1024).toFixed(0)} KiB, ${release.files} files (limit 10 MiB)`)
    console.log(`${release.sha256}  ${path.basename(release.archivePath)}`)
  } catch (error) {
    console.error(`Release packaging failed: ${error.message}`)
    process.exitCode = 1
  }
}
