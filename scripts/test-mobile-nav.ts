import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_MOBILE_NAV, NAV_ROUTES, moveMobileNav, normalizeMobileNav } from '../src/lib/mobile-nav.ts'

test('mobile nav order keeps saved sections and appends new ones', () => {
  assert.deepEqual(normalizeMobileNav(null), DEFAULT_MOBILE_NAV)
  const order = normalizeMobileNav(['logs', 'logs', 'setup', 'unknown', 42, 'rules'])
  assert.deepEqual(order.slice(0, 2), ['logs', 'rules'])
  assert.equal(order.length, NAV_ROUTES.length)
  assert.equal(new Set(order).size, NAV_ROUTES.length)
})

test('mobile nav moves stay in bounds', () => {
  const order = [...DEFAULT_MOBILE_NAV]
  assert.deepEqual(moveMobileNav(order, 0, -1), order)
  assert.deepEqual(moveMobileNav(order, order.length - 1, 1), order)
  assert.deepEqual(moveMobileNav(order, 4, -1).slice(3, 5), [order[4], order[3]])
})
