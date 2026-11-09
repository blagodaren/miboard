import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const code = new Map<string, string>()
for (const file of ['api', 'devices', 'latency', 'appearance', 'live-updates', 'proxy-test-selection', 'settings-transfer', 'settings-sync']) {
  code.set('./' + file, ts.transpileModule(readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)
}
const url = 'http://router.test:9090'
const otherUrl = 'http://other.test:9090'
const aliasesKey = (backend = url) => 'miboard.device-names.' + encodeURIComponent(backend)
const sortKey = (group: string, backend = url) => 'miboard.proxy-sort.v1' + JSON.stringify([backend, group])
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
function session(seed: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  let failKey: string | null = null
  const modules = new Map<string, any>()
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, btoa, AbortController, crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    localStorage: {
      get length() { return store.size }, key(index: number) { return [...store.keys()][index] ?? null },
      getItem(key: string) { return store.get(key) ?? null },
      setItem(key: string, value: string) {
        if (key === failKey) { failKey = null; throw new DOMException('Quota exceeded', 'QuotaExceededError') }
        store.set(key, String(value))
      },
      removeItem(key: string) { store.delete(key) },
    },
    fetch() { throw new Error('Unexpected network') }, WebSocket: class { constructor() { throw new Error('Unexpected socket') } },
  })
  function load(id: string): any {
    id = id.replace(/\.ts$/, '')
    if (id === './i18n.svelte') return { t: (key: string) => key }
    if (modules.has(id)) return modules.get(id)
    assert.ok(code.has(id), `Unexpected module ${id}`)
    const exports = {}; modules.set(id, exports)
    vm.runInContext(`(function(exports, require) {\n${code.get(id)}\n})`, context, { filename: id })(exports, load)
    return exports
  }
  return { sync: load('./settings-sync'), store, snapshot: () => [...store.entries()].sort(([a], [b]) => a.localeCompare(b)), failNext(key: string) { failKey = key } }
}
const data = (extra: Record<string, unknown> = {}) => ({ deviceNames: {}, proxySort: [], preferences: {}, ...extra })
const document = (extra: Record<string, unknown> = {}) => ({ format: 'miboard-sync', version: 1, revision: 'test-revision-0001', updatedAt: '2026-11-09T12:00:00.000Z', data: data(), ...extra })

test('sync exports only the connected core names/sorts, never controller profiles, addresses or secrets', () => {
  const s = session({
    'miboard.backend': { url, secret: 'PRIVATE-SECRET', name: 'My server' },
    'miboard.secrets': { [url]: 'PRIVATE-SECRET' },
    'miboard.backends': [{ id: 'one', url, secret: 'PRIVATE-SECRET' }, { id: 'two', url: otherUrl, secret: 'OTHER-SECRET' }],
    [aliasesKey()]: { '192.168.1.10': 'Laptop' }, [aliasesKey(otherUrl)]: { '10.0.0.2': 'Foreign device' },
    [sortKey('Main')]: { key: 'name', direction: 'asc' }, [sortKey('Private', otherUrl)]: { key: 'latency', direction: 'desc' },
    'miboard.theme': 'dark', 'miboard.locale': 'ru', 'miboard.diagnostics': 'PRIVATE-HISTORY',
  })
  const before = s.snapshot()
  const output = s.sync.createSyncDocument(s.sync.localSyncData(url), url)
  const json = JSON.stringify(output)
  assert.deepEqual(plain(output.data.deviceNames), { '192.168.1.10': 'Laptop' })
  assert.deepEqual(plain(output.data.proxySort), [{ group: 'Main', key: 'name', direction: 'asc' }])
  assert.equal(output.data.preferences.theme, 'dark')
  for (const forbidden of [url, otherUrl, 'PRIVATE-SECRET', 'OTHER-SECRET', 'PRIVATE-HISTORY', 'Foreign device', 'backendUrl', 'servers', 'secret']) assert.ok(!json.includes(forbidden), forbidden)
  assert.match(output.revision, /^[a-f0-9]{32}$/)
  assert.deepEqual(s.snapshot(), before)
})

test('remote schema rejects credentials and unknown keys at every portable boundary', () => {
  const s = session()
  const bad = [
    document({ secret: 'no' }), document({ servers: [] }), document({ version: 2 }), document({ revision: '' }),
    document({ data: data({ servers: [{ url, secret: 'no' }] }) }),
    document({ data: data({ proxySort: [{ group: 'Main', key: 'name', direction: 'asc', backendUrl: otherUrl }] }) }),
    document({ data: data({ preferences: { credentials: 'no' } }) }),
    document({ data: data({ deviceNames: { 'not-an-ip': 'Laptop' } }) }),
    JSON.parse(JSON.stringify(document()).replace('"deviceNames":{}', '"deviceNames":{"__proto__":"oops"}')),
  ]
  for (const value of bad) assert.throws(() => s.sync.parseSyncDocument(value, url), (error: any) => error.code === 'invalid')
  assert.equal(s.sync.parseSyncDocument(null, url), null)
  assert.throws(() => s.sync.parseSyncDocument(document({ huge: 'x'.repeat(1024 * 1024) }), url), (error: any) => error.code === 'size')
})

test('bulk selection sync is scoped to the active core and older copies preserve it', () => {
  const key = (backend: string) => 'miboard.proxy-test-selection.v1.' + encodeURIComponent(backend)
  const s = session({
    [key(url)]: { mode: 'selected', groups: ['Main'] },
    [key(otherUrl)]: { mode: 'selected', groups: ['Foreign private group'] },
    'miboard.proxy-group-height': 'compact', 'miboard.live-update-mode': 'eco',
  })
  const local = s.sync.localSyncData(url)
  assert.deepEqual(plain(local.proxyTestSelection), { mode: 'selected', groups: ['Main'] })
  assert.equal(local.preferences.proxyGroupHeight, 'compact')
  assert.equal(local.preferences.liveUpdateMode, 'eco')
  const output = JSON.stringify(s.sync.createSyncDocument(local, url))
  for (const privateValue of [url, otherUrl, 'Foreign private group', 'backendUrl']) assert.ok(!output.includes(privateValue))
  const old = s.sync.parseSyncDocument(document(), url)
  s.sync.applySyncPull(s.sync.previewSync('pull', old, url), url)
  assert.deepEqual(JSON.parse(s.store.get(key(url))!), { mode: 'selected', groups: ['Main'] })
  const remote = s.sync.parseSyncDocument(document({ data: data({ proxyTestSelection: { mode: 'all', groups: [] } }) }), url)
  s.sync.applySyncPull(s.sync.previewSync('pull', remote, url), url)
  assert.equal(JSON.parse(s.store.get(key(url))!).mode, 'all')
  assert.deepEqual(JSON.parse(s.store.get(key(otherUrl))!), { mode: 'selected', groups: ['Foreign private group'] })
  assert.throws(() => s.sync.parseSyncDocument(document({ data: data({ proxyTestSelection: { mode: 'all', groups: [], backendUrl: otherUrl } }) }), url), (error: any) => error.code === 'invalid')
})

test('pull remaps the current controller address, merges names and sorting, and preserves credentials', () => {
  const s = session({
    'miboard.backend': { url, secret: 'KEEP-ME' }, 'miboard.secrets': { [url]: 'KEEP-ME' },
    [aliasesKey()]: { '192.168.1.10': 'Old', '192.168.1.11': 'Keep' },
    [aliasesKey(otherUrl)]: { '10.0.0.2': 'Other' }, [sortKey('Keep')]: { key: 'protocol', direction: 'asc' },
    'miboard.groups': { Main: true, Keep: true }, 'miboard.theme': 'light',
  })
  const remote = s.sync.parseSyncDocument(document({ data: data({ deviceNames: { '192.168.1.10': 'New' }, proxySort: [{ group: 'Main', key: 'latency', direction: 'desc' }], preferences: { theme: 'dark', groups: { Main: false } } }) }), url)
  const before = s.snapshot()
  const preview = s.sync.previewSync('pull', remote, url)
  assert.equal(preview.changes.length, 4)
  assert.equal(preview.changes.some((change: any) => change.kind === 'remove'), false)
  assert.deepEqual(s.snapshot(), before, 'preview is read-only')
  s.sync.applySyncPull(preview, url)
  assert.deepEqual(JSON.parse(s.store.get(aliasesKey())!), { '192.168.1.10': 'New', '192.168.1.11': 'Keep' })
  assert.equal(JSON.parse(s.store.get('miboard.backend')!).secret, 'KEEP-ME')
  assert.deepEqual(JSON.parse(s.store.get('miboard.secrets')!), { [url]: 'KEEP-ME' })
  assert.equal(s.store.get('miboard.theme'), 'dark')
  assert.deepEqual(JSON.parse(s.store.get('miboard.groups')!), { Main: false, Keep: true })
  assert.ok(s.store.has(sortKey('Keep')))
  assert.deepEqual(JSON.parse(s.store.get(aliasesKey(otherUrl))!), { '10.0.0.2': 'Other' })
})

test('push preview includes remote removals, while pull retains absent local values', () => {
  const s = session({ [aliasesKey()]: { '192.168.1.1': 'Local' } })
  const remote = s.sync.parseSyncDocument(document({ data: data({ deviceNames: { '192.168.1.2': 'Remote' } }) }), url)
  const push = s.sync.previewSync('push', remote, url)
  assert.ok(push.changes.some((change: any) => change.key === '192.168.1.2' && change.kind === 'remove'))
  const pull = s.sync.previewSync('pull', remote, url)
  assert.equal(pull.changes.length, 1)
  assert.equal(pull.changes[0].kind, 'add')
})

test('stale remote revisions, changed content and changed local values all require a fresh preview', () => {
  const s = session({ 'miboard.theme': 'light' })
  const remote = s.sync.parseSyncDocument(document({ data: data({ preferences: { theme: 'dark' } }) }), url)
  const preview = s.sync.previewSync('pull', remote, url)
  assert.equal(s.sync.syncPreviewChanged(preview, remote, url), false)
  assert.equal(s.sync.syncPreviewChanged(preview, { ...remote, revision: 'test-revision-0002' }, url), true)
  assert.equal(s.sync.syncPreviewChanged(preview, { ...remote, data: data() }, url), true)
  s.store.set('miboard.theme', 'dark')
  assert.equal(s.sync.syncPreviewChanged(preview, remote, url), true)
  assert.throws(() => s.sync.applySyncPull(preview, url), (error: any) => error.code === 'changed')
})

test('pull uses the existing transaction rollback when local storage fails', () => {
  const s = session({ 'miboard.theme': 'light', [aliasesKey()]: { '192.168.1.10': 'Old' } })
  const remote = s.sync.parseSyncDocument(document({ data: data({ deviceNames: { '192.168.1.10': 'New' }, preferences: { theme: 'dark' } }) }), url)
  const preview = s.sync.previewSync('pull', remote, url)
  const before = s.snapshot()
  s.failNext('miboard.theme')
  assert.throws(() => s.sync.applySyncPull(preview, url), (error: any) => error.code === 'storage')
  assert.deepEqual(s.snapshot(), before)
})

test('missing copy and malformed sort/settings never become an import', () => {
  const s = session()
  assert.throws(() => s.sync.previewSync('pull', null, url), (error: any) => error.code === 'missing')
  const remote = document({ data: data({ proxySort: [{ group: 'Main', key: 'bad', direction: 'asc' }] }) })
  assert.throws(() => s.sync.parseSyncDocument(remote, url), (error: any) => error.code === 'invalid')
  assert.equal(s.store.size, 0)
})
