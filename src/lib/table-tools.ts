import type { Connection } from './api'

export type ConnectionFilter = 'all' | 'device' | 'domain' | 'node'
const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, '')
export function matchesConnectionScope(connection: Connection, scope: ConnectionFilter, value: string): boolean {
  if (scope === 'all' || !value.trim()) return true
  if (scope === 'device') return connection.metadata.sourceIP?.replace(/^::ffff:/, '') === value.trim().replace(/^::ffff:/, '')
  if (scope === 'node') return connection.chains?.includes(value.trim()) ?? false
  return [connection.metadata.host, connection.metadata.sniffHost, connection.metadata.destinationIP].some(item => typeof item === 'string' && host(item) === host(value))
}

export type CloseBatchResult = { succeeded: string[]; failed: string[]; pending: string[] }
/** The caller captures IDs before confirmation and pins the controller for every request. */
export async function closeConnectionBatch(ids: readonly string[], close: (id: string, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, progress?: (done: number, total: number) => void): Promise<CloseBatchResult> {
  const queue = [...new Set(ids)]
  const result: CloseBatchResult = { succeeded: [], failed: [], pending: [] }
  let cursor = 0, done = 0
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (!signal.aborted) {
      const index = cursor++
      if (index >= queue.length) break
      const id = queue[index]
      try { await close(id, signal); result.succeeded.push(id) }
      catch (error) {
        if (signal.aborted) result.pending.push(id)
        else if (error && typeof error === 'object' && 'status' in error && error.status === 404) result.succeeded.push(id)
        else result.failed.push(id)
      }
      progress?.(++done, queue.length)
    }
  }))
  result.pending.push(...queue.slice(Math.min(cursor, queue.length)))
  return result
}

/** Spreadsheet formula neutralization applies even to whitespace-prefixed values. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[\s\uFEFF]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
export function csvDocument(headers: string[], rows: unknown[][]): string {
  return '\uFEFF' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
export function connectionsCsv(rows: readonly Connection[]): string {
  return csvDocument(['id', 'started_at', 'device_ip', 'domain', 'destination_ip', 'destination_port', 'network', 'process', 'rule', 'rule_payload', 'chain', 'upload_bytes', 'download_bytes'], rows.map(c => [c.id, c.start, c.metadata.sourceIP, c.metadata.host || c.metadata.sniffHost, c.metadata.destinationIP, c.metadata.destinationPort, c.metadata.network, c.metadata.process, c.rule, c.rulePayload, c.chains.join(' / '), c.upload, c.download]))
}
export function downloadText(name: string, data: string, type = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function virtualRange(count: number, scrollTop: number, height: number, rowHeight = 64, overscan = 6) {
  const first = Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan))
  const end = Math.min(count, first + Math.ceil(Math.max(1, height) / rowHeight) + overscan * 2)
  return { start: first, end, top: first * rowHeight, bottom: Math.max(0, (count - end) * rowHeight) }
}
