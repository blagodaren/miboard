export type SiteTarget = { name: string; provider?: string }
export type SiteCell = { url: string; target: SiteTarget; state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'; delay?: number; error?: unknown }
export const SITE_URL_LIMIT = 5
export const SITE_NODE_LIMIT = 20
export function parseSiteUrls(input: string): string[] {
  const lines = input.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  if (!lines.length || lines.length > SITE_URL_LIMIT) throw new Error('urls')
  return [...new Set(lines.map(value => {
    if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value) || !/^https?:\/\//i.test(value)) throw new Error('urls')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('urls')
    url.hash = ''
    return url.href
  }))]
}
export const siteTargetKey = (target: SiteTarget) => JSON.stringify([target.provider ?? null, target.name])
export function siteCheckPath(target: SiteTarget): string {
  return target.provider ? `/providers/proxies/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.name)}/healthcheck` : `/proxies/${encodeURIComponent(target.name)}/delay`
}
export async function runSiteChecks(urls: string[], targets: SiteTarget[], timeout: number, check: (target: SiteTarget, url: string, timeout: number, signal: AbortSignal) => Promise<{ delay: number }>, signal: AbortSignal, update: (cells: SiteCell[]) => void, concurrency = 3): Promise<SiteCell[]> {
  if (!urls.length || urls.length > SITE_URL_LIMIT || !targets.length || targets.length > SITE_NODE_LIMIT || !Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('limits')
  const cells: SiteCell[] = urls.flatMap(url => targets.map(target => ({ url, target: { ...target }, state: 'pending' })))
  let cursor = 0
  const publish = () => update(cells.map(cell => ({ ...cell })))
  publish()
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(concurrency) || 1), 3, cells.length) }, async () => {
    while (!signal.aborted && cursor < cells.length) {
      const index = cursor++
      cells[index] = { ...cells[index], state: 'running' }; publish()
      try {
        const result = await check(cells[index].target, cells[index].url, timeout, signal)
        signal.throwIfAborted()
        if (!Number.isFinite(result?.delay) || result.delay <= 0) throw new Error('delay')
        cells[index] = { ...cells[index], state: 'done', delay: result.delay }
      } catch (error) { cells[index] = { ...cells[index], state: signal.aborted ? 'cancelled' : 'failed', error } }
      publish()
    }
  }))
  for (let i = 0; i < cells.length; i++) if (cells[i].state === 'pending') cells[i] = { ...cells[i], state: 'cancelled' }
  publish()
  return cells
}
