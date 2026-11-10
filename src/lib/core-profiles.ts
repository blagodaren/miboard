import type { Backend } from './api'

export type CoreProfile = 'heap' | 'allocs'
export type ProfileErrorCode = 'unsupported' | 'unauthorized' | 'network' | 'timeout' | 'invalid' | 'tooLarge' | 'http'
export class CoreProfileError extends Error {
  code: ProfileErrorCode
  constructor(code: ProfileErrorCode) { super(code); this.name = 'CoreProfileError'; this.code = code }
}

const MAX_BYTES = 32 * 1024 * 1024

/** Only on demand; no GC, CPU sampling, credentials in URLs, or raw error bodies. */
export async function fetchCoreProfile(
  backend: Backend,
  kind: CoreProfile,
  signal?: AbortSignal,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Blob> {
  if (kind !== 'heap' && kind !== 'allocs') throw new CoreProfileError('invalid')
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, options.timeoutMs ?? 15000)
  const maxBytes = options.maxBytes ?? MAX_BYTES
  try {
    controller.signal.throwIfAborted()
    const response = await (options.fetch ?? fetch)(`${backend.url.replace(/\/+$/, '')}/debug/pprof/${kind}`, {
      method: 'GET',
      headers: backend.secret ? { Authorization: `Bearer ${backend.secret}` } : {},
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new CoreProfileError(response.status === 404 || response.status === 405 ? 'unsupported'
        : response.status === 401 || response.status === 403 ? 'unauthorized' : 'http')
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel()
      throw new CoreProfileError('tooLarge')
    }
    if (!response.body) throw new CoreProfileError('invalid')
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    try {
      while (true) {
        controller.signal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) throw new CoreProfileError('tooLarge')
        chunks.push(new Uint8Array(value))
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    controller.signal.throwIfAborted()
    const blob = new Blob(chunks, { type: 'application/octet-stream' })
    const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer())
    // Go's pprof binary output is gzip-compressed. Reject HTML/JSON fallback pages.
    if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8) throw new CoreProfileError('invalid')
    return blob
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (timedOut) throw new CoreProfileError('timeout')
    if (error instanceof CoreProfileError) throw error
    throw new CoreProfileError('network')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export function coreProfileFilename(kind: CoreProfile, date = new Date()): string {
  return `mihomo-${kind}-${date.toISOString().replace(/[:.]/g, '-')}.pprof`
}
