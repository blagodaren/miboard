/** Only observations from the current controller session are retained. */
export const TRAFFIC_HISTORY_SECONDS = 24 * 60 * 60
export const TRAFFIC_HISTORY_LIMIT = TRAFFIC_HISTORY_SECONDS + 2
const MAX_SAMPLE_GAP = 5

type Sample = { from: number; to: number; down: number; up: number }
export type TrafficSnapshot = {
  t: number[]
  down: (number | null)[]
  up: (number | null)[]
  download: number
  upload: number
  startedAt: number | null
}

const rate = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0

/** The stream reports bytes/s. Integrate actual sample intervals, never a disconnected gap. */
export class TrafficHistory {
  #samples: Sample[] = []
  #head = 0
  #previous: number | null = null
  #latest: number | null = null

  get size(): number { return this.#samples.length - this.#head }

  append(time: number, down: number, up: number): void {
    if (!Number.isFinite(time) || (this.#latest !== null && time <= this.#latest)) return
    const previous = this.#previous
    const from = previous !== null && time - previous <= MAX_SAMPLE_GAP ? previous : time
    this.#samples.push({ from, to: time, down: rate(down), up: rate(up) })
    this.#previous = time
    this.#latest = time

    const cutoff = time - TRAFFIC_HISTORY_SECONDS
    while (this.#head < this.#samples.length && (
      this.#samples[this.#head].to < cutoff || this.size > TRAFFIC_HISTORY_LIMIT
    )) this.#head++
    // Compact infrequently; per-second ingestion never shifts a day of samples.
    if (this.#head >= 4096) {
      this.#samples = this.#samples.slice(this.#head)
      this.#head = 0
    }
  }

  pause(): void { this.#previous = null }

  reset(): void {
    this.#samples = []
    this.#head = 0
    this.#previous = null
    this.#latest = null
  }

  snapshot(seconds: number, now = this.#latest ?? 0): TrafficSnapshot {
    const empty: TrafficSnapshot = { t: [], down: [], up: [], download: 0, upload: 0, startedAt: null }
    if (this.#latest === null || !Number.isFinite(now)) return empty
    const range = Number.isFinite(seconds) ? Math.max(1, Math.min(seconds, TRAFFIC_HISTORY_SECONDS)) : 1800
    const cutoff = now - range
    const step = range <= 1800 ? 5 : range <= 3600 ? 10 : 60
    const bins = new Map<number, { duration: number; down: number; up: number; last: number; initialDown: number; initialUp: number }>()
    let download = 0
    let upload = 0
    let startedAt: number | null = null

    // Binary search makes the 30-minute view independent of a full day's buffer size.
    let low = this.#head
    let high = this.#samples.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.#samples[middle].to < cutoff) low = middle + 1
      else high = middle
    }
    for (let index = low; index < this.#samples.length; index++) {
      const sample = this.#samples[index]
      if (sample.from > now) break
      const from = Math.max(cutoff, sample.from)
      const to = Math.min(now, sample.to)
      if (to < from) continue
      startedAt ??= from
      download += (to - from) * sample.down
      upload += (to - from) * sample.up

      let cursor = from
      do {
        const bucket = Math.floor(cursor / step)
        const end = Math.min(to, (bucket + 1) * step)
        const bin = bins.get(bucket) ?? { duration: 0, down: 0, up: 0, last: end, initialDown: sample.down, initialUp: sample.up }
        bin.duration += end - cursor
        bin.down += (end - cursor) * sample.down
        bin.up += (end - cursor) * sample.up
        bin.last = end
        bins.set(bucket, bin)
        cursor = end
      } while (cursor < to)
    }
    const result = { ...empty, download, upload, startedAt }
    let previousBucket: number | null = null
    for (const [bucket, bin] of bins) {
      if (previousBucket !== null && bucket > previousBucket + 1) {
        // A missing observation is a break in the line, not a recorded zero.
        result.t.push((result.t[result.t.length - 1] + bin.last) / 2)
        result.down.push(null)
        result.up.push(null)
      }
      result.t.push(bin.last)
      result.down.push(bin.duration ? bin.down / bin.duration : bin.initialDown)
      result.up.push(bin.duration ? bin.up / bin.duration : bin.initialUp)
      previousBucket = bucket
    }
    return result
  }
}
