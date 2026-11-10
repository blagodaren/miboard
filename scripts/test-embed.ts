import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseEmbed } from '../src/lib/embed.ts'

test('hideMode is read from the query and from the hash query', () => {
  assert.equal(parseEmbed('', '').hideMode, false)
  assert.equal(parseEmbed('?host=1.2.3.4', '#/overview').hideMode, false)
  for (const search of ['?hideMode', '?hideMode=1', '?hideMode=true', '?hideMode=yes', '?secret=x&hideMode=TRUE']) assert.equal(parseEmbed(search, '').hideMode, true, search)
  for (const search of ['?hideMode=0', '?hideMode=false', '?hideMode=no', '?hideMode=off', '?hidemode=1']) assert.equal(parseEmbed(search, '').hideMode, false, search)
  assert.equal(parseEmbed('', '#/setup?hostname=1.2.3.4&hideMode=1').hideMode, true)
  assert.equal(parseEmbed('?hideMode=1', '#/setup?hideMode=0').hideMode, false, 'the hash query wins like the other link parameters')
})
