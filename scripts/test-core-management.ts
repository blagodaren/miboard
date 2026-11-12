import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { CoreManagementError, applyFleetAction, readCoreSnapshot, rebaseRuntimeDraft, runCoreFleet, runtimeDraft, runtimePatch, unsupportedCoreAction, upgradeCore, writeRuntimeSettings, type CoreRequest } from '../src/lib/core-management.ts'
import type { Backend, Configs, SavedBackend } from '../src/lib/api.ts'

const core: Backend = { url: 'http://core.test:9090', secret: 'original-secret' }
const config: Configs = { mode: 'rule', 'log-level': 'info', ipv6: false, sniffing: true, 'tcp-concurrent': false, port: 7890, 'socks-port': 7891, 'mixed-port': 0, 'redir-port': 0, 'tproxy-port': 0 }
const profile = (id: string): SavedBackend => ({ id, url: `http://${id}.test:9090`, secret: id })
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
const isCode = (code: CoreManagementError['code']) => (error: unknown) => error instanceof CoreManagementError && error.code === code
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }

test('runtime form preserves unsupported fields and produces only supported changed fields', () => {
  const minimal: Configs = { mode: 'rule', 'log-level': 'info' }
  assert.deepEqual(runtimeDraft(null), {})
  assert.deepEqual(runtimeDraft(minimal), { 'log-level': 'info' })
  assert.deepEqual(runtimePatch(config, runtimeDraft(config)), { patch: {}, issues: [], changesPorts: false })
  const plan = runtimePatch(config, { ...runtimeDraft(config), ipv6: true, 'log-level': 'warning', 'mixed-port': ' 8080 ' })
  assert.deepEqual(plan.patch, { 'log-level': 'warning', ipv6: true, 'mixed-port': 8080 })
  assert.equal(plan.changesPorts, true)
  assert.deepEqual(plan.issues, [])
  assert.deepEqual(runtimePatch(minimal, { ipv6: true, port: '8080' }).issues, [{ field: 'ipv6', code: 'unsupported' }, { field: 'port', code: 'unsupported' }])
})

test('ports reject blanks, signs, decimals, exponent notation and out of range values', () => {
  for (const value of ['', ' ', '-1', '+80', '3.5', '1e3', '65536', 'NaN', 'Infinity']) {
    assert.ok(runtimePatch(config, { port: value }).issues.some(issue => issue.field === 'port' && issue.code === 'port'), value)
  }
  for (const value of ['0', '80', '65535']) assert.deepEqual(runtimePatch(config, { port: value }).issues, [], value)
  assert.equal(runtimePatch(config, { 'log-level': 'trace' }).issues[0]?.code, 'logLevel')
})

test('new port collisions are blocked, disabled listeners and existing shared ports are retained', () => {
  assert.deepEqual(runtimePatch(config, { port: '7891' }).issues.map(issue => issue.field), ['port', 'socks-port'])
  assert.deepEqual(runtimePatch(config, { port: '0', 'socks-port': '0' }).issues, [])
  const shared = { ...config, port: 7891 }
  assert.deepEqual(runtimePatch(shared, { ...runtimeDraft(shared), ipv6: true }).issues, [])
})

test('runtime patch pins backend and draft before awaiting and verifies readback', async () => {
  const backend = { ...core }, draft = { ...runtimeDraft(config), ipv6: true }
  const hold = gate(), calls: Array<{ path: string; backend: Backend; body: unknown }> = []
  const send: CoreRequest = async <T>(path: string, options: Parameters<CoreRequest>[1], selected: Backend): Promise<T> => {
    calls.push({ path, backend: { ...selected }, body: options.body })
    if (options.method === 'PATCH') { await hold.promise; return undefined as T }
    return { ...config, ipv6: true } as T
  }
  const operation = writeRuntimeSettings(send, backend, config, draft, new AbortController().signal)
  backend.url = 'http://other.test'; backend.secret = 'new-secret'; draft.ipv6 = false
  hold.resolve()
  assert.equal((await operation).ipv6, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.backend), [core, core])
  assert.deepEqual(calls[0].body, { ipv6: true })
})

test('unsupported and silently ignored writes never report success', async () => {
  const unavailable: CoreRequest = async () => { throw httpError(405) }
  await assert.rejects(writeRuntimeSettings(unavailable, core, config, { ipv6: true }, new AbortController().signal), isCode('unsupported'))
  const ignored: CoreRequest = async <T>(_path: string, options: Parameters<CoreRequest>[1]): Promise<T> => options.method === 'PATCH' ? undefined as T : config as T
  await assert.rejects(writeRuntimeSettings(ignored, core, config, { ipv6: true }, new AbortController().signal), error => {
    assert.ok(isCode('verify')(error)); assert.deepEqual((error as CoreManagementError).observed, config); return true
  })
  assert.equal(unsupportedCoreAction(httpError(404)), true)
  assert.equal(unsupportedCoreAction(httpError(500)), false)
})

test('retrying a partial write never restores unrelated settings changed by another client', () => {
  const requested = { ...runtimeDraft(config), ipv6: true, 'mixed-port': '8080' }
  // The core applied the port but ignored IPv6, while another client changed sniffing/logging.
  const observed: Configs = { ...config, 'mixed-port': 8080, sniffing: false, 'log-level': 'debug' }
  const rebased = rebaseRuntimeDraft(config, requested, observed)
  assert.equal(rebased.sniffing, false)
  assert.equal(rebased['log-level'], 'debug')
  assert.deepEqual(runtimePatch(observed, rebased).patch, { ipv6: true })
})

test('invalid or already-cancelled edits send no request; cancellation after write skips readback', async () => {
  let calls = 0
  const abort = new AbortController()
  const send: CoreRequest = async <T>(): Promise<T> => { calls++; abort.abort(); return undefined as T }
  await assert.rejects(writeRuntimeSettings(send, core, config, { port: '70000' }, abort.signal), isCode('invalid'))
  assert.equal(calls, 0)
  await assert.rejects(writeRuntimeSettings(send, core, config, { ipv6: true }, abort.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  await assert.rejects(writeRuntimeSettings(send, core, config, { ipv6: true }, abort.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('core upgrade tolerates a restart, sends POST once and never issues a second restart', async () => {
  const paths: string[] = [], backend = { ...core }, captured: Backend[] = []
  let versions = 0
  const send: CoreRequest = async <T>(path: string, _options: Parameters<CoreRequest>[1], selected: Backend): Promise<T> => {
    paths.push(path); captured.push({ ...selected })
    if (path === '/upgrade') { backend.url = 'http://replacement.test'; backend.secret = 'changed'; throw httpError(0) }
    if (++versions === 2) throw httpError(0)
    return { version: versions === 1 ? 'v1' : 'v2' } as T
  }
  const result = await upgradeCore(send, backend, 'core', new AbortController().signal, async () => {})
  assert.deepEqual(result, { previousVersion: 'v1', version: 'v2', outcome: 'versionChanged' })
  assert.equal(paths.filter(path => path === '/upgrade').length, 1)
  assert.equal(paths.includes('/restart'), false)
  assert.ok(captured.every(value => value.url === core.url && value.secret === core.secret))
})

test('lost upgrade response with unchanged version remains unconfirmed', async () => {
  let writes = 0
  const send: CoreRequest = async <T>(path: string): Promise<T> => {
    if (path === '/upgrade') { writes++; throw httpError(0) }
    return { version: 'v1' } as T
  }
  const result = await upgradeCore(send, core, 'core', new AbortController().signal, async () => {})
  assert.equal(result.outcome, 'unconfirmed'); assert.equal(writes, 1)
})

test('UI and Geo upgrades use distinct endpoints; unsupported actions do not poll or retry', async () => {
  for (const action of ['ui', 'geo'] as const) {
    const paths: string[] = []
    const send: CoreRequest = async <T>(path: string): Promise<T> => { paths.push(path); return (path === '/version' ? { version: 'v1' } : undefined) as T }
    assert.equal((await upgradeCore(send, core, action, new AbortController().signal, async () => {})).outcome, 'accepted')
    assert.deepEqual(paths, ['/version', `/upgrade/${action}`, '/version'])
  }
  const paths: string[] = []
  const send: CoreRequest = async <T>(path: string): Promise<T> => { paths.push(path); if (path === '/version') return { version: 'v1' } as T; throw httpError(404) }
  await assert.rejects(upgradeCore(send, core, 'geo', new AbortController().signal, async () => {}), isCode('unsupported'))
  assert.deepEqual(paths, ['/version', '/upgrade/geo'])
})

test('upgrades report unreachable core after bounded probes and propagate authorization errors', async () => {
  let calls = 0
  const send: CoreRequest = async <T>(path: string): Promise<T> => {
    calls++
    if (calls === 1) return { version: 'v1' } as T
    if (path === '/upgrade') return undefined as T
    throw httpError(0)
  }
  await assert.rejects(upgradeCore(send, core, 'core', new AbortController().signal, async () => {}), isCode('unreachable'))
  assert.equal(calls, 12)
  let deniedCalls = 0
  const denied: CoreRequest = async <T>(path: string): Promise<T> => { deniedCalls++; if (path === '/version') return { version: 'v1' } as T; throw httpError(403) }
  await assert.rejects(upgradeCore(denied, core, 'core', new AbortController().signal, async () => {}), { message: 'HTTP 403' })
  assert.equal(deniedCalls, 2)
})

test('fleet read uses REST snapshots, preserves partial errors and pins the selected backend', async () => {
  const backend = { ...core }, seen: Backend[] = []
  const send: CoreRequest = async <T>(path: string, _options: Parameters<CoreRequest>[1], selected: Backend): Promise<T> => {
    seen.push({ ...selected }); backend.url = 'http://changed.test'
    if (path === '/version') return { version: 'v1' } as T
    if (path === '/configs') throw httpError(403)
    assert.equal(path, '/connections')
    return { connections: [1, 2], downloadTotal: 200, uploadTotal: -10 } as T
  }
  const result = await readCoreSnapshot(send, backend, new AbortController().signal)
  assert.equal(result.version, 'v1'); assert.equal(result.mode, null); assert.equal(result.connections, 2)
  assert.equal(result.download, 200); assert.equal(result.upload, null)
  assert.equal(result.errors[0].source, 'configs')
  assert.ok(seen.every(value => value.url === core.url && value.secret === core.secret))
})

test('fleet mutations are pinned and mode guard applies before any request', async () => {
  const backend = { ...core }, seen: Array<{ path: string; options: Parameters<CoreRequest>[1]; selected: Backend }> = []
  const send: CoreRequest = async <T>(path: string, options: Parameters<CoreRequest>[1], selected: Backend): Promise<T> => {
    seen.push({ path, options, selected: { ...selected } }); backend.url = 'http://changed.test'
    return { ...config, mode: 'global' } as T
  }
  const signal = new AbortController().signal
  await assert.rejects(applyFleetAction(send, backend, { kind: 'mode', mode: 'global' }, signal, { hideMode: true }), isCode('restricted'))
  assert.equal(seen.length, 0)
  await applyFleetAction(send, backend, { kind: 'mode', mode: 'global' }, signal)
  assert.equal(seen.length, 2); assert.ok(seen.every(call => call.selected.url === core.url))
  assert.deepEqual(seen[0].options.body, { mode: 'global' })
  await applyFleetAction(send, core, { kind: 'close' }, signal)
  assert.equal(seen[2].path, '/connections'); assert.equal(seen[2].options.method, 'DELETE')
  await applyFleetAction(send, core, { kind: 'reload' }, signal)
  assert.equal(seen[3].options.method, 'PUT'); assert.deepEqual(seen[3].options.query, { force: 'true' })
})

test('fleet workers cap concurrency, snapshot queued credentials and preserve partial failures', async () => {
  const profiles = ['one', 'two', 'three', 'four'].map(profile), hold = gate()
  const seen: SavedBackend[] = []
  let current = 0, peak = 0
  const pending = runCoreFleet(profiles, async selected => {
    current++; peak = Math.max(peak, current); seen.push({ ...selected }); await hold.promise; current--
    if (selected.id === 'two') throw new Error('offline')
    return selected.url
  }, new AbortController().signal, () => {}, 2)
  assert.equal(seen.length, 2)
  profiles[2].secret = 'changed-after-start'; profiles[3].url = 'http://different.test'; profiles.push(profile('five'))
  hold.resolve()
  const results = await pending
  assert.equal(peak, 2); assert.equal(results.length, 4)
  assert.deepEqual(results.map(value => value.status), ['success', 'error', 'success', 'success'])
  assert.equal(seen[2].secret, 'three'); assert.equal(seen[3].url, 'http://four.test:9090')
})

test('fleet cancellation leaves queued profiles untouched and labels in-flight results uncertain', async () => {
  const abort = new AbortController(), hold = gate(), seen: string[] = []
  const operation = runCoreFleet(['one', 'two', 'three'].map(profile), async selected => { seen.push(selected.id); await hold.promise; return true }, abort.signal, () => {}, 1)
  await tick(); abort.abort(); hold.resolve()
  const results = await operation
  assert.deepEqual(seen, ['one']); assert.deepEqual(results.map(value => value.status), ['cancelled', 'cancelled', 'cancelled'])
})
