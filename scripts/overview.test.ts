import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnalysisTracker, type AnalysisSnapshot, type IPStat } from '../src/lib/analysis.ts'
import { overviewRegions } from '../src/lib/overview.ts'
import type { Connection } from '../src/lib/api.ts'

const ip = (name: string, countries: string[], download: number, upload = 0, connections = 1): IPStat => ({
  name, countries, download, upload, connections, active: 0, lastSeen: 0, domains: [], proxies: [], asn: [],
})

function snapshot(ips: IPStat[], totals?: Partial<AnalysisSnapshot['totals']>) {
  return {
    ips,
    totals: {
      download: ips.reduce((sum, row) => sum + row.download, 0),
      upload: ips.reduce((sum, row) => sum + row.upload, 0),
      connections: ips.reduce((sum, row) => sum + row.connections, 0),
      active: 0,
      ...totals,
    },
  }
}

function sums(rows: ReturnType<typeof overviewRegions>) {
  return rows.reduce((total, row) => ({
    download: total.download + row.download,
    upload: total.upload + row.upload,
    connections: total.connections + row.connections,
  }), { download: 0, upload: 0, connections: 0 })
}

test('region buckets normalize and deduplicate ISO codes; destination metadata wins over lookup', () => {
  const source = snapshot([
    ip('1.1.1.1', [' us ', 'US', 'private'], 100, 10, 2),
    ip('8.8.8.8', ['US'], 200, 20, 3),
    ip('9.9.9.9', ['DE'], 50, 5),
  ])
  const before = structuredClone(source)
  const rows = overviewRegions(source, () => { throw new Error('Metadata must have priority') })
  assert.deepEqual(rows, [
    { name: 'US', download: 300, upload: 30, connections: 5 },
    { name: 'DE', download: 50, upload: 5, connections: 1 },
  ])
  assert.deepEqual(source, before, 'The helper must not mutate its snapshot')
  assert.deepEqual(sums(rows), { download: 350, upload: 35, connections: 6 })
})

test('unknown includes unresolved IPs and all traffic/connections without an IP', () => {
  const rows = overviewRegions(snapshot([
    ip('1.1.1.1', ['NL'], 100, 10, 2),
    ip('192.168.1.1', [], 50, 20, 3),
  ], { download: 200, upload: 60, connections: 7 }))
  assert.deepEqual(rows, [
    { name: 'unknown', download: 100, upload: 50, connections: 5 },
    { name: 'NL', download: 100, upload: 10, connections: 2 },
  ])
  assert.deepEqual(sums(rows), { download: 200, upload: 60, connections: 7 })
})

test('conflicting valid country codes remain unknown even when local lookup has an answer', () => {
  const rows = overviewRegions(snapshot([ip('1.1.1.1', ['US', 'NL', 'US'], 100, 30, 2)]), () => {
    throw new Error('A local lookup must not override conflicting metadata')
  })
  assert.deepEqual(rows, [{ name: 'unknown', download: 100, upload: 30, connections: 2 }])
})

test('local lookup fills missing/invalid metadata and its result must also be a valid country', () => {
  const requested: string[] = []
  const rows = overviewRegions(snapshot([
    ip('1.1.1.1', [], 300),
    ip('8.8.8.8', ['ZZ', 'EU'], 100),
    ip('9.9.9.9', ['private'], 50),
  ]), (name) => {
    requested.push(name)
    return name === '1.1.1.1' ? ' de ' : name === '8.8.8.8' ? 'NL' : 'ZZ'
  })
  assert.deepEqual(requested, ['1.1.1.1', '8.8.8.8', '9.9.9.9'])
  assert.deepEqual(rows.map((row) => row.name), ['DE', 'NL', 'unknown'])
  assert.deepEqual(sums(rows), { download: 450, upload: 0, connections: 3 })
})

test('closed connections retain session traffic; connections without IP remain unknown', () => {
  const connection = (id: string, destinationIP: string, country: string | null): Connection => ({
    id, metadata: {
      network: 'tcp', type: 'Tun', sourceIP: '192.168.1.2', sourcePort: '40000',
      destinationIP, destinationPort: '443', host: 'example.com', destinationGeoIP: country ? [country] : null,
    },
    download: 100, upload: 20, start: '2026-11-08T12:00:00Z', chains: ['DIRECT'], rule: 'Match', rulePayload: '',
  })
  const tracker = new AnalysisTracker()
  tracker.ingest([])
  tracker.ingest([connection('located', '1.1.1.1', 'US'), connection('no-ip', '', null)])
  const open = overviewRegions(tracker.snapshot())
  tracker.ingest([])
  const closed = tracker.snapshot()
  assert.equal(closed.totals.active, 0)
  assert.deepEqual(overviewRegions(closed), open)
  assert.deepEqual(open, [
    { name: 'unknown', download: 100, upload: 20, connections: 1 },
    { name: 'US', download: 100, upload: 20, connections: 1 },
  ])
  assert.deepEqual(sums(open), { download: 200, upload: 40, connections: 2 })
})

test('zero-byte sessions keep connection counts; an empty session has no region rows', () => {
  assert.deepEqual(overviewRegions(snapshot([])), [])
  assert.deepEqual(overviewRegions(snapshot([], { connections: 2 })), [
    { name: 'unknown', download: 0, upload: 0, connections: 2 },
  ])
  assert.deepEqual(overviewRegions(snapshot([ip('1.1.1.1', ['DE'], 0)])), [
    { name: 'DE', download: 0, upload: 0, connections: 1 },
  ])
})

test('invalid/oversized IP counters cannot exceed authoritative session totals', () => {
  const rows = overviewRegions(snapshot([
    ip('1.1.1.1', ['DE'], NaN, -1, Infinity),
    ip('8.8.8.8', ['US'], 1_000, 200, 10),
  ], { download: 100, upload: 20, connections: 2 }))
  assert.deepEqual(rows, [{ name: 'US', download: 100, upload: 20, connections: 2 }])
  assert.deepEqual(sums(rows), { download: 100, upload: 20, connections: 2 })
})
