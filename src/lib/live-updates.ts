import type { Connection } from './api'

export const LIVE_UPDATE_MODE_KEY = 'miboard.live-update-mode'
export type LiveUpdateMode = 'realtime' | 'eco'

export function validLiveUpdateMode(value: unknown): value is LiveUpdateMode {
  return value === 'realtime' || value === 'eco'
}

export function readLiveUpdateMode(): LiveUpdateMode {
  try {
    const value = localStorage.getItem(LIVE_UPDATE_MODE_KEY)
    return validLiveUpdateMode(value) ? value : 'realtime'
  } catch { return 'realtime' }
}

export function saveLiveUpdateMode(value: LiveUpdateMode): boolean {
  if (!validLiveUpdateMode(value)) return false
  try { localStorage.setItem(LIVE_UPDATE_MODE_KEY, value); return true } catch { return false }
}

const counter = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0

/** Rates use observed elapsed time; the first frame after a gap is only a baseline. */
export class ConnectionRates {
  #previous = new Map<string, { upload: number; download: number }>()
  #time: number | null = null

  reset(): void { this.#previous.clear(); this.#time = null }

  sample(connections: readonly Connection[], now = Date.now()): Array<Connection & { ul: number; dl: number }> {
    const elapsed = this.#time === null ? 0 : (now - this.#time) / 1000
    const usable = Number.isFinite(elapsed) && elapsed > 0 && elapsed <= 15
    const next = new Map<string, { upload: number; download: number }>()
    const rows = connections.map(connection => {
      const key = JSON.stringify([connection.id, connection.start])
      const previous = this.#previous.get(key)
      const upload = counter(connection.upload), download = counter(connection.download)
      next.set(key, { upload, download })
      return {
        ...connection,
        ul: previous && usable ? Math.max(0, upload - previous.upload) / elapsed : 0,
        dl: previous && usable ? Math.max(0, download - previous.download) / elapsed : 0,
      }
    })
    this.#previous = next
    this.#time = Number.isFinite(now) ? now : null
    return rows
  }
}
