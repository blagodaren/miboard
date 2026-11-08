// Bundle license texts from the installed runtime dependency graph.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, 'public/licenses/dependencies-NOTICE.txt')
const project = readJson(path.join(root, 'package.json'))
const visited = new Set()
const packages = new Map()
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
// These exact upstream versions publish an MIT declaration but no license file.
// Keep the declaration and author explicit instead of inventing a copyright date.
const readmeOnlyLicenses = new Map([
  ['is-reference@3.0.3', 'https://github.com/Rich-Harris/is-reference#license'],
  ['locate-character@3.0.0', 'https://github.com/Rich-Harris/locate-character#license'],
])

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function readText(filename) {
  const text = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error(`Empty license or notice: ${path.relative(root, filename)}`)
  return text
}

function resolvePackage(name, from, optional) {
  // Search package directories directly: some packages hide package.json in exports.
  const require = createRequire(path.join(from, 'package.json'))
  for (const directory of require.resolve.paths(name) ?? []) {
    const filename = path.join(directory, name, 'package.json')
    if (fs.existsSync(filename)) return fs.realpathSync(path.dirname(filename))
  }
  if (optional) return null
  throw new Error(`Missing installed runtime dependency: ${name}. Run npm ci before building.`)
}

function dependencyEntries(manifest, peers = true) {
  const dependencies = new Map(Object.keys(manifest.dependencies ?? {}).map(name => [name, false]))
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) dependencies.set(name, true)
  if (peers) {
    for (const name of Object.keys(manifest.peerDependencies ?? {})) {
      if (!dependencies.has(name)) dependencies.set(name, manifest.peerDependenciesMeta?.[name]?.optional === true)
    }
  }
  return [...dependencies].sort(([a], [b]) => compare(a, b))
}

function licenseName(manifest, texts = []) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) return manifest.license.trim()
  if (manifest.license?.type) return manifest.license.type
  if (Array.isArray(manifest.licenses) && manifest.licenses.length) {
    return manifest.licenses.map(license => typeof license === 'string' ? license : license.type).join(' OR ')
  }
  const title = texts[0]?.text.split('\n')[0]
  if (/^(?:The )?MIT License(?: \(MIT\))?$/i.test(title ?? '')) return 'MIT'
  if (/^ISC License$/i.test(title ?? '')) return 'ISC'
  if (/^Apache License$/i.test(title ?? '')) return 'Apache-2.0'
  if (texts.length) return 'See included license text'
  throw new Error(`Missing license metadata: ${manifest.name}@${manifest.version}`)
}

function sourceUrl(manifest) {
  let source = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (source) {
    source = source.replace(/^github:/, 'https://github.com/').replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://').replace(/^git@([^:]+):/, 'https://$1/')
    if (/^[\w.-]+\/[\w.-]+$/.test(source)) source = `https://github.com/${source}`
    if (/^https?:\/\//.test(source)) {
      const url = new URL(source)
      url.username = url.password = ''
      url.pathname = url.pathname.replace(/\.git$/, '')
      return url.href
    }
  }
  return `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`
}

function licenseTexts(directory, manifest) {
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name))
    .map(entry => entry.name)
  const declaredFile = typeof manifest.license === 'string' && manifest.license.match(/^SEE LICEN[CS]E IN\s+(.+)$/i)?.[1]
  if (declaredFile) {
    const relative = path.relative(directory, path.resolve(directory, declaredFile))
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`License path escapes package: ${manifest.name}@${manifest.version}`)
    }
    if (!files.includes(relative)) files.push(relative)
  }
  files.sort(compare)
  if (!declaredFile && !files.some(filename => /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(filename))) {
    const source = readmeOnlyLicenses.get(`${manifest.name}@${manifest.version}`)
    if (!source || manifest.license !== 'MIT' || manifest.author !== 'Rich Harris') {
      throw new Error(`Missing license text: ${manifest.name}@${manifest.version}`)
    }
    const readme = readText(path.join(directory, 'README.md'))
    if (!/^## License\s+MIT\s*$/m.test(readme)) {
      throw new Error(`Upstream license declaration changed: ${manifest.name}@${manifest.version}`)
    }
    const terms = readText(path.join(root, 'LICENSE')).match(/^Permission is hereby granted,[\s\S]+$/m)?.[0]
    if (!terms) throw new Error('The project LICENSE does not contain the standard MIT permission and disclaimer')
    return [{
      filename: 'README.md — license declaration and standard MIT terms',
      text: `Author: Rich Harris\nDeclaration source: ${source}\n\n` +
        'Upstream declares MIT in README/package metadata and provides no separate license file.\n' +
        'No copyright year or notice is supplied by upstream.\n\n' +
        'Upstream license declaration:\nMIT\n\n' +
        `Standard MIT permission and disclaimer:\n\n${terms}`,
    }]
  }
  return files.map(filename => ({ filename: filename.replaceAll(path.sep, '/'), text: readText(path.join(directory, filename)) }))
}

function visit(name, from, optional = false) {
  const directory = resolvePackage(name, from, optional)
  if (!directory || visited.has(directory)) return
  visited.add(directory)
  const manifest = readJson(path.join(directory, 'package.json'))
  if (!manifest.name || !manifest.version) throw new Error(`Missing package name or version: ${name}`)
  const identity = `${manifest.name}@${manifest.version}`
  const texts = licenseTexts(directory, manifest)
  const entry = {
    identity,
    license: licenseName(manifest, texts),
    source: sourceUrl(manifest),
    texts,
  }
  const previous = packages.get(identity)
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
    throw new Error(`Conflicting installed license texts: ${identity}`)
  }
  packages.set(identity, entry)
  for (const [dependency, isOptional] of dependencyEntries(manifest)) visit(dependency, directory, isOptional)
}

try {
  for (const [name, optional] of dependencyEntries(project, false)) visit(name, root, optional)
  // Svelte is a build dependency whose runtime is also shipped in the bundle.
  visit('svelte', root)

  const separator = '='.repeat(80)
  const sections = [
    `MIBoard ${project.version} — ${licenseName(project)}\n\n${readText(path.join(root, 'LICENSE'))}`,
    'Third-party JavaScript notices\n\n' +
      'Generated by scripts/licenses.mjs from installed production dependencies,\n' +
      'their transitive dependencies and installed peers, plus the Svelte runtime.\n' +
      'This conservative list may include code removed during bundling.\n' +
      'Font, logo and GeoIP licenses are distributed separately in licenses/ and geodb/.',
  ]
  for (const entry of [...packages.values()].sort((a, b) => compare(a.identity, b.identity))) {
    sections.push(`${entry.identity}\nLicense: ${entry.license}\nSource: ${entry.source}\n\n` +
      entry.texts.map(({ filename, text }) => `[${filename}]\n\n${text}`).join('\n\n'))
  }
  sections.push(`Bundled Natural Earth map data\n\n${readText(path.join(root, 'src/lib/data/NOTICE.md'))}`)
  const contents = `${sections.join(`\n\n${separator}\n\n`)}\n`
  fs.mkdirSync(path.dirname(output), { recursive: true })
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== contents) fs.writeFileSync(output, contents)
  console.log(`Licenses: MIBoard ${project.version}, ${packages.size} dependency packages and Natural Earth → public/licenses/dependencies-NOTICE.txt`)
} catch (error) {
  console.error(`License collection failed: ${error.message}`)
  process.exitCode = 1
}
