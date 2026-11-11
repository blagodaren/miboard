import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { appBuildId, pwaBuild } from './pwa-build.mjs'

test('every build input changes the offline cache identity, including entry HTML and font transformation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'miboard-pwa-build-'))
  const sources = ['src/App.svelte', 'public/manifest.webmanifest', 'index.html', 'package.json', 'package-lock.json',
    'vite.config.ts', 'tsconfig.json', 'svelte.config.js', 'scripts/font-sources.mjs', 'scripts/pwa-build.mjs', 'scripts/service-worker.js']
  try {
    for (const name of sources) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), name)
    }
    const first = appBuildId('production', root)
    assert.match(first, /^[0-9a-f]{16}$/)
    assert.equal(appBuildId('production', root), first, 'Identical builds have stable cache IDs')
    assert.notEqual(appBuildId('cdn-fonts', root), first, 'Font variants cannot share a cache')
    for (const name of sources) {
      const file = path.join(root, name)
      const before = readFileSync(file)
      writeFileSync(file, `${before}\nchanged`)
      assert.notEqual(appBuildId('production', root), first, `${name} invalidates the cache`)
      writeFileSync(file, before)
    }
    writeFileSync(path.join(root, 'src/new-page.svelte'), '<h1>New page</h1>')
    assert.notEqual(appBuildId('production', root), first, 'Added source files invalidate the cache')
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline manifest includes lazy page JavaScript and CSS with verified hashes', async () => {
  const { createHash } = await import('node:crypto')
  const root = mkdtempSync(path.join(os.tmpdir(), 'miboard-pwa-chunks-'))
  const files = {
    'index.html': '<html>entry</html>',
    'assets/index-entry.js': 'import("./Geography-page.js")',
    'assets/Geography-page.js': 'export default function Geography() {}',
    'assets/Geography-page.css': '.map { display: grid }',
    'assets/shared-chart.js': 'export const chart = true',
  }
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
      writeFileSync(path.join(root, name), content)
    }
    const plugin = pwaBuild('lazy-pages-fixture')
    plugin.configResolved({ root, build: { outDir: '.' } })
    plugin.closeBundle()
    const worker = readFileSync(path.join(root, 'sw.js'), 'utf8')
    const manifest = JSON.parse(worker.match(/^const STATIC_FILES = (.*);$/m)[1])
    assert.deepEqual(manifest, Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({
      path: name, sha256: createHash('sha256').update(content).digest('hex'),
    })))
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    rmSync(root, { recursive: true, force: true })
  }
})
