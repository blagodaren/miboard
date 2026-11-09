import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NotificationCenter, NOTIFICATION_LIFETIME, NOTIFICATION_QUEUE_LIMIT, notificationText } from '../src/lib/notifications.ts'

function fixture() {
  let now = 0, sequence = 0
  const jobs = new Map<number, { at: number; callback: () => void }>()
  const center = new NotificationCenter({
    now: () => now,
    set(callback, delay) { const id = ++sequence; jobs.set(id, { at: now + delay, callback }); return id },
    clear(id) { jobs.delete(id as number) },
  })
  function advance(ms: number) {
    const until = now + ms
    while (true) {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      now = next[1].at
      jobs.delete(next[0])
      next[1].callback()
    }
    now = until
  }
  return { center, advance, jobs }
}

test('a notification expires after eight seconds without extending its lifetime on rerenders', () => {
  const { center, advance } = fixture()
  center.show({ id: 'one', message: 'One' })
  advance(NOTIFICATION_LIFETIME - 1)
  assert.equal(center.visible.length, 1)
  void center.visible
  advance(1)
  assert.deepEqual(center.entries, [])
})

test('hover and keyboard focus pause independently and resume the exact remaining time', () => {
  const { center, advance } = fixture()
  center.show({ id: 'one', message: 'One' })
  advance(3000)
  center.pause('one', 'pointer')
  center.pause('one', 'focus')
  advance(20000)
  center.resume('one', 'pointer')
  advance(10000)
  assert.equal(center.visible.length, 1)
  center.resume('one', 'focus')
  advance(4999)
  assert.equal(center.visible.length, 1)
  advance(1)
  assert.equal(center.visible.length, 0)
})

test('repeated notices replace in place with a fresh lifetime and preserve an active hover', () => {
  const { center, advance } = fixture()
  center.show({ id: 'same', message: 'Old', tone: 'error' })
  advance(6000)
  center.pause('same', 'pointer')
  center.show({ id: 'same', message: 'New', tone: 'success' })
  assert.equal(center.entries.length, 1)
  advance(20000)
  assert.equal(center.visible[0].message, 'New')
  assert.equal(center.visible[0].tone, 'success')
  center.resume('same', 'pointer')
  advance(7999)
  assert.equal(center.visible.length, 1)
  advance(1)
  assert.equal(center.visible.length, 0)
})

test('at most three notices run timers; the next queued item receives all eight seconds', () => {
  const { center, advance } = fixture()
  for (const id of ['one', 'two', 'three', 'queued']) center.show({ id, message: id })
  assert.deepEqual(center.visible.map(item => item.id), ['one', 'two', 'three'])
  advance(7999)
  center.dismiss('two')
  assert.equal(center.visible.at(-1)?.id, 'queued')
  advance(1)
  assert.deepEqual(center.visible.map(item => item.id), ['queued'])
  advance(7998)
  assert.equal(center.visible.length, 1)
  advance(1)
  assert.equal(center.visible.length, 0)
})

test('a burst is bounded and never evicts on-screen notifications while reading them', () => {
  const { center } = fixture()
  for (let i = 0; i < 40; i++) center.show({ id: String(i), message: String(i) })
  assert.equal(center.entries.length, NOTIFICATION_QUEUE_LIMIT)
  assert.deepEqual(center.visible.map(item => item.id), ['0', '1', '2'])
  assert.equal(center.entries.at(-1)?.id, '39')
})

test('a short viewport queues extra cards and preserves their remaining visible lifetime', () => {
  const { center, advance } = fixture()
  for (const id of ['one', 'two', 'three']) center.show({ id, message: id })
  advance(3000)
  center.setVisibleLimit(1)
  assert.deepEqual(center.visible.map(item => item.id), ['one'])
  advance(5000)
  assert.deepEqual(center.visible.map(item => item.id), ['two'])
  center.setVisibleLimit(3)
  advance(4999)
  assert.equal(center.visible.length, 2)
  advance(1)
  assert.equal(center.visible.length, 0)
})

test('hidden documents pause old and newly created notifications without consuming their time', () => {
  const { center, advance } = fixture()
  center.show({ id: 'old', message: 'Old' })
  advance(2000)
  center.pauseAll('document-hidden')
  center.show({ id: 'new', message: 'New' })
  advance(60000)
  assert.equal(center.visible.length, 2)
  center.resumeAll('document-hidden')
  advance(6000)
  assert.deepEqual(center.visible.map(item => item.id), ['new'])
  advance(2000)
  assert.equal(center.visible.length, 0)
})

test('changing backend removes only mismatched scoped notices and starts the next queue item', () => {
  const { center } = fixture()
  center.show({ id: 'a', scope: 'backend-a' })
  center.show({ id: 'global' })
  center.show({ id: 'b', scope: 'backend-b' })
  center.show({ id: 'queued', scope: 'backend-b' })
  center.dismissOtherScopes('backend-b')
  assert.deepEqual(center.visible.map(item => item.id), ['global', 'b', 'queued'])
})

test('dismissal and clearing cancel timers and cannot remove a later notice with the same ID', () => {
  const { center, advance, jobs } = fixture()
  center.show({ id: 'one', message: 'Old' })
  advance(1000)
  center.dismiss('one')
  assert.equal(jobs.size, 0)
  center.show({ id: 'one', message: 'New' })
  advance(7000)
  assert.equal(center.visible[0].message, 'New')
  center.clear()
  assert.equal(jobs.size, 0)
  advance(20000)
  assert.deepEqual(center.entries, [])
})

test('translation callbacks stay live without re-creating or extending a notice', () => {
  const { center, advance } = fixture()
  let language = 'en'
  center.show({ id: 'localized', message: () => language === 'en' ? 'Saved' : 'Сохранено' })
  assert.equal(notificationText(center.visible[0].message), 'Saved')
  advance(7000)
  language = 'ru'
  assert.equal(notificationText(center.visible[0].message), 'Сохранено')
  advance(1000)
  assert.equal(center.visible.length, 0)
})
