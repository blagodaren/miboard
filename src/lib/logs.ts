export type LogLevel = 'debug' | 'info' | 'warning' | 'error'
export type LogField = { key: string; value: string }
export type NormalizedLog = {
  level: string
  message: string
  coreTime: string | null
  receivedAt: number
  fields: LogField[]
  format: 'structured' | 'legacy'
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function displayValue(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return null }
  }
  return null
}

function fieldsOf(value: unknown): LogField[] {
  const entries = Array.isArray(value) ? value : record(value) ? Object.entries(value).map(([key, value]) => ({ key, value })) : []
  return entries.flatMap(field => {
    if (!record(field) || typeof field.key !== 'string' || !field.key.trim() || !Object.hasOwn(field, 'value')) return []
    const value = displayValue(field.value)
    return value === null ? [] : [{ key: field.key, value }]
  })
}

/** Time-only values belong to the core's clock; do not invent a date or time zone. */
function coreTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/.test(value)) return value
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return value
  return null
}

export function normalizeLog(value: unknown, receivedAt = Date.now()): NormalizedLog | null {
  if (!record(value)) return null
  if (typeof value.level === 'string' && typeof value.message === 'string') {
    return {
      level: value.level.toLowerCase() === 'warn' ? 'warning' : value.level.toLowerCase(),
      message: value.message,
      coreTime: coreTime(value.time),
      receivedAt,
      fields: fieldsOf(value.fields),
      format: 'structured',
    }
  }
  if (typeof value.type === 'string' && typeof value.payload === 'string') {
    return { level: value.type.toLowerCase() === 'warn' ? 'warning' : value.type.toLowerCase(), message: value.payload, coreTime: null, receivedAt, fields: [], format: 'legacy' }
  }
  return null
}

export function matchesLog(log: NormalizedLog, query: string, field = ''): boolean {
  const q = query.trim().toLowerCase()
  if (field) return log.fields.some(item => item.key === field && (!q || item.value.toLowerCase().includes(q)))
  return !q || log.message.toLowerCase().includes(q) || log.fields.some(item => item.key.toLowerCase().includes(q) || item.value.toLowerCase().includes(q))
}

type StreamOptions = {
  query: Record<string, string | number>
  onState: (open: boolean) => void
  onFailure: () => void
}
export type LogStream = (path: string, onData: (value: unknown) => void, options: StreamOptions) => () => void

/** Older cores can ignore format or reject the connection. Downgrade at most once. */
export function subscribeLogs(open: LogStream, level: LogLevel, onData: (value: NormalizedLog) => void, onState: (open: boolean) => void = () => {}) {
  let stopped = false
  let generation = 0
  let stop: (() => void) | undefined
  let accepted = false
  let fallbackPending = false

  const connect = (structured: boolean) => {
    const current = ++generation
    stop = open('/logs', value => {
      if (stopped || generation !== current) return
      const line = normalizeLog(value)
      if (!line) return
      accepted = true
      onData(line)
    }, {
      query: structured ? { level, format: 'structured' } : { level },
      onState: state => { if (!stopped && generation === current) onState(state) },
      onFailure: () => {
        if (stopped || generation !== current || !structured || accepted || fallbackPending) return
        fallbackPending = true
        // Construction failures can occur before open() returns its disposer.
        queueMicrotask(() => {
          if (stopped || generation !== current) return
          ++generation
          stop?.()
          onState(false)
          connect(false)
        })
      },
    })
  }
  connect(true)
  return () => { stopped = true; ++generation; stop?.() }
}
