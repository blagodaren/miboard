import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coreDetailSections } from '../src/lib/core-status.ts'

const fields = (input: unknown) => Object.fromEntries(coreDetailSections(input).flatMap(section => section.fields.map(field => [field.key, field.value])))

test('unsupported configs remain absent instead of looking disabled or empty', () => {
  for (const input of [undefined, null, [], 'offline', false, 0, {}, { tun: null }, { tun: [] }]) {
    assert.deepEqual(coreDetailSections(input), [])
  }
  assert.deepEqual(fields({ 'log-level': null, 'keep-alive-idle': undefined, 'allow-lan': 'false', tun: { 'udp-timeout': NaN } }), {})
})

test('reported false, zero and empty lists are distinct from missing API data', () => {
  const result = fields({
    'log-level': 'silent', 'disable-keep-alive': false, 'keep-alive-idle': 0,
    'allow-lan': false, 'lan-disallowed-ips': [],
    tun: { 'auto-redirect': false, 'auto-redirect-input-mark': 0, 'exclude-interface': [], 'include-uid': [0] },
  })
  assert.equal(result['disable-keep-alive'], false)
  assert.equal(result['keep-alive-idle'], 0)
  assert.equal(result['allow-lan'], false)
  assert.deepEqual(result['lan-disallowed-ips'], [])
  assert.equal(result['auto-redirect'], false)
  assert.equal(result['auto-redirect-input-mark'], 0)
  assert.deepEqual(result['exclude-interface'], [])
  assert.deepEqual(result['include-uid'], [0])
  assert.ok(!('keep-alive-interval' in result))
})

test('only allowlisted public config is exposed and authentication never renders passwords or objects', () => {
  const result = coreDetailSections({
    authentication: ['alice', 'bob:PRIVATE-PASSWORD:with-colon', 'alice', { username: 'carol', password: 'PRIVATE-OBJECT' }, '', ':PRIVATE-EMPTY-USER'],
    'lan-allowed-ips': ['192.168.1.0/24'], secret: 'PRIVATE-SECRET',
    'ss-config': 'PRIVATE-SS', 'vmess-config': 'PRIVATE-VMESS', 'tuic-server': { token: 'PRIVATE-TUIC' },
    tun: { password: 'PRIVATE-TUN', 'include-package': ['org.example.app'] },
  })
  assert.deepEqual(fields({ authentication: ['alice', 'bob:secret', 'alice'] }).authentication, ['alice', 'bob'])
  assert.ok(!JSON.stringify(result).includes('PRIVATE'))
  assert.ok(!JSON.stringify(result).includes('carol'))
  assert.ok(JSON.stringify(result).includes('192.168.1.0/24'))
})

test('malformed arrays do not create object strings or misleading empty lists', () => {
  assert.deepEqual(fields({ 'lan-allowed-ips': [{ nested: 'secret' }], tun: { 'include-uid': ['root'], 'route-address': 123 } }), {})
  assert.deepEqual(fields({ tun: { 'include-uid': [0, 1000, NaN, Infinity, '1001', {}], 'route-address': ['::/0', null] } }), {
    'route-address': ['::/0'], 'include-uid': [0, 1000],
  })
})

test('long routing and application lists are retained without mutating source data', () => {
  const networks = Array.from({ length: 20 }, (_, i) => `10.${i}.0.0/16`)
  const config = { tun: { 'route-address': networks, 'route-exclude-address': ['192.168.0.0/16'], 'inet6-route-address': ['::/0'], 'exclude-package': ['org.example.long.application.name'], 'exclude-dst-port-range': ['8000:9000'] } }
  const original = structuredClone(config)
  const result = coreDetailSections(config)
  assert.equal(result.find(section => section.id === 'tun-routes')?.fields.find(field => field.key === 'route-address')?.value.length, 20)
  assert.deepEqual(fields(config)['inet6-route-address'], ['::/0'])
  assert.deepEqual(config, original)
  assert.notStrictEqual(fields(config)['route-address'], networks)
})
