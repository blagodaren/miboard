import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { coreProfileFilename, fetchCoreProfile } from '../src/lib/core-profiles.ts'

const backend = { url: 'http://controller.test/prefix/', secret: 'private-test-token' }
const profile = gzipSync('profile-fixture')
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch

test('profiles use explicit read-only endpoints and authorization headers without URL credentials', async () => {
  for (const kind of ['heap', 'allocs'] as const) {
    const blob = await fetchCoreProfile(backend, kind, undefined, { fetch: fakeFetch(async (url, init) => {
      assert.equal(url, `http://controller.test/prefix/debug/pprof/${kind}`)
      assert.equal(init.method, 'GET')
      assert.deepEqual(init.headers, { Authorization: 'Bearer private-test-token' })
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
      return new Response(profile)
    }) })
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), profile)
  }
  assert.match(coreProfileFilename('heap', new Date('2026-11-10T12:30:00Z')), /^mihomo-heap-2026-11-10T12-30-00-000Z\.pprof$/)
})

test('unavailable/auth failures and HTML fallback do not become downloaded profiles', async () => {
  for (const [status, code] of [[404, 'unsupported'], [405, 'unsupported'], [401, 'unauthorized'], [403, 'unauthorized'], [500, 'http']] as const) {
    await assert.rejects(fetchCoreProfile(backend, 'heap', undefined, { fetch: fakeFetch(async () => new Response('PRIVATE-BODY', { status })) }), { code })
  }
  for (const body of ['<!doctype html><title>Dashboard</title>', '{}', '']) {
    await assert.rejects(fetchCoreProfile(backend, 'heap', undefined, { fetch: fakeFetch(async () => new Response(body)) }), { code: 'invalid' })
  }
  await assert.rejects(fetchCoreProfile(backend, '../gc' as 'heap'), { code: 'invalid' })
})

test('profile size is bounded with and without Content-Length', async () => {
  await assert.rejects(fetchCoreProfile(backend, 'heap', undefined, { maxBytes: 10, fetch: fakeFetch(async () => new Response(profile, { headers: { 'Content-Length': '100' } })) }), { code: 'tooLarge' })
  let canceled = false
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([0x1f, 0x8b, 8, 9])) }, cancel() { canceled = true } })
  await assert.rejects(fetchCoreProfile(backend, 'heap', undefined, { maxBytes: 10, fetch: fakeFetch(async () => new Response(body)) }), { code: 'tooLarge' })
  assert.equal(canceled, true)
})

test('cancellation and timeout remain active while reading the response body', async () => {
  const hanging = fakeFetch(async (_url, init) => new Response(new ReadableStream({
    start(controller) { init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true }) },
  })))
  await assert.rejects(fetchCoreProfile(backend, 'heap', undefined, { fetch: hanging, timeoutMs: 10 }), { code: 'timeout' })
  const abort = new AbortController()
  const request = fetchCoreProfile(backend, 'heap', abort.signal, { fetch: hanging })
  abort.abort()
  await assert.rejects(request, { name: 'AbortError' })
  const already = new AbortController(); already.abort()
  let called = false
  await assert.rejects(fetchCoreProfile(backend, 'heap', already.signal, { fetch: fakeFetch(async () => { called = true; return new Response(profile) }) }), { name: 'AbortError' })
  assert.equal(called, false)
})
