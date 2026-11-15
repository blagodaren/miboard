import assert from 'node:assert/strict'
import test from 'node:test'
import { parseThemeParam, validThemeSource } from '../src/lib/theme-source.ts'

const page = 'http://192.168.1.1:9090'
test('theme link parameter accepts HTTPS, same-origin and loopback HTTP only', () => {
  assert.equal(parseThemeParam(null, page), undefined)
  for (const off of ['', 'off', '0', 'none', ' OFF ']) assert.equal(parseThemeParam(off, page), null)
  assert.equal(parseThemeParam('https://cdn.example/theme.css', page), 'https://cdn.example/theme.css')
  assert.equal(parseThemeParam('/ui/theme.css', page), 'http://192.168.1.1:9090/ui/theme.css')
  assert.equal(parseThemeParam('http://127.0.0.1:9097/theme.css', page), 'http://127.0.0.1:9097/theme.css')
  assert.equal(parseThemeParam('http://[::1]:9097/theme.css', page), 'http://[::1]:9097/theme.css')
  assert.equal(parseThemeParam('http://evil.example/theme.css', page), undefined)
  assert.equal(parseThemeParam('javascript:alert(1)', page), undefined)
  assert.equal(parseThemeParam('data:text/css,a{}', page), undefined)
})

test('theme link parameter accepts the page\'s own origin under an app scheme', () => {
  const app = 'miboard://app'
  assert.equal(parseThemeParam('miboard://app/prizrak-theme.css', app), 'miboard://app/prizrak-theme.css')
  assert.equal(parseThemeParam('miboard://APP/theme.css', app), 'miboard://APP/theme.css')
  assert.equal(parseThemeParam('/theme.css', app), 'miboard://app/theme.css')
  assert.equal(parseThemeParam('miboard://app:9090/theme.css', app), undefined)
  assert.equal(parseThemeParam('miboard://APP:9090/theme.css', 'miboard://app:9090'), 'miboard://APP:9090/theme.css')
  assert.equal(parseThemeParam('miboard://other/prizrak-theme.css', app), undefined)
  assert.equal(parseThemeParam('other://app/prizrak-theme.css', app), undefined)
  assert.equal(parseThemeParam('http://evil.example/theme.css', app), undefined)
  assert.equal(parseThemeParam('javascript:alert(1)', app), undefined)
  assert.equal(parseThemeParam('data:text/css,a{}', app), undefined)
  assert.equal(parseThemeParam('https://cdn.example/theme.css', app), 'https://cdn.example/theme.css')
  assert.equal(parseThemeParam('http://127.0.0.1:9090/ui/theme.css', app), 'http://127.0.0.1:9090/ui/theme.css')
})

test('stored theme source shape is checked', () => {
  assert.equal(validThemeSource({ url: 'https://a/b.css', css: '', updatedAt: 0, enabled: true }), true)
  assert.equal(validThemeSource({ url: 'https://a/b.css', css: '', updatedAt: 0 }), false)
  assert.equal(validThemeSource('x'), false)
})
