// Offline country lookup. Data: DB-IP Country Lite, CC BY 4.0 (public/geodb/NOTICE.md).
// The compact file stores consecutive range endpoints as delta LEB128 + country index.

const MAGIC = 'MIG1'
const MAX_BYTES = 32 * 1024 * 1024
const MAX_RANGES = 2_000_000
const IPV4_MAX = 0xffff_ffff
const IPV6_MAX = (1n << 128n) - 1n

type Address = { version: 4; value: number; text: string } | { version: 6; words: number[]; text: string }

function ipv4(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null
  return parts.map(Number)
}

function parse(value: unknown): Address | null {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (!text || text.includes('%')) return null
  if (!text.includes(':')) {
    const bytes = ipv4(text)
    return bytes ? { version: 4, value: bytes.reduce((result, byte) => result * 256 + byte, 0), text: bytes.join('.') } : null
  }
  if (!/^[\da-fA-F:.]+$/.test(text) || text.split('::').length > 2) return null
  if (text.includes('.')) {
    const tail = text.lastIndexOf(':')
    const bytes = ipv4(text.slice(tail + 1))
    if (!bytes) return null
    text = text.slice(0, tail + 1) + ((bytes[0] << 8) | bytes[1]).toString(16) + ':' + ((bytes[2] << 8) | bytes[3]).toString(16)
  }
  const compressed = text.includes('::')
  const [left, right = ''] = text.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  if ([...start, ...end].some((word) => !/^[\da-fA-F]{1,4}$/.test(word))) return null
  const missing = 8 - start.length - end.length
  if (compressed ? missing < 1 : missing !== 0) return null
  const words = [...start.map((word) => parseInt(word, 16)), ...Array(missing).fill(0), ...end.map((word) => parseInt(word, 16))]
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const bytes = [words[6] >>> 8, words[6] & 255, words[7] >>> 8, words[7] & 255]
    return { version: 4, value: words[6] * 65536 + words[7], text: bytes.join('.') }
  }
  return { version: 6, words, text: words.map((word) => word.toString(16)).join(':') }
}

function routable(address: Address): boolean {
  if (address.version === 4) {
    const a = address.value >>> 24
    const b = (address.value >>> 16) & 255
    const c = (address.value >>> 8) & 255
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  const [a, b, c] = address.words
  // Global unicast only. This also excludes loopback, ULA, link-local and multicast.
  if (a < 0x2000 || a > 0x3fff) return false
  return !((a === 0x2001 && (b === 0xdb8 || (b === 2 && c === 0) ||
    (b >= 0x10 && b <= 0x2f))) || (a === 0x3fff && b < 0x1000))
}

/** Strict IP literals only. Never resolves a hostname or accepts a fake/private destination. */
export function publicIp(value: unknown): string | null {
  const address = parse(value)
  return address && routable(address) ? address.text : null
}

export class GeoDatabase {
  readonly #countries: string[] = []
  readonly #v4: Uint32Array
  readonly #v4Countries: Uint8Array
  readonly #v6: Uint32Array
  readonly #v6Countries: Uint8Array

  constructor(bytes: Uint8Array) {
    const invalid = () => new Error('Invalid offline GeoIP database')
    if (bytes.length < 14 || bytes.length > MAX_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw invalid()
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const countryCount = header.getUint16(4, true)
    const v4Count = header.getUint32(6, true)
    const v6Count = header.getUint32(10, true)
    if (countryCount < 1 || countryCount > 256 || v4Count + v6Count > MAX_RANGES || v4Count + v6Count === 0 ||
      14 + countryCount * 2 + (v4Count + v6Count) * 2 > bytes.length) throw invalid()
    let offset = 14
    for (let index = 0; index < countryCount; index++) {
      const code = String.fromCharCode(bytes[offset++], bytes[offset++])
      if (!/^[A-Z]{2}$/.test(code) || this.#countries.includes(code)) throw invalid()
      this.#countries.push(code)
    }
    const countryIndex = () => {
      if (offset >= bytes.length || bytes[offset] >= countryCount) throw invalid()
      return bytes[offset++]
    }
    const delta4 = () => {
      let value = 0
      let multiplier = 1
      for (let index = 0; index < 5; index++) {
        if (offset >= bytes.length) throw invalid()
        const byte = bytes[offset++]
        value += (byte & 127) * multiplier
        if (!(byte & 128)) {
          if (value < 1 || value > IPV4_MAX + 1) throw invalid()
          return value
        }
        multiplier *= 128
      }
      throw invalid()
    }
    const delta6 = () => {
      let value = 0n
      for (let index = 0; index < 19; index++) {
        if (offset >= bytes.length) throw invalid()
        const byte = bytes[offset++]
        value |= BigInt(byte & 127) << BigInt(index * 7)
        if (!(byte & 128)) {
          if (value < 1n || value > IPV6_MAX + 1n) throw invalid()
          return value
        }
      }
      throw invalid()
    }
    this.#v4 = new Uint32Array(v4Count)
    this.#v4Countries = new Uint8Array(v4Count)
    let previous4 = -1
    for (let index = 0; index < v4Count; index++) {
      previous4 += delta4()
      if (previous4 > IPV4_MAX) throw invalid()
      this.#v4[index] = previous4
      this.#v4Countries[index] = countryIndex()
    }
    if (v4Count && previous4 !== IPV4_MAX) throw invalid()
    this.#v6 = new Uint32Array(v6Count * 4)
    this.#v6Countries = new Uint8Array(v6Count)
    let previous6 = -1n
    for (let index = 0; index < v6Count; index++) {
      previous6 += delta6()
      if (previous6 > IPV6_MAX) throw invalid()
      for (let word = 0; word < 4; word++) this.#v6[index * 4 + word] = Number((previous6 >> BigInt((3 - word) * 32)) & 0xffff_ffffn)
      this.#v6Countries[index] = countryIndex()
    }
    if ((v6Count && previous6 !== IPV6_MAX) || offset !== bytes.length) throw invalid()
  }

  lookup(ip: string): string | null {
    const address = parse(ip)
    if (!address || !routable(address)) return null
    let lower = 0
    let upper = address.version === 4 ? this.#v4.length : this.#v6Countries.length
    if (!upper) return null
    const words = address.version === 6 ? [0, 2, 4, 6].map((index) => address.words[index] * 65536 + address.words[index + 1]) : []
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      let comparison = 0
      if (address.version === 4) comparison = this.#v4[middle] - address.value
      else for (let word = 0; word < 4; word++) {
        comparison = this.#v6[middle * 4 + word] - words[word]
        if (comparison) break
      }
      if (comparison >= 0) upper = middle
      else lower = middle + 1
    }
    const index = address.version === 4 ? this.#v4Countries[lower] : this.#v6Countries[lower]
    const code = this.#countries[index]
    return code && code !== 'ZZ' ? code : null
  }
}

let loading: Promise<GeoDatabase> | null = null

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error('Offline GeoIP database exceeds the size limit')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

/** Fetches the bundled asset once; errors are retryable and no destination IP leaves the browser. */
export function loadGeoDatabase(): Promise<GeoDatabase> {
  if (!loading) loading = (async () => {
    const base = new URL(import.meta.env?.BASE_URL ?? './', document.baseURI)
    const response = await fetch(new URL('geodb/country.bin.gz', base), { signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) throw new Error('Cannot load the offline GeoIP database')
    // Some hosts (including Vite) attach Content-Encoding: gzip to .gz assets;
    // fetch has already decompressed those responses. Plain static hosts do not.
    const payload = await readLimited(response.body, MAX_BYTES)
    if (payload[0] !== 0x1f || payload[1] !== 0x8b) return new GeoDatabase(payload)
    if (payload.length > 8 * 1024 * 1024) throw new Error('Offline GeoIP database exceeds the compressed size limit')
    const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))
    return new GeoDatabase(await readLimited(stream, MAX_BYTES))
  })().catch((error) => { loading = null; throw error })
  return loading
}
