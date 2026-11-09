import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const digest = data => createHash('sha256').update(data).digest('hex')
function filesIn(folder, prefix = '') {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = `${prefix}${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`PWA assets cannot be symlinks: ${name}`)
    return entry.isDirectory() ? filesIn(path.join(folder, entry.name), `${name}/`) : [name]
  }).sort()
}

/** Stable across repeat builds; changes even when a deployment keeps the same release version. */
export function appBuildId(mode, sourceRoot = root) {
  const hash = createHash('sha256').update(mode)
  const sources = [
    ...filesIn(path.join(sourceRoot, 'src')).map(name => `src/${name}`),
    ...filesIn(path.join(sourceRoot, 'public')).map(name => `public/${name}`),
    'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'svelte.config.js',
    'scripts/font-sources.mjs', 'scripts/pwa-build.mjs', 'scripts/service-worker.js',
  ].sort()
  for (const name of sources) hash.update(name).update('\0').update(readFileSync(path.join(sourceRoot, name))).update('\0')
  return hash.digest('hex').slice(0, 16)
}

export function pwaBuild(buildId) {
  let outDir
  return {
    name: 'miboard-pwa',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    closeBundle() {
      const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
      const metadata = { version, buildId }
      // Nothing fetched at runtime is added to this list: controller data and credentials
      // can never become offline resources, even with a controller under the same origin.
      const assets = filesIn(outDir).filter(name => !['sw.js', 'version.json'].includes(name))
        .map(name => ({ path: name, sha256: digest(readFileSync(path.join(outDir, name))) }))
      const worker = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')
      writeFileSync(path.join(outDir, 'version.json'), JSON.stringify(metadata) + '\n')
      writeFileSync(path.join(outDir, 'sw.js'), `const VERSION = ${JSON.stringify(metadata)};\nconst STATIC_FILES = ${JSON.stringify(assets)};\n${worker}`)
    },
  }
}
