import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROXY_GROUPS_KEY, readProxyGroups } from '../src/lib/proxy-groups.ts'

test('proxy group preferences reject invalid roots and preserve only booleans', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let raw: string | null = null
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => { assert.equal(key, PROXY_GROUPS_KEY); return raw },
  } })
  t.after(() => previous ? Object.defineProperty(globalThis, 'localStorage', previous) : Reflect.deleteProperty(globalThis, 'localStorage'))
  for (raw of [null, 'null', '[]', '[true,false]', '42', 'true', '"Main"', '{broken']) {
    assert.deepEqual(readProxyGroups(), {}, String(raw))
  }
  raw = '{"Main":true,"Closed":false,"String":"false","Number":1,"Null":null,"Object":{},"Array":[]}'
  assert.deepEqual(readProxyGroups(), { Main: true, Closed: false })

  raw = '{"__proto__":false,"constructor":true,"toString":false,"prototype":{"polluted":true}}'
  const groups = readProxyGroups()
  assert.equal(Object.getPrototypeOf(groups), Object.prototype)
  assert.equal(Object.hasOwn(groups, '__proto__'), true)
  assert.equal(groups.__proto__, false)
  assert.equal(groups.constructor, true)
  assert.equal(groups.toString, false)
  assert.equal(Object.hasOwn(groups, 'prototype'), false)
  assert.equal(Object.hasOwn({}, 'polluted'), false)

  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Blocked storage') } })
  assert.deepEqual(readProxyGroups(), {})
})
