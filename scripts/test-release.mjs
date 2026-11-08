import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { packageRelease } from './zip.js'
import { checkRelease, readReleaseArchive } from './check-release.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'miboard-release-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'miboard-release-')))
    rmSync(root, { recursive: true, force: true })
  })
  const directory = path.join(root, 'dist')
  for (const folder of ['assets', 'geodb', 'licenses']) mkdirSync(path.join(directory, folder), { recursive: true })
  const files = {
    'index.html': '<title>MIBoard</title><link rel="icon" href="./favicon.svg"><link rel="stylesheet" href="./assets/app.css"><script src="./assets/app.js"></script>',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/app.js': 'console.log("MIBoard")',
    'assets/app.css': '@font-face{font-family:Geist;src:url(./font.woff2)}',
    'assets/font.woff2': 'test font',
    'licenses/vendor-NOTICE.txt': 'A test fixture, not a distributed vendor license.',
    'licenses/vendor-LICENSE.txt': 'A test fixture, not a distributed vendor license.',
    'geodb/NOTICE.md': 'Test database only.',
  }
  const database = Buffer.from('MIG1 test database')
  const compressed = gzipSync(database)
  files['geodb/country.bin.gz'] = compressed
  files['geodb/manifest.json'] = JSON.stringify({ format: 'MIG1', bytes: compressed.length, unpackedBytes: database.length, sha256: createHash('sha256').update(compressed).digest('hex') })
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, name), content)
  return { root, directory, archivePath: path.join(root, 'dist.zip'), names: Object.keys(files).sort() }
}

test('release ZIP contains deployable files at its root and a matching checksum', t => {
  const data = fixture(t)
  const result = packageRelease(data)
  assert.deepEqual([...readReleaseArchive(readFileSync(data.archivePath)).keys()], data.names)
  assert.equal(checkRelease(data).sha256, result.sha256)
  assert.match(readFileSync(`${data.archivePath}.sha256`, 'utf8'), /^[a-f0-9]{64}  dist\.zip\n$/)
  assert.deepEqual(readdirSync(data.root).sort(), ['dist', 'dist.zip', 'dist.zip.sha256'])
})

test('packaging is deterministic and replaces both previous release files', t => {
  const data = fixture(t)
  const first = packageRelease(data)
  const archive = readFileSync(data.archivePath)
  utimesSync(path.join(data.directory, 'index.html'), new Date('2030-01-01'), new Date('2030-01-01'))
  assert.equal(packageRelease(data).sha256, first.sha256)
  assert.deepEqual(readFileSync(data.archivePath), archive)
  writeFileSync(path.join(data.directory, 'assets/app.js'), 'console.log("Updated")')
  assert.notEqual(packageRelease(data).sha256, first.sha256)
  assert.doesNotThrow(() => checkRelease(data))
})

test('an unexpected local file cannot enter the archive or destroy an older release', t => {
  const data = fixture(t)
  packageRelease(data)
  const previous = readFileSync(data.archivePath)
  const checksum = readFileSync(`${data.archivePath}.sha256`)
  writeFileSync(path.join(data.directory, '.env'), 'LOCAL_TEST_FIXTURE=only')
  assert.throws(() => packageRelease(data), /Unexpected release file: \.env/)
  assert.deepEqual(readFileSync(data.archivePath), previous)
  assert.deepEqual(readFileSync(`${data.archivePath}.sha256`), checksum)
})

test('an oversized release leaves previous results intact and no temporary files', t => {
  const data = fixture(t)
  packageRelease(data)
  const previous = readFileSync(data.archivePath)
  const checksum = readFileSync(`${data.archivePath}.sha256`)
  assert.throws(() => packageRelease({ ...data, maxBytes: 10 }), /Archive exceeds/)
  assert.deepEqual(readFileSync(data.archivePath), previous)
  assert.deepEqual(readFileSync(`${data.archivePath}.sha256`), checksum)
  assert.deepEqual(readdirSync(data.root).sort(), ['dist', 'dist.zip', 'dist.zip.sha256'])
})

test('a directory at the checksum destination is never replaced or removed', t => {
  const data = fixture(t)
  writeFileSync(data.archivePath, 'previous archive')
  mkdirSync(`${data.archivePath}.sha256`)
  assert.throws(() => packageRelease(data), /not a regular file/)
  assert.equal(readFileSync(data.archivePath, 'utf8'), 'previous archive')
  assert.deepEqual(readdirSync(data.root).sort(), ['dist', 'dist.zip', 'dist.zip.sha256'])
})

test('validation detects checksum corruption, stale builds and corrupt ZIP data', t => {
  const data = fixture(t)
  packageRelease(data)
  writeFileSync(`${data.archivePath}.sha256`, 'wrong checksum')
  assert.throws(() => checkRelease(data), /SHA-256/)
  packageRelease(data)
  writeFileSync(path.join(data.directory, 'assets/app.js'), 'newer build')
  assert.throws(() => checkRelease(data), /Archive differs/)
  packageRelease(data)
  const archive = readFileSync(data.archivePath)
  archive[archive.indexOf(Buffer.from('assets/app.css')) + 'assets/app.css'.length + 2] ^= 0xff
  assert.throws(() => readReleaseArchive(archive))
})

test('packaging rejects missing built assets and a damaged offline database', t => {
  const data = fixture(t)
  rmSync(path.join(data.directory, 'assets/font.woff2'))
  assert.throws(() => packageRelease(data), /Missing built \.woff2/)
  writeFileSync(path.join(data.directory, 'assets/font.woff2'), 'test font')
  writeFileSync(path.join(data.directory, 'geodb/country.bin.gz'), 'damaged')
  assert.throws(() => packageRelease(data), /GeoDB does not match/)
})
