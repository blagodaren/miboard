import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { packageRelease } from './zip.js'
import { checkRelease, readReleaseArchive, releaseOptionsFromArgs } from './check-release.mjs'
import { FONT_SOURCES } from './font-sources.mjs'

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

const cdnCss = fonts => fonts.map((font, index) => `@font-face{font-family:Font${index};src:url("${font.cdn}")}`).join('\n')

function cdnFixture(t) {
  const data = fixture(t)
  rmSync(path.join(data.directory, 'assets/font.woff2'))
  writeFileSync(path.join(data.directory, 'assets/app.css'), cdnCss(FONT_SOURCES))
  return { ...data, archivePath: path.join(data.root, 'dist-cdn-fonts.zip'), fontMode: 'cdn' }
}

test('CDN fonts are opt-in and both release archives coexist with independent checksums', t => {
  const local = fixture(t)
  const localResult = packageRelease(local)
  const localBytes = readFileSync(local.archivePath)
  const directory = path.join(local.root, 'dist-cdn-fonts')
  cpSync(local.directory, directory, { recursive: true })
  rmSync(path.join(directory, 'assets/font.woff2'))
  writeFileSync(path.join(directory, 'assets/app.css'), cdnCss(FONT_SOURCES))
  const cdn = { directory, archivePath: path.join(local.root, 'dist-cdn-fonts.zip'), fontMode: 'cdn' }
  const result = packageRelease(cdn)
  const names = [...readReleaseArchive(readFileSync(cdn.archivePath)).keys()]
  assert(!names.some(name => /\.(woff2?|ttf|otf)$/i.test(name)))
  assert.equal(checkRelease(cdn).sha256, result.sha256)
  assert.equal(packageRelease(cdn).sha256, result.sha256, 'CDN archive is deterministic')
  assert.equal(checkRelease(local).sha256, localResult.sha256)
  assert.deepEqual(readFileSync(local.archivePath), localBytes)
  assert.match(readFileSync(`${cdn.archivePath}.sha256`, 'utf8'), /^[a-f0-9]{64}  dist-cdn-fonts\.zip\n$/)
})

test('the default local build rejects even the approved CDN fonts', t => {
  const data = fixture(t)
  writeFileSync(path.join(data.directory, 'assets/app.css'), cdnCss(FONT_SOURCES))
  assert.throws(() => packageRelease(data), /Release must use relative assets/)
  assert.throws(() => packageRelease({ ...data, fontMode: 'unexpected' }), /Unknown font mode/)
})

test('CDN font releases reject bundled fonts, missing font references and unpinned or foreign URLs', t => {
  const data = cdnFixture(t)
  const css = path.join(data.directory, 'assets/app.css')
  writeFileSync(path.join(data.directory, 'assets/font.woff2'), 'a bundled font')
  assert.throws(() => packageRelease(data), /must not contain bundled fonts/)
  rmSync(path.join(data.directory, 'assets/font.woff2'))
  writeFileSync(css, cdnCss(FONT_SOURCES.slice(1)))
  assert.throws(() => packageRelease(data), /Missing CDN font reference/)
  for (const replacement of [
    FONT_SOURCES[0].cdn.replace('@0.1.8', '@latest'),
    FONT_SOURCES[0].cdn.replace('https://unpkg.com/', 'https://unpkg.com.evil.example/'),
    FONT_SOURCES[0].cdn + '?redirect=1',
  ]) {
    writeFileSync(css, cdnCss(FONT_SOURCES).replace(FONT_SOURCES[0].cdn, replacement))
    assert.throws(() => packageRelease(data), /Unapproved external asset/)
  }
})

test('approved font URLs do not authorize external script or stylesheet references', t => {
  const data = cdnFixture(t)
  for (const tag of [
    `<script src="${FONT_SOURCES[0].cdn}"></script>`,
    `<link rel="stylesheet" href="${FONT_SOURCES[0].cdn}">`,
  ]) {
    writeFileSync(path.join(data.directory, 'index.html'), `<title>MIBoard</title>${tag}`)
    assert.throws(() => packageRelease(data), /Unapproved external asset/)
  }
})

test('an invalid CDN font reference preserves the previous CDN archive and checksum', t => {
  const data = cdnFixture(t)
  packageRelease(data)
  const previous = readFileSync(data.archivePath)
  const checksum = readFileSync(`${data.archivePath}.sha256`)
  writeFileSync(path.join(data.directory, 'assets/app.css'), cdnCss(FONT_SOURCES.slice(1)))
  assert.throws(() => packageRelease(data), /Missing CDN font reference/)
  assert.deepEqual(readFileSync(data.archivePath), previous)
  assert.deepEqual(readFileSync(`${data.archivePath}.sha256`), checksum)
})

test('release CLI selects CDN fonts explicitly and rejects misspelled options', () => {
  assert.deepEqual(releaseOptionsFromArgs([]), { directory: 'dist', archivePath: 'dist.zip', fontMode: 'local' })
  assert.deepEqual(releaseOptionsFromArgs(['--cdn-fonts']), { directory: 'dist-cdn-fonts', archivePath: 'dist-cdn-fonts.zip', fontMode: 'cdn' })
  assert.deepEqual(releaseOptionsFromArgs(['custom', 'custom.zip', '--cdn-fonts']), { directory: 'custom', archivePath: 'custom.zip', fontMode: 'cdn' })
  assert.throws(() => releaseOptionsFromArgs(['--cdn-font']), /Usage/)
  assert.throws(() => releaseOptionsFromArgs(['dist', 'dist.zip', 'unexpected']), /Usage/)
  assert.throws(() => releaseOptionsFromArgs(['--cdn-fonts', '--cdn-fonts']), /Usage/)
})
