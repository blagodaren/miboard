import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { appBuildId } from './pwa-build.mjs'

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
