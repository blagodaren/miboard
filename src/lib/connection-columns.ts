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
