export const CONNECTION_COLUMNS_KEY = 'miboard.connection-columns.v1'
export const CONNECTION_COLUMN_OPTIONS = ['type', 'process', 'sniffHost', 'source', 'destination', 'inbound', 'dnsMode', 'provider', 'peakSpeed'] as const
export type ConnectionColumn = typeof CONNECTION_COLUMN_OPTIONS[number]
export const DEFAULT_CONNECTION_COLUMNS: readonly ConnectionColumn[] = ['type', 'source', 'destination', 'inbound']

export function validConnectionColumns(value: unknown): value is ConnectionColumn[] {
  return Array.isArray(value) && value.length <= CONNECTION_COLUMN_OPTIONS.length
    && new Set(value).size === value.length
    && value.every(column => typeof column === 'string' && CONNECTION_COLUMN_OPTIONS.includes(column as ConnectionColumn))
}

export function readConnectionColumns(): ConnectionColumn[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CONNECTION_COLUMNS_KEY) ?? 'null')
    if (validConnectionColumns(value)) return [...value]
  } catch { /* Column preferences are optional. */ }
  return [...DEFAULT_CONNECTION_COLUMNS]
}

export const CONNECTION_SORT_KEY = 'miboard.connection-sort.v1'
export const CONNECTION_SORT_KEYS = ['rate', 'total', 'start', 'host', 'type', 'process', 'sniffHost', 'source', 'destination', 'inbound', 'dnsMode', 'rule', 'chain', 'provider', 'peakSpeed'] as const
export type ConnectionSortKey = typeof CONNECTION_SORT_KEYS[number]
export type ConnectionSort = { key: ConnectionSortKey; direction: 'asc' | 'desc' }
type SortView = 'active' | 'closed'
const DEFAULT_SORT: Record<SortView, ConnectionSort> = { active: { key: 'rate', direction: 'desc' }, closed: { key: 'start', direction: 'desc' } }

function validSort(value: unknown): value is ConnectionSort {
  const sort = value as ConnectionSort | null
  return !!sort && typeof sort === 'object' && CONNECTION_SORT_KEYS.includes(sort.key) && (sort.direction === 'asc' || sort.direction === 'desc')
}

function readSorts(): Partial<Record<SortView, unknown>> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CONNECTION_SORT_KEY) ?? 'null')
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

/** Active and completed connections keep their own sort: speed means little for closed ones. */
export function readConnectionSort(view: SortView): ConnectionSort {
  const saved = readSorts()[view]
  return validSort(saved) ? { key: saved.key, direction: saved.direction } : { ...DEFAULT_SORT[view] }
}

export function saveConnectionSort(view: SortView, sort: ConnectionSort) {
  try { localStorage.setItem(CONNECTION_SORT_KEY, JSON.stringify({ ...readSorts(), [view]: sort })) } catch { /* Keep this session's sort. */ }
}
