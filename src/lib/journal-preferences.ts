export type JournalRetention = 'off' | '1h' | '24h' | '7d'
export const JOURNAL_RETENTION_PREFIX = 'miboard.journal-retention.v1.'
export const journalRetentionKey = (url: string) => JOURNAL_RETENTION_PREFIX + encodeURIComponent(url)
export const validJournalRetention = (value: unknown): value is JournalRetention => value === 'off' || value === '1h' || value === '24h' || value === '7d'

export function readJournalRetention(url: string): JournalRetention | null {
  try {
    const value = localStorage.getItem(journalRetentionKey(url))
    return validJournalRetention(value) ? value : null
  } catch { return null }
}

export function saveJournalRetention(url: string, retention: JournalRetention): boolean {
  try { localStorage.setItem(journalRetentionKey(url), retention); return true }
  catch { return false }
}

/** Migrate legacy per-core preferences only; never export connection history. */
export async function prepareJournalPreferences(backendUrl?: string): Promise<boolean> {
  if (backendUrl && readJournalRetention(backendUrl) !== null) return true
  if (typeof indexedDB === 'undefined') return false
  let database: IDBDatabase | undefined
  try {
    database = await new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false
      const request = indexedDB.open('miboard-connection-journal-v1', 1)
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('backends')) request.result.createObjectStore('backends') }
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result) }
      request.onerror = () => reject(request.error)
      request.onblocked = () => { blocked = true; reject(new Error('Journal preferences unavailable')) }
    })
    const preferences = await new Promise<Map<string, JournalRetention>>((resolve, reject) => {
      // A successful scoped read with no record means the default, not an
      // unreadable legacy value. Do not guess this default on storage failure.
      const preferences = new Map<string, JournalRetention>(backendUrl ? [[backendUrl, '24h']] : [])
      const transaction = database!.transaction('backends', 'readonly')
      transaction.oncomplete = () => resolve(preferences)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
      const request = transaction.objectStore('backends').openCursor(backendUrl)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const value: unknown = cursor.value
        if (typeof cursor.key === 'string' && value && typeof value === 'object' && 'retention' in value && validJournalRetention(value.retention)) {
          preferences.set(cursor.key, value.retention)
        }
        cursor.continue()
      }
    })
    // Recheck after the asynchronous read: an import or user change always wins.
    for (const [url, retention] of preferences) {
      if (readJournalRetention(url) === null && !saveJournalRetention(url, retention)) return false
    }
    return true
  } catch { return false }
  finally { database?.close() }
}
