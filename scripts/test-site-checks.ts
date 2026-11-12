import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSiteUrls, runSiteChecks, siteCheckPath, siteTargetKey, type SiteCell } from '../src/lib/site-checks.ts'

test('accepts bounded HTTP URLs, removes fragments, rejects credentials and invalid protocols', () => {
  assert.deepEqual(parseSiteUrls('https://example.com/#a\nhttps://example.com/#b\nhttp://example.net/path'), ['https://example.com/', 'http://example.net/path'])
  for (const input of ['', 'javascript:alert(1)', 'https://a:b@example.com', 'https://example.com/a b', Array(6).fill('https://example.com').join('\n')]) assert.throws(() => parseSiteUrls(input))
})
test('provider-only nodes and repeated node names keep distinct escaped endpoints', () => {
  assert.equal(siteCheckPath({ name: 'a/b', provider: 'p/q' }), '/providers/proxies/p%2Fq/a%2Fb/healthcheck')
  assert.equal(siteCheckPath({ name: 'a/b' }), '/proxies/a%2Fb/delay')
  assert.notEqual(siteTargetKey({ name: 'same', provider: 'one' }), siteTargetKey({ name: 'same', provider: 'two' }))
})
test('matrix retains every URL/node pair, caps concurrency and reports failed RTT separately', async () => {
  let active = 0, peak = 0
  const snapshots: SiteCell[][] = []
  const result = await runSiteChecks(['https://a/', 'https://b/'], [{ name: 'one' }, { name: 'two' }], 5000, async (target, url) => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5)); active--
    return { delay: target.name === 'one' && url === 'https://b/' ? 0 : 42 }
  }, new AbortController().signal, cells => snapshots.push(cells), 99)
  assert.equal(peak, 3)
  assert.equal(result.length, 4)
  assert.equal(result.filter(cell => cell.state === 'done').length, 3)
  assert.equal(result.filter(cell => cell.state === 'failed').length, 1)
  assert.equal(snapshots[0][0].state, 'pending')
})
test('cancellation stops queued checks and marks all uncompleted cells', async () => {
  const abort = new AbortController(); let calls = 0
  const result = await runSiteChecks(['https://a/', 'https://b/'], [{ name: 'one' }, { name: 'two' }], 5000, async () => { calls++; abort.abort(); return { delay: 1 } }, abort.signal, () => {}, 1)
  assert.equal(calls, 1)
  assert.ok(result.every(cell => cell.state === 'cancelled'))
})
test('invalid matrix sizes and timeouts fail before issuing requests', async () => {
  let calls = 0
  const check = async () => { calls++; return { delay: 1 } }
  await assert.rejects(runSiteChecks(['https://a/'], [], 5000, check, new AbortController().signal, () => {}))
  await assert.rejects(runSiteChecks(['https://a/'], [{ name: 'a' }], 32768, check, new AbortController().signal, () => {}))
  assert.equal(calls, 0)
})
