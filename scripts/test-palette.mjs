// Keep themeable interface colors in the shared palette. Assets retain their own colors.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const colorLiteral = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|\b(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color)\s*\(|\b(?:text|bg|border|ring|outline|fill|stroke)-(?:red|green|blue|yellow|amber|orange|emerald|teal|cyan|sky|indigo|violet|purple|pink|rose|slate|gray|zinc|neutral|stone|white|black)(?:-\d{2,3})?\b|\b(?:color|background(?:-color)?|fill|stroke|border(?:-color)?)\s*:\s*(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|pink|brown|navy|aqua|teal|fuchsia|maroon|lime|olive|silver)\b/gim

async function filesIn(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      // Cartographic geometry and licensed font/image/vector assets are data, not UI tokens.
      if (location === path.join(root, 'src', 'lib', 'data') || entry.name === 'assets') continue
      result.push(...await filesIn(location))
    } else if (/\.(?:svelte|[cm]?[jt]sx?|css)$/.test(entry.name) && location !== path.join(root, 'src', 'app.css')) result.push(location)
  }
  return result
}

test('themeable UI colors use the shared palette', async () => {
  const findings = []
  for (const file of await filesIn(path.join(root, 'src'))) {
    const source = await readFile(file, 'utf8')
    // Preserve line numbers while excluding explanatory comments.
    const code = source.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
    for (const match of code.matchAll(colorLiteral)) {
      const line = code.slice(0, match.index).split('\n').length
      const lineText = source.split('\n')[line - 1]
      if (/^\s*\/\//.test(lineText)) continue
      // A specific licensed logo can opt out beside the declaration, without exempting a page.
      if (/palette-allow:\s*(?:brand|asset)\b/.test(lineText)) continue
      findings.push(`${path.relative(root, file).replaceAll('\\', '/')}:${line}: ${match[0]}`)
    }
  }
  assert.deepEqual(findings, [], `Colors outside src/app.css:\n${findings.join('\n')}`)
})
