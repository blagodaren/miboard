import { HistoryAccumulator, HISTORY_GAP, HISTORY_RETENTION, leaseAvailable, mergeHistoryBucket, type HistoryBucket, type HistoryLease } from './long-history'
import type { Connection } from './api'

type StoredBucket = HistoryBucket & { backend: string }
type StoredLease = HistoryLease & { backend: string }
export function historyRandomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}
export class HistoryDatabase {
  #promise: Promise<IDBDatabase> | null = null
  open(): Promise<IDBDatabase> {
    return this.#promise ??= new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
      const request = indexedDB.open('miboard-long-history', 1)
      request.onupgradeneeded = () => {
        const db = request.result
        const buckets = db.createObjectStore('hours', { keyPath: ['backend', 'hour'] })
        buckets.createIndex('hour', 'hour')
        db.createObjectStore('leases', { keyPath: 'backend' })
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('IndexedDB blocked'))
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    })
  }
  async read(backend: string, now = Date.now()): Promise<HistoryBucket[]> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('hours', 'readonly')
      const request = tx.objectStore('hours').getAll(IDBKeyRange.bound([backend, Math.max(0, now - HISTORY_RETENTION)], [backend, now]))
      request.onsuccess = () => resolve((request.result as StoredBucket[]).map(({ backend: _, ...row }) => row))
      request.onerror = () => reject(request.error)
    })
  }
  async observe(backend: string, owner: string, accumulator: HistoryAccumulator, connections: readonly Connection[], now: number, current: () => boolean): Promise<{ leader: boolean; buckets: HistoryBucket[] }> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['leases', 'hours'], 'readwrite')
      const leaseStore = tx.objectStore('leases'), hours = tx.objectStore('hours')
      const request = leaseStore.get(backend)
      const changed: HistoryBucket[] = []
      let leader = false
      tx.oncomplete = () => resolve({ leader, buckets: changed })
      tx.onerror = tx.onabort = () => { accumulator.reset(); reject(tx.error ?? new Error('History write failed')) }
      request.onsuccess = () => {
        if (!current()) return
        const previous = request.result as StoredLease | undefined
        if (!leaseAvailable(previous, owner, now)) { accumulator.reset(); return }
        leader = true
        if (previous?.owner !== owner || previous.until <= now) accumulator.reset()
        leaseStore.put({ backend, owner, until: now + HISTORY_GAP } satisfies StoredLease)
        for (const delta of accumulator.observe(connections, now)) {
          const existing = hours.get([backend, delta.hour])
          existing.onsuccess = () => {
            const row = mergeHistoryBucket(existing.result, delta)
            hours.put({ ...row, backend }); changed.push(row)
          }
        }
      }
    })
  }
  async release(backend: string, owner: string): Promise<void> {
    if (!backend) return
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('leases', 'readwrite'), store = tx.objectStore('leases'), request = store.get(backend)
      request.onsuccess = () => { if (request.result?.owner === owner) store.delete(backend) }
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error)
    })
  }
  async prune(now = Date.now()): Promise<void> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('hours', 'readwrite')
      const cursor = tx.objectStore('hours').index('hour').openCursor(IDBKeyRange.upperBound(now - HISTORY_RETENTION, true))
      cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue() } }
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error)
    })
  }
}
