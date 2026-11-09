import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Rule, DnsResponse } from '../src/lib/api.ts'
import { currentRuleForToggle, orderedRules, ruleIndex, ruleStats, ruleTimestamp } from '../src/lib/rule-status.ts'
import { dnsQueryName, reverseDnsName, dnsRecords, dnsQuestions, dnsFlags, dnsRecordType } from '../src/lib/domain-diagnostics.ts'

const rule = (index: number, payload: string, hits = 0): Rule => ({ index, type: 'DomainSuffix', payload, proxy: 'Select',
  extra: { disabled: false, hitCount: hits, missCount: 10, hitAt: '0001-01-01T00:00:00Z', missAt: '2026-11-10T05:00:00Z' } })

test('sorting and filtering preserve zero-based server indices and original display numbers', () => {
  const source = [rule(0, 'first.test', 1), rule(41, 'second.test', 100), rule(99, 'third.test', 10)]
  assert.deepEqual(orderedRules(source, 'hits').map(row => [row.index, row.i]), [[41, 2], [99, 3], [0, 1]])
  assert.equal(orderedRules(source, 'hits', 'second')[0].index, 41)
  assert.equal(ruleIndex(source[0]), 0)
  assert.deepEqual(source.map(row => row.index), [0, 41, 99])
})

test('rule actions reject ambiguous indices, unsupported extras and changed configurations', () => {
  const original = rule(0, 'first.test')
  assert.equal(currentRuleForToggle(original, [original]), original)
  assert.equal(currentRuleForToggle(original, [rule(0, 'different.test')]), null)
  assert.equal(currentRuleForToggle(original, [original, original]), null)
  assert.equal(currentRuleForToggle(original, [{ ...original, extra: undefined }]), null)
  for (const index of [undefined, -1, 0.5, Infinity, NaN]) assert.equal(ruleIndex({ ...original, index }), null)
  assert.equal(currentRuleForToggle({ ...original, index: undefined }, [original]), null)
})

test('missing or malformed rule statistics never become zero or a fabricated timestamp', () => {
  assert.equal(ruleStats({ type: 'Match', payload: '', proxy: 'Direct' }), null)
  const stats = ruleStats(rule(3, 'example.test'))!
  assert.equal(stats.hits, 0)
  assert.equal(stats.hitAt, null)
  assert.equal(stats.missAt, Date.parse('2026-11-10T05:00:00Z'))
  assert.equal(ruleTimestamp('not a time'), null)
  assert.equal(ruleTimestamp(undefined), null)
  const malformed = rule(3, 'example.test')
  malformed.extra = { ...malformed.extra!, hitCount: -1, missCount: Infinity, disabled: undefined } as unknown as Rule['extra']
  assert.deepEqual(ruleStats(malformed), { disabled: null, hits: null, misses: null, hitAt: null, missAt: stats.missAt })
})

test('live core epoch placeholders are not displayed as rule evaluation dates', () => {
  const observed: Rule = { ...rule(0, 'example.test'), extra: {
    disabled: false, hitCount: 0, hitAt: '1970-01-01T00:00:00Z',
    missCount: 29756, missAt: '2026-11-09T21:26:09.16117336Z',
  } }
  assert.deepEqual(ruleStats(observed), {
    disabled: false, hits: 0, misses: 29756, hitAt: null,
    missAt: Date.parse('2026-11-09T21:26:09.16117336Z'),
  })
  for (const time of ['0001-01-01T00:00:00Z', '1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z', '1970-01-01T03:00:00+03:00']) {
    assert.equal(ruleTimestamp(time), null, time)
  }
  assert.equal(ruleTimestamp('2026-11-09T21:26:09.16117336Z'), Date.parse('2026-11-09T21:26:09.161Z'))
})

test('zero rule counters suppress inconsistent timestamps without inventing missing counters', () => {
  const timestamp = '2026-11-09T21:26:09Z'
  const observed = { ...rule(0, 'example.test'), extra: {
    disabled: false, hitCount: 0, missCount: 0, hitAt: timestamp, missAt: timestamp,
  } }
  assert.deepEqual(ruleStats(observed), { disabled: false, hits: 0, misses: 0, hitAt: null, missAt: null })
  assert.deepEqual(ruleStats({ ...observed, extra: { hitAt: timestamp } as Rule['extra'] }), {
    disabled: null, hits: null, misses: null, hitAt: Date.parse(timestamp), missAt: null,
  })
  assert.deepEqual(ruleStats({ ...observed, extra: { ...observed.extra, hitCount: 1, missCount: 1, hitAt: '1970-01-01T00:00:00Z', missAt: '0001-01-01T00:00:00Z' } }), {
    disabled: false, hits: 1, misses: 1, hitAt: null, missAt: null,
  })
})

test('empty or wholly invalid extras do not advertise rule statistics support', () => {
  const source = rule(0, 'example.test')
  for (const extra of [{}, [], { unknown: true }, { disabled: 'false', hitCount: -1, missAt: 'not a date' }]) {
    assert.equal(ruleStats({ ...source, extra: extra as unknown as Rule['extra'] }), null)
  }
  assert.deepEqual(ruleStats({ ...source, extra: { disabled: false } as Rule['extra'] }), {
    disabled: false, hits: null, misses: null, hitAt: null, missAt: null,
  })
  assert.deepEqual(ruleStats({ ...source, extra: { hitCount: 0 } as Rule['extra'] }), {
    disabled: null, hits: 0, misses: null, hitAt: null, missAt: null,
  })
})

test('PTR strictly reverses IPv4 and IPv6, including compressed and mapped IPv6', () => {
  assert.equal(reverseDnsName('192.0.2.5'), '5.2.0.192.in-addr.arpa')
  assert.equal(reverseDnsName('5.2.0.192.in-addr.arpa.'), '5.2.0.192.in-addr.arpa')
  const reverse = '20010db8000000000000000000000001'.split('').reverse().join('.') + '.ip6.arpa'
  assert.equal(reverseDnsName('2001:db8::1'), reverse)
  assert.equal(reverseDnsName('[2001:db8::1]'), reverse)
  assert.equal(reverseDnsName(reverse), reverse)
  assert.equal(reverseDnsName('::ffff:192.0.2.5'), '00000000000000000000ffffc0000205'.split('').reverse().join('.') + '.ip6.arpa')
  for (const value of ['127.1', '0x7f000001', '192.168.001.1', '256.2.3.4', '1.2.3.in-addr.arpa', '[::1]:80', 'fe80::1%eth0', 'https://1.2.3.4', 'example.com', 'a.ip6.arpa']) {
    assert.equal(reverseDnsName(value), null, value)
  }
})

test('DNS query normalization allows record labels without leaking URL paths or credentials', () => {
  assert.equal(dnsQueryName('https://EXAMPLE.com/path?secret=x', 'MX'), 'example.com')
  assert.equal(dnsQueryName('_dmarc.example.com.', 'TXT'), '_dmarc.example.com')
  assert.equal(dnsQueryName('пример.рф', 'AAAA'), 'xn--e1afmkfd.xn--p1ai')
  assert.equal(dnsQueryName('192.0.2.5', 'PTR'), '5.2.0.192.in-addr.arpa')
  for (const value of ['http://user:secret@example.com', 'bad host', '_dmarc..example.com', '_.-bad.test', '192.0.2.5']) assert.equal(dnsQueryName(value, 'A'), null)
})

test('DNS authority and flags survive negative answers; absent flags remain unknown', () => {
  const response: DnsResponse = { Status: 3,
    Question: [{ Name: 'missing.test.', Qtype: 15, Qclass: 1 }],
    Authority: [{ name: 'test.', type: 6, TTL: 0, data: 'ns.test. hostmaster.test. 1 2 3 4 5' }],
    Additional: [{ name: 'ns.test.', type: 1, TTL: 60, data: '192.0.2.1' }], TC: false, AD: true,
  }
  assert.equal(dnsRecords(response).length, 0)
  assert.equal(dnsRecords(response, 'Authority')[0].TTL, 0)
  assert.equal(dnsRecords(response, 'Additional')[0].data, '192.0.2.1')
  assert.equal(dnsQuestions(response)[0].Qtype, 15)
  assert.deepEqual(dnsFlags(response), [{ name: 'TC', value: false }, { name: 'AD', value: true }])
  assert.deepEqual(dnsFlags({ Status: 0 }), [])
  assert.deepEqual([2, 6, 12, 15, 16, 257, 65].map(dnsRecordType), ['NS', 'SOA', 'PTR', 'MX', 'TXT', 'CAA', '65'])
})
