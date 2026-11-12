import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { FONT_SOURCES } from './font-sources.mjs'

test('CSP allows exactly the theme bootstrap hash and local scripts', () => {
  // HTML parsing normalizes line endings before checking inline script hashes.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n?/g, '\n')
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"\s*\/>/)
  assert(meta, 'Entry HTML must contain CSP')
  assert(html.indexOf(meta[0]) < html.indexOf('<script'), 'CSP must precede scripts')
  const directives = new Map(meta[1].split(';').map(value => value.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs]) => !/\bsrc=/.test(attrs))
  assert.equal(inline.length, 1)
  const hash = createHash('sha256').update(inline[0][2]).digest('base64')
  assert.deepEqual(directives.get('script-src'), ["'self'", `'sha256-${hash}'`], 'Update the CSP hash whenever the theme bootstrap changes')
  for (const name of ['script-src-attr', 'object-src', 'base-uri', 'form-action', 'frame-src']) assert.deepEqual(directives.get(name), ["'none'"])
  for (const font of FONT_SOURCES) assert(directives.get('font-src').includes(new URL(font.cdn).origin))
  for (const protocol of ['http:', 'https:', 'ws:', 'wss:']) assert(directives.get('connect-src').includes(protocol), 'User-selected controllers must remain reachable')
})
