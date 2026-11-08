import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { GeoResolver } from '../src/lib/geo-resolver.ts'

const connection = (metadata = {}, id = 'connection') => ({
  id,
  metadata: {
    network: 'tcp', type: 'Tun', sourceIP: '192.168.1.25', sourcePort: '49152',
    destinationIP: '', destinationPort: '443', host: '', destinationGeoIP: null,
    ...metadata,
  },
  upload: 10, download: 100, start: '2026-11-08T00:00:00Z',
  chains: ['proxy'], rule: 'Match', rulePayload: '',
})
const lookup = (ip) => ({
  '8.8.8.8': 'US',
  '1.1.1.1': 'AU',
  '2606:4700:4700::1111': 'US',
  '2606:4700:4700:0:0:0:0:1111': 'US',
})[ip] ?? null
const answer = (ip = '8.8.8.8', type = 1, TTL = 120) => ({
  Status: 0, Answer: [{ name: 'example.com.', type, TTL, data: ip }],
})
async function settled(resolver) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!resolver.pending) return
    await delay(1)
  }
  assert.equal(resolver.pending, 0, 'DNS queue did not settle')
}

test('публичный destinationIP определяется локально; remoteDestination не используется', () => {
  let calls = 0
  const resolver = new GeoResolver(lookup, async () => { calls++; return answer() }, () => {})
  const directIP = connection({ destinationIP: '8.8.8.8' })
  const proxyOnly = connection({ remoteDestination: '8.8.8.8' })
  resolver.update([directIP, proxyOnly])
  assert.deepEqual(resolver.locate(directIP), { country: 'US', source: 'ip', ip: '8.8.8.8' })
  assert.equal(resolver.locate(proxyOnly), null)
  assert.equal(calls, 0)
  assert.equal(resolver.pending, 0)
  assert.deepEqual(resolver.locate(connection({ host: '1.1.1.1' })), { country: 'AU', source: 'ip', ip: '1.1.1.1' })
  resolver.dispose()
})

test('нативный GeoIP имеет приоритет и не создаёт фоновые DNS-запросы', () => {
  let calls = 0
  const resolver = new GeoResolver(lookup, async () => { calls++; return answer() }, () => {})
  const native = connection({ host: 'example.com', destinationGeoIP: ['de'] })
  resolver.update([native])
  assert.equal(resolver.pending, 0)
  assert.equal(resolver.locate(native), null)
  assert.equal(calls, 0)
  resolver.dispose()
})

test('DNS-домены нормализуются, дедуплицируются и используют TTL минимум 30 секунд', async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  const calls = []
  let changes = 0
  const resolver = new GeoResolver(lookup, async (name, type) => {
    calls.push([name, type])
    return answer('8.8.8.8', 1, 1)
  }, () => changes++)
  try {
    const first = connection({ host: 'EXAMPLE.COM.' }, 'first')
    const second = connection({ host: 'example.com' }, 'second')
    resolver.update([first, second])
    resolver.update([first, second])
    await settled(resolver)
    assert.deepEqual(calls, [['example.com', 'A']])
    assert.deepEqual(resolver.locate(first), { country: 'US', source: 'dns', ip: '8.8.8.8' })
    assert.equal(changes, 1)
    now += 29_999
    resolver.update([first])
    assert.equal(calls.length, 1)
    now++
    assert.equal(resolver.locate(first), null)
    resolver.update([first])
    await settled(resolver)
    assert.equal(calls.length, 2)
  } finally {
    Date.now = originalNow
    resolver.dispose()
  }
})

test('после пустого A используется AAAA; CNAME и частные DNS-ответы не геолоцируются', async () => {
  const calls = []
  const resolver = new GeoResolver(lookup, async (name, type) => {
    calls.push(type)
    return type === 'A'
      ? { Status: 0, Answer: [{ name, type: 5, TTL: 120, data: '8.8.8.8' }, { name, type: 1, TTL: 120, data: '192.168.1.1' }] }
      : answer('2606:4700:4700::1111', 28)
  }, () => {})
  const target = connection({ host: 'example.com' })
  resolver.update([target])
  await settled(resolver)
  assert.deepEqual(calls, ['A', 'AAAA'])
  assert.deepEqual(resolver.locate(target), { country: 'US', source: 'dns', ip: '2606:4700:4700:0:0:0:0:1111' })
  resolver.dispose()
})

test('стандартный fake-IP и unspecified разрешаются через DNS, настоящий LAN остаётся неизвестным', async () => {
  const calls = []
  const resolver = new GeoResolver(lookup, async (name) => { calls.push(name); return answer() }, () => {})
  const fake = connection({ host: 'fake.example.com', destinationIP: '198.18.0.2' })
  const unspecified = connection({ host: 'unspecified.example.com', destinationIP: '::' })
  const lan = connection({ host: 'public.example.com', destinationIP: '192.168.1.1' })
  const localDomain = connection({ host: 'router.local' })
  const privateLiteral = connection({ host: '127.1' })
  resolver.update([fake, unspecified, lan, localDomain, privateLiteral])
  await settled(resolver)
  assert.deepEqual(calls.sort(), ['fake.example.com', 'unspecified.example.com'])
  assert.equal(resolver.locate(fake)?.source, 'dns')
  assert.equal(resolver.locate(unspecified)?.source, 'dns')
  assert.equal(resolver.locate(lan), null)
  assert.equal(resolver.locate(localDomain), null)
  assert.equal(resolver.locate(privateLiteral), null)
  resolver.dispose()
})

test('DNS-ошибки кэшируются 60 секунд и не повторяются на каждом снимке', async () => {
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  let calls = 0
  const resolver = new GeoResolver(lookup, async () => { calls++; throw new Error('DNS section is disabled') }, () => {})
  const target = connection({ host: 'example.com' })
  try {
    resolver.update([target])
    await settled(resolver)
    assert.equal(resolver.dnsFailures, 1)
    assert.equal(resolver.locate(target), null)
    resolver.update([target])
    assert.equal(calls, 1)
    now += 60_000
    resolver.update([target])
    await settled(resolver)
    assert.equal(calls, 2)
    resolver.update([])
    assert.equal(resolver.dnsFailures, 0)
  } finally {
    Date.now = originalNow
    resolver.dispose()
  }
})

test('не более четырёх DNS-задач; закрытые соединения удаляются из очереди', async () => {
  const calls = []
  const completions = []
  const resolver = new GeoResolver(lookup, (name) => {
    calls.push(name)
    return new Promise((resolve) => completions.push(resolve))
  }, () => {})
  const targets = Array.from({ length: 10 }, (_, index) => connection({ host: `host-${index}.example.com` }, `c${index}`))
  resolver.update(targets)
  assert.equal(calls.length, 4)
  assert.equal(resolver.pending, 10)
  resolver.update([targets[0]])
  assert.equal(resolver.pending, 4)
  for (const resolve of completions) resolve(answer())
  await settled(resolver)
  assert.equal(calls.length, 4)
  resolver.dispose()
})

test('dispose игнорирует результат текущих запросов, callbacks и новые снимки', async () => {
  let complete
  let changes = 0
  let calls = 0
  const resolver = new GeoResolver(lookup, () => {
    calls++
    return new Promise((resolve) => { complete = resolve })
  }, () => changes++)
  const target = connection({ host: 'example.com' })
  resolver.update([target])
  assert.equal(resolver.pending, 1)
  resolver.dispose()
  complete(answer())
  await delay(1)
  resolver.update([target])
  assert.equal(resolver.pending, 0)
  assert.equal(resolver.locate(target), null)
  assert.equal(calls, 1)
  assert.equal(changes, 0)
})
