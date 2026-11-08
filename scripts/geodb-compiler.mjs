// Provider-independent CSV range compiler for the existing offline MIG1 decoder.
function address(value, family) {
  const max = (1n << BigInt(family === 4 ? 32 : 128)) - 1n
  let result
  if (/^\d+$/.test(value)) result = BigInt(value)
  else if (family === 4) {
    const parts = value.split('.')
    if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) throw new Error(`Invalid IPv4 address: ${value}`)
    result = parts.reduce((number, part) => number * 256n + BigInt(part), 0n)
  } else {
    let input = value
    if (input.includes('.')) {
      const tail = input.lastIndexOf(':')
      const v4 = address(input.slice(tail + 1), 4)
      input = input.slice(0, tail + 1) + (v4 >> 16n).toString(16) + ':' + (v4 & 65535n).toString(16)
    }
    if (!/^[\da-f:]+$/i.test(input) || input.split('::').length > 2) throw new Error(`Invalid IPv6 address: ${value}`)
    const [left, right = ''] = input.split('::')
    const first = left ? left.split(':') : []
    const last = right ? right.split(':') : []
    const missing = 8 - first.length - last.length
    if ((input.includes('::') ? missing < 1 : missing !== 0) || [...first, ...last].some((word) => !/^[\da-f]{1,4}$/i.test(word))) throw new Error(`Invalid IPv6 address: ${value}`)
    result = [...first, ...Array(missing).fill('0'), ...last].reduce((number, word) => (number << 16n) | BigInt(`0x${word}`), 0n)
  }
  if (result < 0n || result > max) throw new Error(`IPv${family} address out of range: ${value}`)
  return result
}

function ranges(csv, family) {
  const rows = []
  const max = (1n << BigInt(family === 4 ? 32 : 128)) - 1n
  let next = 0n
  let sourceRows = 0
  const append = (end, country) => {
    if (rows.at(-1)?.country === country) rows.at(-1).end = end
    else rows.push({ end, country })
  }
  for (const [index, raw] of csv.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const fields = raw.split(',').map((field) => {
      const value = field.trim()
      return /^"[^"\r\n]*"$/.test(value) ? value.slice(1, -1) : value
    })
    const [first, last, country] = fields
    if (fields.length !== 3 || !first || !last || !/^[A-Z]{2}$/.test(country)) throw new Error(`Invalid IPv${family} CSV line ${index + 1}`)
    const start = address(first, family)
    const end = address(last, family)
    if (start > end) throw new Error(`Invalid IPv${family} range at line ${index + 1}`)
    if (start < next) throw new Error(`Overlapping or unsorted IPv${family} range at line ${index + 1}`)
    if (start > next) append(start - 1n, 'ZZ')
    append(end, country)
    next = end + 1n
    sourceRows++
  }
  if (!sourceRows) throw new Error(`Empty IPv${family} CSV`)
  if (next <= max) append(max, 'ZZ')
  return { rows, sourceRows }
}

export function compileCountryCsv(ipv4Text, ipv6Text) {
  const v4 = ranges(ipv4Text, 4)
  const v6 = ranges(ipv6Text, 6)
  if (v4.rows.length + v6.rows.length > 2_000_000) throw new Error('MIG1 range limit exceeded (2,000,000)')
  const countries = [...new Set([...v4.rows, ...v6.rows].map((row) => row.country))].sort()
  if (countries.length > 256) throw new Error('MIG1 country limit exceeded (256)')
  const indices = new Map(countries.map((country, index) => [country, index]))
  const header = Buffer.alloc(14)
  header.write('MIG1')
  header.writeUInt16LE(countries.length, 4)
  header.writeUInt32LE(v4.rows.length, 6)
  header.writeUInt32LE(v6.rows.length, 10)
  const output = [...header, ...Buffer.from(countries.join(''))]
  for (const family of [v4, v6]) {
    let previous = -1n
    for (const { end, country } of family.rows) {
      let delta = end - previous
      while (delta > 127n) { output.push(Number(delta & 127n) | 128); delta >>= 7n }
      output.push(Number(delta), indices.get(country))
      previous = end
    }
  }
  return {
    binary: Uint8Array.from(output),
    ranges: { ipv4: v4.rows.length, ipv6: v6.rows.length },
    countries: countries.length,
    sourceRows: { ipv4: v4.sourceRows, ipv6: v6.sourceRows },
  }
}
