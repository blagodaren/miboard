import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const code = new Map<string, string>()
for (const file of ['api', 'devices', 'latency', 'appearance', 'live-updates', 'proxy-test-selection', 'settings-transfer']) {
  code.set('./' + file, ts.transpileModule(readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)
}
function session(seed: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(seed).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  let writes = 0
  let network = 0
  let sockets = 0
  let failKey: string | null = null
  const storage = {
    get length() { return store.size },
    key(index: number) { return [...store.keys()][index] ?? null },
    getItem(key: string) { return store.get(key) ?? null },
    setItem(key: string, value: string) {
      writes++
      if (key === failKey) { failKey = null; throw new DOMException('Quota exceeded', 'QuotaExceededError') }
      store.set(key, String(value))
    },
    removeItem(key: string) { writes++; store.delete(key) },
  }
  const modules = new Map<string, any>()
  const context = vm.createContext({
    URL, URLSearchParams, TextEncoder, btoa, AbortController, console, localStorage: storage,
    fetch() { network++; throw new Error('Unexpected network request') },
    WebSocket: class { constructor() { sockets++; throw new Error('Unexpected socket') } },
  })
  function load(id: string): any {
    id = id.replace(/\.ts$/, '')
    if (id === './i18n.svelte') return { t: (key: string) => key }
    if (modules.has(id)) return modules.get(id)
    assert.ok(code.has(id), `Unexpected module ${id}`)
    const exports = {}
    modules.set(id, exports)
    vm.runInContext(`(function(exports, require) {\n${code.get(id)}\n})`, context, { filename: id })(exports, load)
    return exports
  }
  const api = load('./api')
  const transfer = load('./settings-transfer')
  return {
    api, transfer, store, storage,
    snapshot: () => [...store.entries()].sort(([a], [b]) => a.localeCompare(b)),
    failNext(key: string) { failKey = key },
    activity: () => ({ writes, network, sockets }),
  }
}
const base = (extra: Record<string, unknown> = {}) => ({ format: 'miboard-settings', version: 1, servers: [], deviceAliases: [], proxySort: [], preferences: {}, ...extra })
const profile = { url: 'http://router.test:9090', secret: 'keep-this-secret', name: 'Router' }
const aliasesKey = 'miboard.device-names.' + encodeURIComponent(profile.url)
const sortKey = (group: string) => 'miboard.proxy-sort.v1' + JSON.stringify([profile.url, group])
const plain = (value: unknown) => JSON.parse(JSON.stringify(value))

test('export uses a semantic allowlist, omits secrets by default, and does not migrate or write storage', () => {
  const s = session({
    'miboard.backend': profile,
    'miboard.secrets': { [profile.url]: profile.secret },
    [aliasesKey]: { '192.168.1.10': 'Work laptop' },
    [sortKey('Main')]: { key: 'name', direction: 'desc' },
    'miboard.groups': { Main: false },
    'miboard.theme': 'dark', 'miboard.locale': 'ru', 'miboard.proxy-card-size': 'compact',
    'miboard.diagnostics': { secret: 'unrelated-private-data' }, 'unrelated': 'never-export-me',
  })
  const before = s.snapshot()
  const output = s.transfer.exportSettings()
  const document = JSON.parse(output)
  assert.equal(document.version, 1)
  assert.deepEqual(document.servers, [{ url: profile.url, name: 'Router' }])
  assert.equal(document.deviceAliases[0].names['192.168.1.10'], 'Work laptop')
  assert.equal(document.proxySort[0].direction, 'desc')
  assert.equal(document.preferences.theme, 'dark')
  assert.equal(document.preferences.proxyCardSize, 'compact')
  assert.ok(!output.includes(profile.secret) && !output.includes('unrelated-private-data') && !output.includes('never-export-me'))
  assert.deepEqual(s.snapshot(), before)
  assert.deepEqual(s.activity(), { writes: 0, network: 0, sockets: 0 })
  assert.equal(JSON.parse(s.transfer.exportSettings({ includeSecrets: true })).servers[0].secret, profile.secret)
})

test('explicit secret export round-trips offline without making an imported server last-successful', () => {
  const source = session({ 'miboard.backend': profile })
  const target = session()
  const preview = target.transfer.previewSettingsImport(source.transfer.exportSettings({ includeSecrets: true }))
  assert.equal(preview.counts.secrets, 1)
  assert.equal(target.activity().writes, 0)
  target.transfer.applySettingsImport(preview)
  assert.equal(target.api.savedBackends()[0].secret, profile.secret)
  assert.equal(target.store.has('miboard.backend'), false)
  assert.deepEqual(plain(target.api.backend()), { url: '', secret: '' })
  assert.equal(target.activity().network, 0)
  assert.equal(target.activity().sockets, 0)
})

test('export preserves legacy latency preferences through the same readonly migration as the live panel', () => {
  const legacy = { mode: 'core', url: 'https://legacy.example/check', timeout: 15000, yellow: 350, red: 700 }
  const s = session({ 'miboard.latency.v1': legacy })
  const before = s.snapshot()
  const exported = JSON.parse(s.transfer.exportSettings())
  assert.deepEqual(exported.preferences.latency, { ...legacy, ipv6: false, independent: false })
  assert.equal(s.transfer.previewSettingsImport(JSON.stringify(exported)).invalid, 0)
  assert.deepEqual(s.snapshot(), before, 'Export reads migrated preferences without persisting migration')
  assert.deepEqual(s.activity(), { writes: 0, network: 0, sockets: 0 })
})

test('card-size preference round-trips and older settings files leave the current layout unchanged', () => {
  const source = session({ 'miboard.proxy-card-size': 'compact' })
  const target = session({ 'miboard.proxy-card-size': 'large' })
  const preview = target.transfer.previewSettingsImport(source.transfer.exportSettings())
  assert.equal(preview.invalid, 0)
  assert.equal(target.store.get('miboard.proxy-card-size'), 'large', 'Preview does not apply layout changes')
  target.transfer.applySettingsImport(preview)
  assert.equal(target.store.get('miboard.proxy-card-size'), 'compact')
  assert.equal(target.store.has('miboard.proxyCardSize'), false, 'The transfer uses the same storage key as the live preference')
  target.transfer.applySettingsImport(target.transfer.previewSettingsImport(JSON.stringify(base({ preferences: { theme: 'dark' } }))))
  assert.equal(target.store.get('miboard.proxy-card-size'), 'compact', 'An omitted preference never resets an existing layout')
  assert.equal(target.activity().network + target.activity().sockets, 0)
})

test('layout, live capture and per-server bulk selections round-trip without changing absent preferences', () => {
  const key = 'miboard.proxy-test-selection.v1.' + encodeURIComponent(profile.url)
  const source = session({
    'miboard.proxy-group-height': 'full', 'miboard.live-update-mode': 'eco',
    [key]: { mode: 'selected', groups: ['Main', 'Hidden'] },
  })
  const target = session({ 'miboard.proxy-group-height': 'large', 'miboard.live-update-mode': 'realtime' })
  const output = source.transfer.exportSettings()
  assert.deepEqual(JSON.parse(output).proxyTestSelections, [{ backendUrl: profile.url, mode: 'selected', groups: ['Main', 'Hidden'] }])
  const preview = target.transfer.previewSettingsImport(output)
  assert.equal(preview.invalid, 0)
  assert.equal(target.store.get('miboard.live-update-mode'), 'realtime')
  target.transfer.applySettingsImport(preview)
  assert.equal(target.store.get('miboard.proxy-group-height'), 'full')
  assert.equal(target.store.get('miboard.live-update-mode'), 'eco')
  assert.deepEqual(JSON.parse(target.store.get(key)!), { mode: 'selected', groups: ['Main', 'Hidden'] })
  target.transfer.applySettingsImport(target.transfer.previewSettingsImport(JSON.stringify(base())))
  assert.equal(target.store.get('miboard.proxy-group-height'), 'full')
  assert.equal(target.store.get('miboard.live-update-mode'), 'eco')
  assert.equal(JSON.parse(target.store.get(key)!).mode, 'selected')
  assert.equal(target.activity().network + target.activity().sockets, 0)
})

test('new preferences validate atomically and roll back per-server selections on storage failure', () => {
  const key = 'miboard.proxy-test-selection.v1.' + encodeURIComponent(profile.url)
  const s = session({ [key]: { mode: 'all', groups: [] }, 'miboard.proxy-group-height': 'large', 'miboard.live-update-mode': 'realtime' })
  for (const extra of [
    { preferences: { proxyGroupHeight: 'tiny' } }, { preferences: { liveUpdateMode: 'off' } },
    { proxyTestSelections: [{ backendUrl: profile.url, mode: 'selected', groups: [42] }] },
    { proxyTestSelections: [{ backendUrl: profile.url, mode: 'all', groups: [], secret: 'unexpected' }] },
  ]) assert.ok(s.transfer.previewSettingsImport(JSON.stringify(base(extra))).invalid > 0)
  const before = s.snapshot()
  const preview = s.transfer.previewSettingsImport(JSON.stringify(base({
    proxyTestSelections: [{ backendUrl: profile.url, mode: 'selected', groups: ['Main'] }],
    preferences: { proxyGroupHeight: 'compact', liveUpdateMode: 'eco' },
  })))
  s.failNext('miboard.live-update-mode')
  assert.throws(() => s.transfer.applySettingsImport(preview), (error: any) => error.code === 'storage')
  assert.deepEqual(s.snapshot(), before)
})

test('merge preserves legacy credentials, untouched entries and the live backend while importing explicit names', () => {
  const s = session({
    'miboard.backend': profile, 'miboard.secrets': { [profile.url]: profile.secret, 'https://spare.test': 'spare-secret' },
    [aliasesKey]: { '192.168.1.10': 'Old laptop', '192.168.1.20': 'Phone' },
    [sortKey('Main')]: { key: 'config', direction: 'asc' }, [sortKey('Keep')]: { key: 'latency', direction: 'asc' },
    'miboard.groups': { Main: true, Keep: false }, 'unrelated': 'untouched',
  })
  s.api.useBackend(profile)
  const before = s.snapshot()
  const preview = s.transfer.previewSettingsImport(JSON.stringify(base({
    servers: [{ url: 'HTTP://ROUTER.TEST:9090/', name: 'Imported name' }, { url: 'https://offline.invalid', secret: 'offline-secret' }],
    deviceAliases: [{ backendUrl: profile.url, names: { '192.168.1.10': 'New laptop' } }],
    proxySort: [{ backendUrl: profile.url, group: 'Main', key: 'name', direction: 'desc' }],
    preferences: { groups: { Main: false }, theme: 'light' },
  })))
  assert.equal(preview.existingServers, 1)
  assert.equal(preview.conflicts, 5)
  assert.equal(preview.invalid, 0)
  assert.deepEqual(s.snapshot(), before, 'Preview must not run profile migration')
  s.transfer.applySettingsImport(preview)
  const profiles = plain(s.api.savedBackends())
  assert.equal(profiles.length, 3)
  assert.equal(profiles.find((item: any) => item.url === profile.url).secret, profile.secret)
  assert.equal(profiles.find((item: any) => item.url === profile.url).name, 'Imported name')
  assert.equal(profiles.find((item: any) => item.url === 'https://spare.test').secret, 'spare-secret')
  assert.deepEqual(JSON.parse(s.store.get(aliasesKey)!), { '192.168.1.10': 'New laptop', '192.168.1.20': 'Phone' })
  assert.deepEqual(JSON.parse(s.store.get('miboard.groups')!), { Main: false, Keep: false })
  assert.deepEqual(JSON.parse(s.store.get(sortKey('Keep'))!), { key: 'latency', direction: 'asc' })
  assert.equal(JSON.parse(s.store.get('miboard.backend')!).url, profile.url)
  assert.equal(s.store.get('unrelated'), 'untouched')
  assert.deepEqual(plain(s.api.backend()), profile, 'Persisted changes must not touch the live connection')
  assert.equal(s.activity().network + s.activity().sockets, 0)
})

test('empty or missing imported secret never erases credentials; an explicit nonempty secret can replace it', () => {
  const s = session({ 'miboard.backend': profile })
  for (const secret of [undefined, '']) {
    const server = { url: profile.url, ...(secret !== undefined ? { secret } : {}) }
    s.transfer.applySettingsImport(s.transfer.previewSettingsImport(JSON.stringify(base({ servers: [server] }))))
    assert.equal(s.api.savedBackends()[0].secret, profile.secret)
  }
  const preview = s.transfer.previewSettingsImport(JSON.stringify(base({ servers: [{ url: profile.url, secret: 'replacement' }] })))
  assert.equal(preview.counts.secrets, 1)
  assert.equal(preview.conflicts, 1)
  s.transfer.applySettingsImport(preview)
  assert.equal(s.api.savedBackends()[0].secret, 'replacement')
})

test('one malformed entry invalidates the entire file and cannot partially apply valid entries', () => {
  const s = session({ 'miboard.backend': profile })
  const before = s.snapshot()
  for (const extra of [
    { servers: [{ url: 'https://valid.test' }, { url: 'https://bad.test', secret: 42 }] },
    { servers: [{ url: 'https://user:password@bad.test' }] },
    { servers: [{ url: 'https://DUP.test:443/' }, { url: 'https://dup.test' }] },
    { deviceAliases: [{ backendUrl: profile.url, names: { 'not-an-ip': 'Laptop' } }] },
    { proxySort: [{ backendUrl: profile.url, group: 'Main', key: 'random', direction: 'asc' }] },
    { proxySort: [{ backendUrl: profile.url, group: 'Main', key: ['name'], direction: 'asc' }] },
    { proxySort: [{ backendUrl: profile.url, group: 'Main', key: 'name', direction: ['asc'] }] },
    { proxySort: [{ backendUrl: profile.url, group: 'Main', key: { toString: 'name' }, direction: 'asc' }] },
    { preferences: { locale: 'unknown' } },
    { preferences: { proxyCardSize: 'small' } },
    { preferences: { proxyCardSize: ['compact'] } },
    { preferences: { latency: { mode: 'core', url: 'https://valid.test', timeout: 5000, yellow: 800, red: 400, ipv6: false, independent: false } } },
  ]) {
    const preview = s.transfer.previewSettingsImport(JSON.stringify(base(extra)))
    assert.ok(preview.invalid > 0)
    assert.equal(preview.document, null)
    assert.throws(() => s.transfer.applySettingsImport(preview), { code: 'invalid' })
    assert.deepEqual(s.snapshot(), before)
  }
})

test('prototype keys, arbitrary localStorage, unknown metadata, malformed JSON and oversized UTF-8 files are rejected', () => {
  const s = session({ 'unrelated': 'keep' })
  const before = s.snapshot()
  for (const source of [
    JSON.stringify(base({ localStorage: { 'miboard.backend': 'attacker' } })),
    JSON.stringify(base({ preferences: { theme: 'dark', arbitrary: true } })),
    JSON.stringify(base({ metadata: { value: true } })),
    JSON.stringify(base()).replace('"preferences":{}', '"preferences":{"__proto__":{"polluted":true}}'),
    JSON.stringify(base()).replace('"preferences":{}', '"preferences":{"groups":{"constructor":true}}'),
    JSON.stringify(base({ version: 2 })),
  ]) assert.ok(s.transfer.previewSettingsImport(source).invalid > 0)
  assert.throws(() => s.transfer.previewSettingsImport('{'), { code: 'invalid' })
  assert.throws(() => s.transfer.previewSettingsImport('я'.repeat(1024 * 1024 + 1)), { code: 'size' })
  assert.deepEqual(s.snapshot(), before)
  assert.equal(({} as any).polluted, undefined)
})

test('import validates URL schemes and canonical device addresses without rewriting unsupported protocols', () => {
  const s = session({ 'miboard.backend': profile })
  const before = s.snapshot()
  const badUrls = ['ftp://router.test', 'FTP://router.test', 'wss://router.test', 'file://router.test/config',
    'custom+core://router.test', 'https://user:pass@router.test', 'https://router.test/?secret=key',
    'https://router.test/#fragment', 'http://router.test:99999', '', 'https://router.test/with space']
  for (const url of badUrls) {
    for (const extra of [{ servers: [{ url }] }, { deviceAliases: [{ backendUrl: url, names: { '192.168.1.10': 'Laptop' } }] },
      { proxySort: [{ backendUrl: url, group: 'Main', key: 'name', direction: 'asc' }] }]) {
      const preview = s.transfer.previewSettingsImport(JSON.stringify(base(extra)))
      assert.ok(preview.invalid > 0, `Reject ${JSON.stringify(extra)}`)
      assert.throws(() => s.transfer.applySettingsImport(preview), { code: 'invalid' })
    }
  }
  for (const ip of ['', 'laptop', '0.0.0.0', '::', '192.168.1.999', '192.168.001.010', '2001:DB8::1']) {
    const preview = s.transfer.previewSettingsImport(JSON.stringify(base({ deviceAliases: [{ backendUrl: profile.url, names: { [ip]: 'Laptop' } }] })))
    assert.ok(preview.invalid > 0, `Reject device address ${JSON.stringify(ip)}`)
  }
  for (const [url, expected] of [['router.test:9090', 'http://router.test:9090'], ['HTTPS://ROUTER.TEST:443/', 'https://router.test'], ['http://[::1]:9090/', 'http://[::1]:9090']]) {
    const preview = s.transfer.previewSettingsImport(JSON.stringify(base({ servers: [{ url }] })))
    assert.equal(preview.invalid, 0)
    assert.equal(preview.document.servers[0].url, expected)
  }
  for (const ip of ['192.168.1.10', '2001:db8::1', 'fe80::1%eth0']) {
    const preview = s.transfer.previewSettingsImport(JSON.stringify(base({ deviceAliases: [{ backendUrl: profile.url, names: { [ip]: 'Laptop' } }] })))
    assert.equal(preview.invalid, 0, `Preserve canonical device address ${ip}`)
  }
  assert.deepEqual(s.snapshot(), before, 'Validation and rejected imports make no storage changes')
  assert.deepEqual(s.activity(), { writes: 0, network: 0, sockets: 0 })
})

test('quota failure after profile migration and preference writes restores every affected key exactly', () => {
  const s = session({
    'miboard.backend': profile, 'miboard.secrets': { [profile.url]: profile.secret },
    [aliasesKey]: { '192.168.1.10': 'Keep laptop' }, 'miboard.locale': 'en', 'miboard.theme': 'dark', 'miboard.proxy-card-size': 'large', 'unrelated': 'untouched',
  })
  s.api.useBackend(profile)
  const before = s.snapshot()
  const preview = s.transfer.previewSettingsImport(JSON.stringify(base({
    servers: [{ url: profile.url, name: 'Change me' }, { url: 'https://new.test', secret: 'new-secret' }],
    deviceAliases: [{ backendUrl: profile.url, names: { '192.168.1.20': 'New phone' } }],
    proxySort: [{ backendUrl: profile.url, group: 'Main', key: 'name', direction: 'asc' }],
    preferences: { groups: { Main: false }, locale: 'ru', theme: 'light', proxyCardSize: 'compact' },
  })))
  s.failNext('miboard.locale')
  assert.throws(() => s.transfer.applySettingsImport(preview), { code: 'storage' })
  assert.deepEqual(s.snapshot(), before)
  assert.deepEqual(plain(s.api.backend()), profile)
  assert.equal(s.activity().network + s.activity().sockets, 0)
})

test('failure inside a nested profile transaction restores the pre-migration state and reports failure', () => {
  const s = session({ 'miboard.backend': profile, 'miboard.locale': 'en' })
  const before = s.snapshot()
  const preview = s.transfer.previewSettingsImport(JSON.stringify(base({ servers: [{ url: 'https://new.test', secret: 'new' }] })))
  s.failNext('miboard.secrets')
  assert.throws(() => s.transfer.applySettingsImport(preview), { code: 'storage' })
  assert.deepEqual(s.snapshot(), before)
})
