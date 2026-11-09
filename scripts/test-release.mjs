import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, gzipSync } from 'node:zlib'
import { packageRelease } from './zip.js'
import { checkRelease, readReleaseArchive, releaseOptionsFromArgs } from './check-release.mjs'
import { FONT_SOURCES } from './font-sources.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
function png(size) {
  const chunk = (type, content) => {
    const data = Buffer.concat([Buffer.from(type), content])
    const header = Buffer.alloc(4); header.writeUInt32BE(content.length)
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(data))
    return Buffer.concat([header, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((size * 4 + 1) * size)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}

function refreshPwa(directory) {
  const files = []
  const walk = (prefix = '') => {
    for (const item of readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
      const name = prefix + item.name
      if (item.isDirectory()) walk(`${name}/`)
      else if (!['sw.js', 'version.json'].includes(name)) files.push({ path: name, sha256: hash(readFileSync(path.join(directory, name))) })
    }
  }
  walk()
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const version = { version: '1.2.3-alpha.1', buildId: hash(JSON.stringify(files)).slice(0, 16) }
  writeFileSync(path.join(directory, 'version.json'), JSON.stringify(version))
  // This fixture tests distribution integrity; worker runtime behavior has its own tests.
  writeFileSync(path.join(directory, 'sw.js'), `const VERSION = ${JSON.stringify(version)};\nconst STATIC_FILES = ${JSON.stringify(files)};\nself.addEventListener('fetch', () => {});\n`)
  return { version, files }
}

function rewriteWorker(directory, transform) {
  const source = readFileSync(path.join(directory, 'sw.js'), 'utf8')
  const files = JSON.parse(source.match(/const STATIC_FILES = (.*);/)[1])
  writeFileSync(path.join(directory, 'sw.js'), source.replace(/const STATIC_FILES = .*;/, `const STATIC_FILES = ${JSON.stringify(transform(files))};`))
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'miboard-release-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'miboard-release-')))
    rmSync(root, { recursive: true, force: true })
  })
  const directory = path.join(root, 'dist')
  for (const folder of ['assets', 'geodb', 'licenses', 'icons']) mkdirSync(path.join(directory, folder), { recursive: true })
  const files = {
    'index.html': '<title>MIBoard</title><link rel="icon" href="./favicon.svg"><link rel="manifest" href="./manifest.webmanifest"><link rel="apple-touch-icon" href="./apple-touch-icon.png"><link rel="stylesheet" href="./assets/app.css"><script src="./assets/app.js"></script>',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/app.js': 'console.log("MIBoard")',
    'assets/app.css': '@font-face{font-family:Geist;src:url(./font.woff2)}',
    'assets/font.woff2': 'test font',
    'licenses/vendor-NOTICE.txt': 'A test fixture, not a distributed vendor license.',
    'licenses/vendor-LICENSE.txt': 'A test fixture, not a distributed vendor license.',
    'geodb/NOTICE.md': 'Test database only.',
    'version.json': '{}',
    'manifest.webmanifest': JSON.stringify({ name: 'MIBoard', short_name: 'MIBoard', id: './', start_url: './', scope: './', display: 'standalone', icons: [
      { src: './icons/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icons/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ] }),
    'icons/pwa-192.png': png(192),
    'icons/pwa-512.png': png(512),
    'icons/pwa-maskable-512.png': png(512),
    'apple-touch-icon.png': png(180),
  }
  const database = Buffer.from('MIG1 test database')
  const compressed = gzipSync(database)
  files['geodb/country.bin.gz'] = compressed
  files['geodb/manifest.json'] = JSON.stringify({ format: 'MIG1', bytes: compressed.length, unpackedBytes: database.length, sha256: createHash('sha256').update(compressed).digest('hex') })
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(directory, name), content)
  refreshPwa(directory)
  return { root, directory, archivePath: path.join(root, 'dist.zip'), names: [...Object.keys(files), 'sw.js'].sort() }
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
  refreshPwa(data.directory)
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
  refreshPwa(data.directory)
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
  refreshPwa(data.directory)
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
  refreshPwa(directory)
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

test('release CLI rejects coherent archives with a different release version without changing files, for both font builds', t => {
  const { version: expectedVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const script = fileURLToPath(new URL('./check-release.mjs', import.meta.url))
  for (const data of [fixture(t), cdnFixture(t)]) {
    packageRelease(data)
    const archive = readFileSync(data.archivePath)
    const checksum = readFileSync(`${data.archivePath}.sha256`)
    assert.doesNotThrow(() => checkRelease(data), 'library validation remains independent of the repository version')
    const args = [script, data.directory, data.archivePath, ...(data.fontMode === 'cdn' ? ['--cdn-fonts'] : [])]
    const run = () => spawnSync(process.execPath, args, { cwd: data.root, encoding: 'utf8' })
    const stale = run()
    assert.equal(stale.status, 1, stale.stderr)
    assert.match(stale.stderr, /Release version differs:/)
    assert.ok(stale.stderr.includes(`expected ${expectedVersion}, found 1.2.3-alpha.1`))
    assert.deepEqual(readFileSync(data.archivePath), archive)
    assert.deepEqual(readFileSync(`${data.archivePath}.sha256`), checksum)

    const versionFile = path.join(data.directory, 'version.json')
    const current = { ...JSON.parse(readFileSync(versionFile, 'utf8')), version: expectedVersion }
    writeFileSync(versionFile, JSON.stringify(current))
    const workerFile = path.join(data.directory, 'sw.js')
    writeFileSync(workerFile, readFileSync(workerFile, 'utf8').replace(/^const VERSION = .*;/m, `const VERSION = ${JSON.stringify(current)};`))
    packageRelease(data)
    const matching = run()
    assert.equal(matching.status, 0, matching.stderr)
    assert.match(matching.stdout, /PASS:/)
  }
})

test('every PWA root artifact and install icon is required in both font distributions', t => {
  for (const build of [fixture(t), cdnFixture(t)]) {
    for (const name of ['sw.js', 'version.json', 'manifest.webmanifest', 'apple-touch-icon.png', 'icons/pwa-192.png', 'icons/pwa-512.png', 'icons/pwa-maskable-512.png']) {
      const filename = path.join(build.directory, name)
      const content = readFileSync(filename)
      rmSync(filename)
      assert.throws(() => packageRelease(build), /Missing release file/, name)
      writeFileSync(filename, content)
    }
    assert.doesNotThrow(() => packageRelease(build))
  }
})

test('manifest identity, relative app root and icon purposes cannot escape the deployed subdirectory', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'manifest.webmanifest')
  const original = JSON.parse(readFileSync(filename, 'utf8'))
  for (const key of ['id', 'start_url', 'scope']) {
    for (const value of ['/', '/ui/', '../', 'https://foreign.example/', './?secret=fixture', './#/setup']) {
      writeFileSync(filename, JSON.stringify({ ...original, [key]: value }))
      assert.throws(() => packageRelease(data), new RegExp(`PWA manifest ${key}`))
    }
  }
  for (const patch of [{ name: 'Other app' }, { short_name: 'Other' }, { display: 'browser' }, { icons: original.icons.slice(1) }]) {
    writeFileSync(filename, JSON.stringify({ ...original, ...patch }))
    assert.throws(() => packageRelease(data), /PWA manifest/)
  }
  for (const icon of [
    { ...original.icons[0], src: 'https://foreign.example/icon.png' },
    { ...original.icons[0], src: '../icons/pwa-192.png' },
    { ...original.icons[0], src: './icons/pwa-192.png?secret=fixture' },
    { ...original.icons[0], purpose: 'maskable' },
    { ...original.icons[0], sizes: '512x512' },
  ]) {
    writeFileSync(filename, JSON.stringify({ ...original, icons: [icon, ...original.icons.slice(1)] }))
    assert.throws(() => packageRelease(data), /PWA/)
  }
})

test('entry HTML must reference its local install manifest and Apple icon', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'index.html')
  const original = readFileSync(filename, 'utf8')
  for (const rel of ['manifest', 'apple-touch-icon']) {
    writeFileSync(filename, original.replace(new RegExp(`<link rel="${rel}"[^>]+>`), ''))
    assert.throws(() => packageRelease(data), /Missing PWA entry-page/)
  }
})

test('install icons have real PNG structure, correct dimensions and intact chunks', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'icons/pwa-192.png')
  const original = readFileSync(filename)
  writeFileSync(filename, png(180))
  assert.throws(() => packageRelease(data), /Wrong PWA icon dimensions/)
  const corrupted = Buffer.from(original)
  corrupted[30] ^= 1
  writeFileSync(filename, corrupted)
  assert.throws(() => packageRelease(data), /Invalid PWA PNG checksum/)
  writeFileSync(filename, original.subarray(0, original.length - 12))
  assert.throws(() => packageRelease(data), /Incomplete PWA PNG/)
  writeFileSync(filename, '<svg/>')
  assert.throws(() => packageRelease(data), /Invalid PWA PNG/)
})

test('version metadata uses semantic versions and an exact content build identity without extra fields', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'version.json')
  const original = JSON.parse(readFileSync(filename, 'utf8'))
  for (const value of [
    { ...original, version: 'v1.2.3' }, { ...original, version: '01.2.3' }, { ...original, version: '1.2.3-alpha..1' },
    { ...original, version: '1.2.3-01' }, { ...original, buildId: 'ABCD1234567890EF' },
    { ...original, buildId: '0123' }, { ...original, secret: 'fixture-only' }, null, [],
  ]) {
    writeFileSync(filename, JSON.stringify(value))
    assert.throws(() => packageRelease(data), /Invalid PWA version metadata/)
  }
  writeFileSync(filename, JSON.stringify({ ...original, version: '1.2.4' }))
  assert.throws(() => packageRelease(data), /PWA worker version differs/)
})

test('the precache manifest covers exactly the shipped static files and excludes API, WebSocket and credential URLs', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'sw.js')
  const original = readFileSync(filename, 'utf8')
  const replace = transform => { writeFileSync(filename, original); rewriteWorker(data.directory, transform) }
  for (const target of ['connections', 'proxies', 'wss://core.example/connections', 'https://core.example/configs', '/ui/index.html', '../index.html', 'index.html?secret=fixture', 'sw.js', 'version.json']) {
    replace(files => [{ ...files[0], path: target }, ...files.slice(1)])
    assert.throws(() => packageRelease(data), /PWA/, target)
  }
  replace(files => files.slice(1))
  assert.throws(() => packageRelease(data), /PWA precache file count/)
  replace(files => [files[1], ...files.slice(1)])
  assert.throws(() => packageRelease(data), /duplicate PWA precache path/)
})

test('stale precache digests reject publication and preserve the previous archive and checksum', t => {
  const data = fixture(t)
  packageRelease(data)
  const archive = readFileSync(data.archivePath)
  const checksum = readFileSync(`${data.archivePath}.sha256`)
  writeFileSync(path.join(data.directory, 'assets/app.js'), 'console.log("changed without rebuilding the worker")')
  assert.throws(() => packageRelease(data), /PWA precache digest differs: assets\/app\.js/)
  assert.deepEqual(readFileSync(data.archivePath), archive)
  assert.deepEqual(readFileSync(`${data.archivePath}.sha256`), checksum)
  refreshPwa(data.directory)
  assert.doesNotThrow(() => packageRelease(data))
})

test('missing or malformed worker metadata is rejected without evaluating worker JavaScript', t => {
  const data = fixture(t)
  const filename = path.join(data.directory, 'sw.js')
  const original = readFileSync(filename, 'utf8')
  writeFileSync(filename, original.replace(/^const VERSION.*\n/, ''))
  assert.throws(() => packageRelease(data), /Missing PWA worker VERSION/)
  writeFileSync(filename, original.replace(/const STATIC_FILES = .*;/, 'const STATIC_FILES = process.exit(99);'))
  assert.throws(() => packageRelease(data), /Invalid PWA worker STATIC_FILES JSON/)
})
