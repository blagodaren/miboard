export type AppVersion = { version: string; buildId: string }
export type AppRelease = { version: string; url: string }
export const RELEASE_API_URL = 'https://api.github.com/repos/blagodaren/miboard/releases/latest'
export const RELEASE_CACHE_MS = 6 * 60 * 60 * 1000
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000

export class VersionRequestError extends Error {
  readonly status: number
  readonly rateLimited: boolean
  constructor(status: number, remaining?: string | null) {
    super(`Version request failed (${status})`)
    this.name = 'VersionRequestError'
    this.status = status
    this.rateLimited = status === 429 || (status === 403 && remaining === '0')
  }
}

type SemVer = { version: string; numbers: string[]; prerelease: string[] }
const numeric = /^(0|[1-9]\d*)$/

/** Keep numeric identifiers as strings: valid SemVer integers can exceed JS's safe range. */
export function parseAppVersion(value: unknown): SemVer | null {
  if (typeof value !== 'string' || value.length > 256) return null
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) return null
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && !numeric.test(part))) return null
  return { version: value.replace(/^v/, ''), numbers: match.slice(1, 4), prerelease }
}

function compareNumeric(a: string, b: string): -1 | 0 | 1 {
  return a.length !== b.length ? a.length < b.length ? -1 : 1 : a === b ? 0 : a < b ? -1 : 1
}

export function compareAppVersions(left: unknown, right: unknown): -1 | 0 | 1 | null {
  const a = parseAppVersion(left), b = parseAppVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index++) {
    const result = compareNumeric(a.numbers[index], b.numbers[index])
    if (result) return result
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const first = a.prerelease[index], second = b.prerelease[index]
    if (first === undefined || second === undefined) return first === undefined ? -1 : 1
    if (first === second) continue
    const firstNumeric = numeric.test(first), secondNumeric = numeric.test(second)
    if (firstNumeric && secondNumeric) return compareNumeric(first, second)
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1
    return first < second ? -1 : 1
  }
  return 0
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseDeployment(value: unknown): AppVersion | null {
  if (!record(value)) return null
  const parsed = parseAppVersion(value.version)
  if (!parsed || typeof value.buildId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.buildId)) return null
  return { version: parsed.version, buildId: value.buildId }
}

/** Only a published stable release from our exact repository is a trusted update link. */
export function parseAppRelease(value: unknown): AppRelease | null {
  if (!record(value) || value.draft !== false || value.prerelease !== false) return null
  const parsed = parseAppVersion(value.tag_name)
  if (!parsed || parsed.prerelease.length || typeof value.html_url !== 'string') return null
  try {
    const url = new URL(value.html_url)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return null
    const prefix = '/blagodaren/miboard/releases/tag/'
    if (!url.pathname.startsWith(prefix) || decodeURIComponent(url.pathname.slice(prefix.length)) !== value.tag_name) return null
    return { version: parsed.version, url: `https://github.com${prefix}${encodeURIComponent(value.tag_name as string)}` }
  } catch { return null }
}

export function parseReleaseCache(value: unknown, now: number): AppRelease | null {
  if (!record(value) || typeof value.checkedAt !== 'number' || !Number.isFinite(value.checkedAt) || value.checkedAt > now || now - value.checkedAt >= RELEASE_CACHE_MS) return null
  return parseAppRelease(value.release)
}

export function canUpdateTo(current: AppVersion, candidate: AppVersion): boolean {
  const order = compareAppVersions(candidate.version, current.version)
  return order !== null && order >= 0 && (order > 0 || candidate.buildId !== current.buildId)
}

/** The deadline includes reading the response body and works even if a test/host ignores abort. */
export async function fetchVersionJson(url: URL | string, options: {
  fetcher?: typeof fetch; timeout?: number; signal?: AbortSignal; credentials?: RequestCredentials
} = {}): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let removeAbort = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    const abort = () => { controller.abort(); reject(new Error('Version request cancelled')) }
    removeAbort = () => options.signal?.removeEventListener('abort', abort)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new Error('Version request timed out')) }, options.timeout ?? 10000)
  })
  try {
    if (options.signal?.aborted) return await cancelled
    const result = (async () => {
      const response = await (options.fetcher ?? fetch)(url, {
        cache: 'no-store', credentials: options.credentials ?? 'omit', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      })
      if (!response.ok) throw new VersionRequestError(response.status, response.headers?.get?.('x-ratelimit-remaining'))
      return response.json() as Promise<unknown>
    })()
    return await Promise.race([result, cancelled])
  } finally { clearTimeout(timer); removeAbort() }
}

export async function withVersionDeadline<T>(operation: Promise<T>, timeout = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Version operation timed out')), timeout)
    })])
  } finally { clearTimeout(timer) }
}

export function readWorkerVersion(worker: Pick<ServiceWorker, 'postMessage'>, timeout = 3000): Promise<AppVersion> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const cleanup = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close() }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker version timed out')) }, timeout)
    channel.port1.onmessage = (event) => {
      const version = parseDeployment(event.data)
      cleanup()
      if (version) resolve(version)
      else reject(new Error('Invalid worker version'))
    }
    channel.port1.onmessageerror = () => { cleanup(); reject(new Error('Unreadable worker version')) }
    try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]) }
    catch (error) { cleanup(); reject(error) }
  })
}
