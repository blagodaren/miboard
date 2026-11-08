import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveProxyIcon } from '../src/lib/proxy-icon.ts'

test('configured remote icons retain their URL and do not depend on a valid backend', () => {
  assert.equal(resolveProxyIcon('  https://cdn.example/icons/group.svg?v=2  ', 'not-a-url'), 'https://cdn.example/icons/group.svg?v=2')
  assert.equal(resolveProxyIcon('http://router.local:9090/ui/group.png', ''), 'http://router.local:9090/ui/group.png')
})

test('relative icons resolve from the backend path while root-relative paths keep their origin', () => {
  assert.equal(resolveProxyIcon('icons/group.svg', 'https://router.local/api'), 'https://router.local/api/icons/group.svg')
  assert.equal(resolveProxyIcon('icons/group.svg', 'https://router.local/api/'), 'https://router.local/api/icons/group.svg')
  assert.equal(resolveProxyIcon('/ui/icons/group.svg', 'https://router.local/api'), 'https://router.local/ui/icons/group.svg')
  assert.equal(resolveProxyIcon('//cdn.example/group.svg', 'https://router.local/api'), 'https://cdn.example/group.svg')
})

test('image data URLs support raster and SVG image content', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  const svg = 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'
  assert.equal(resolveProxyIcon(png, ''), png)
  assert.equal(resolveProxyIcon(svg, ''), svg)
})

test('unsupported content, credentials and invalid paths fall back instead of loading as icons', () => {
  for (const icon of [undefined, '', ' ', 'javascript:alert(1)', 'data:text/html,<svg/>', 'data:image/svg+xml,', 'file:///C:/icon.svg', 'https://user:secret@cdn.example/icon.png']) {
    assert.equal(resolveProxyIcon(icon, 'https://router.local/api'), null, String(icon))
  }
  assert.equal(resolveProxyIcon('icons/group.svg', 'not-a-url'), null)
})
