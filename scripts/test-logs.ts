import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesLog, normalizeLog, subscribeLogs, type LogStream, type NormalizedLog } from '../src/lib/logs.ts'

test('structured logs preserve the core clock and normalize warn with typed fields', () => {
  const log = normalizeLog({ time: '23:01:02', level: 'warn', message: 'Connection failed', fields: [{ key: 'host', value: 'example.org' }, { key: 'attempt', value: 0 }, { key: 'connected', value: false }] }, 1234)
  assert.deepEqual(log, { coreTime: '23:01:02', level: 'warning', message: 'Connection failed', fields: [{ key: 'host', value: 'example.org' }, { key: 'attempt', value: '0' }, { key: 'connected', value: 'false' }], receivedAt: 1234, format: 'structured' })
})

test('legacy logs use browser receipt time without pretending it is core time', () => {
  assert.deepEqual(normalizeLog({ type: 'info', payload: '[TCP] connected' }, 42), { level: 'info', message: '[TCP] connected', coreTime: null, receivedAt: 42, fields: [], format: 'legacy' })
})

test('invalid frames and malformed timestamps do not break the log stream', () => {
  for (const value of [null, [], 'text', { message: 'HTTP error' }, { level: 'info', message: {} }, { type: 'info', payload: null }]) assert.equal(normalizeLog(value), null)
  const value = { time: '99:99:99', level: 'custom', message: '', fields: [null, { key: 'missing' }, { key: '', value: 1 }, { key: 'data', value: { a: 1 } }, { key: 'nil', value: null }] }
  const line = normalizeLog(value)!
  assert.equal(line.coreTime, null)
  assert.equal(line.level, 'custom')
  assert.deepEqual(line.fields, [{ key: 'data', value: '{"a":1}' }, { key: 'nil', value: 'null' }])
  assert.equal(normalizeLog({ ...value, time: '2026-11-10T12:30:40Z' })!.coreTime, '2026-11-10T12:30:40Z')
})

test('search covers message, field names and values; selected field scopes the query', () => {
  const line = normalizeLog({ level: 'info', message: 'Connected', fields: { host: 'Example.ORG', process: 'browser' } })!
  assert.ok(matchesLog(line, 'connect'))
  assert.ok(matchesLog(line, 'HOST'))
  assert.ok(matchesLog(line, 'EXAMPLE'))
  assert.ok(matchesLog(line, 'example', 'host'))
  assert.ok(matchesLog(line, '', 'process'))
  assert.equal(matchesLog(line, 'example', 'process'), false)
  assert.equal(matchesLog(line, '', 'missing'), false)
})

function fixture(synchronousFailure = false) {
  const calls: { path: string; data: (value: unknown) => void; options: Parameters<LogStream>[2]; stopped: boolean }[] = []
  const open: LogStream = (path, data, options) => {
    const call = { path, data, options, stopped: false }
    calls.push(call)
    if (synchronousFailure) options.onFailure()
    return () => { call.stopped = true }
  }
  return { calls, open }
}

test('an initial connection failure downgrades exactly once, disposing the old retry loop', async () => {
  const { calls, open } = fixture(true)
  const lines: NormalizedLog[] = []
  const stop = subscribeLogs(open, 'warning', line => lines.push(line))
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].options.query, { level: 'warning', format: 'structured' })
  assert.deepEqual(calls[1].options.query, { level: 'warning' })
  assert.equal(calls[0].stopped, true)
  calls[0].data({ type: 'info', payload: 'Late old frame' })
  calls[1].data({ type: 'warning', payload: 'Legacy frame' })
  calls[1].options.onFailure()
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.deepEqual(lines.map(line => line.message), ['Legacy frame'])
  stop()
  assert.equal(calls[1].stopped, true)
})

test('cleanup before a queued downgrade prevents a new connection and late updates', async () => {
  const { calls, open } = fixture()
  const lines: NormalizedLog[] = [], states: boolean[] = []
  const stop = subscribeLogs(open, 'info', line => lines.push(line), state => states.push(state))
  calls[0].options.onFailure()
  stop()
  await Promise.resolve()
  calls[0].data({ type: 'info', payload: 'Late' })
  calls[0].options.onState(true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].stopped, true)
  assert.deepEqual(lines, [])
  assert.deepEqual(states, [])
})

test('accepted structured and legacy streams keep normal reconnect behavior', async () => {
  for (const frame of [{ level: 'info', message: 'Structured', fields: [] }, { type: 'info', payload: 'Legacy' }]) {
    const { calls, open } = fixture()
    const stop = subscribeLogs(open, 'debug', () => {})
    calls[0].data(frame)
    calls[0].options.onFailure()
    await Promise.resolve()
    assert.equal(calls.length, 1)
    stop()
  }
})
