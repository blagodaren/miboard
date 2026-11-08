import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDeviceIP, summarizeDevices, UNKNOWN_DEVICE, type DeviceConnection } from '../src/lib/devices.ts'

function connection(id: string, sourceIP = '192.168.1.2', download = 100, upload = 20): DeviceConnection {
  return {
    id,
    metadata: {
      network: 'tcp', type: 'Tun', sourceIP, sourcePort: '41000',
      destinationIP: '8.8.8.8', destinationPort: '443', host: 'example.com',
    },
    download, upload, dl: 10, ul: 2, start: '2026-11-09T10:00:00Z',
    chains: ['exit-node', 'Auto', 'Proxy'], rule: 'DomainSuffix', rulePayload: 'example.com',
  }
}

test('empty snapshot has zero devices and traffic', () => {
  assert.deepEqual(summarizeDevices([]), {
    devices: [], totals: { devices: 0, connections: 0, download: 0, upload: 0, total: 0, dl: 0, ul: 0, tcp: 0, udp: 0 },
  })
})

test('groups one active frame by source IP, preserving observed metadata and counters', () => {
  const first = connection('a')
  first.metadata.process = 'browser.exe'
  first.metadata.inboundName = 'lan-tun'
  const second = connection('b', '192.168.1.2', 200, 30)
  second.metadata.network = 'UDP'
  second.metadata.host = ''
  second.metadata.sniffHost = 'CDN.Example.COM.'
  second.metadata.destinationIP = '1.1.1.1'
  second.metadata.processPath = '/usr/bin/dns-client'
  second.start = '2026-11-09T09:00:00Z'
  const other = connection('c', '192.168.1.3', 400, 80)
  const source = [first, second, other]
  const before = structuredClone(source)
  const result = summarizeDevices(source)
  assert.deepEqual(result.devices.map(device => device.sourceIP), ['192.168.1.3', '192.168.1.2'])
  const device = result.devices[1]
  assert.equal(device.connections, 2)
  assert.equal(device.download, 300)
  assert.equal(device.upload, 50)
  assert.equal(device.total, 350)
  assert.equal(device.dl, 20)
  assert.equal(device.ul, 4)
  assert.equal(device.tcp, 1)
  assert.equal(device.udp, 1)
  assert.deepEqual(device.domains, ['cdn.example.com', 'example.com'])
  assert.deepEqual(device.destinationIPs, ['1.1.1.1', '8.8.8.8'])
  assert.deepEqual(device.proxies, ['exit-node'])
  assert.deepEqual(device.rules, ['DomainSuffix: example.com'])
  assert.deepEqual(device.processes, ['/usr/bin/dns-client', 'browser.exe'])
  assert.deepEqual(device.inbounds, ['Tun', 'lan-tun'])
  assert.equal(device.firstSeen, Date.parse(second.start))
  assert.deepEqual(result.totals, { devices: 2, connections: 3, download: 700, upload: 130, total: 830, dl: 30, ul: 6, tcp: 2, udp: 1 })
  assert.deepEqual(source, before, 'The helper must not mutate core.conns')
})

test('duplicate IDs and repeated snapshots never double count; closed connections disappear', () => {
  const first = connection('same')
  const duplicate = connection('same', '192.168.1.3', 9000, 9000)
  const invalid = connection('')
  const result = summarizeDevices([first, duplicate, invalid])
  assert.equal(result.devices.length, 1)
  assert.equal(result.totals.connections, 1)
  assert.equal(result.totals.total, 120)
  assert.deepEqual(summarizeDevices([first]), result)
  assert.equal(summarizeDevices([]).devices.length, 0)
})

test('canonicalizes IPv4 and IPv6 while keeping scoped interface identities distinct', () => {
  assert.equal(normalizeDeviceIP(' 192.168.001.002 '), '192.168.1.2')
  assert.equal(normalizeDeviceIP('[2001:0DB8:0:0::1]'), '2001:db8::1')
  assert.equal(normalizeDeviceIP('fe80:0:0:0::1%eth0'), 'fe80::1%eth0')
  assert.equal(normalizeDeviceIP('::ffff:192.168.1.2'), '::ffff:c0a8:102')
  const result = summarizeDevices([
    connection('v6a', '2001:db8:0:0::1'), connection('v6b', '[2001:DB8::1]'),
    connection('zone-a', 'fe80::1%eth0'), connection('zone-b', 'fe80::1%eth1'),
  ])
  assert.equal(result.devices.length, 3)
  assert.equal(result.devices[0].sourceIP, '2001:db8::1')
  assert.equal(result.devices[0].connections, 2)
})

test('missing, malformed, hostnames, ports and unspecified sources stay in one unknown bucket', () => {
  const addresses = ['', 'unknown', 'router.lan', '256.1.2.3', '192.168.1.2:9090', '[::1]:9090', '::', '0.0.0.0', 'fe80::1%bad/zone']
  addresses.forEach(value => assert.equal(normalizeDeviceIP(value), '', value))
  const result = summarizeDevices(addresses.map((value, index) => connection(String(index), value)))
  assert.equal(result.devices.length, 1)
  assert.equal(result.devices[0].id, UNKNOWN_DEVICE)
  assert.equal(result.devices[0].sourceIP, '')
  assert.equal(result.devices[0].connections, addresses.length)
  assert.equal(normalizeDeviceIP(undefined), '')
  assert.equal(normalizeDeviceIP(null), '')
})

test('invalid counters and dates cannot poison totals or identify absent metadata', () => {
  const invalid = connection('invalid', '192.168.1.2', Number.NaN, -20)
  invalid.dl = Number.POSITIVE_INFINITY
  invalid.ul = -200
  invalid.start = 'not a date'
  invalid.metadata.network = 'other'
  invalid.metadata.host = '8.8.8.8'
  invalid.metadata.destinationIP = '0.0.0.0'
  invalid.metadata.type = ''
  invalid.chains = []
  invalid.rule = ''
  invalid.rulePayload = ''
  const result = summarizeDevices([invalid])
  assert.deepEqual(result.totals, { devices: 1, connections: 1, download: 0, upload: 0, total: 0, dl: 0, ul: 0, tcp: 0, udp: 0 })
  assert.equal(result.devices[0].firstSeen, null)
  assert.deepEqual(result.devices[0].domains, [])
  assert.deepEqual(result.devices[0].destinationIPs, [])
  assert.deepEqual(result.devices[0].proxies, [], 'A missing chain must not become DIRECT')
  assert.deepEqual(result.devices[0].inbounds, [])
})

test('ties are deterministic by connections then source identity; domain names are normalized', () => {
  const connections = [connection('c', '192.168.1.4', 20, 0), connection('a', '192.168.1.3', 10, 0), connection('b', '192.168.1.3', 10, 0), connection('d', '192.168.1.2', 20, 0)]
  connections[0].metadata.host = 'ПРИМЕР.РФ.'
  connections[1].metadata.host = '[::1]'
  connections[1].metadata.sniffHost = 'valid.example.org'
  assert.deepEqual(summarizeDevices(connections).devices.map(device => device.sourceIP), ['192.168.1.3', '192.168.1.2', '192.168.1.4'])
  assert.deepEqual(summarizeDevices([...connections].reverse()).devices.map(device => device.sourceIP), ['192.168.1.3', '192.168.1.2', '192.168.1.4'])
  assert.deepEqual(summarizeDevices(connections).devices[2].domains, ['xn--e1afmkfd.xn--p1ai'])
  assert.deepEqual(summarizeDevices(connections).devices[0].domains, ['example.com', 'valid.example.org'])
})
