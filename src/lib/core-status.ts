export type MemorySample = { time: number; value: number | null }
export const MEMORY_WINDOW_MS = 5 * 60 * 1000

/** Missing/offline samples are gaps, never interpolated as zero memory. */
export function appendMemorySample(samples: MemorySample[], time: number, value: number | null): MemorySample[] {
  if (!Number.isFinite(time)) return samples
  const next = Number.isFinite(value) && value !== null && value >= 0 ? value : null
  return [...samples.filter(sample => sample.time > time - MEMORY_WINDOW_MS && sample.time < time), { time, value: next }].slice(-301)
}

export function memoryChart(samples: MemorySample[], width = 600, height = 120) {
  const values = samples.filter((sample): sample is MemorySample & { value: number } => sample.value !== null)
  const peak = Math.max(0, ...values.map(sample => sample.value))
  const maximum = peak > 0 ? peak * 1.15 : 1
  const end = samples.at(-1)?.time ?? 0
  const start = Math.min(samples[0]?.time ?? end, end - 1000)
  const paths: string[] = []
  let path = ''
  for (const sample of samples) {
    if (sample.value === null) { if (path) paths.push(path); path = ''; continue }
    const x = (sample.time - start) / (end - start) * width
    const y = height - sample.value / maximum * height
    path += `${path ? ' L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
  }
  if (path) paths.push(path)
  return { paths, peak, maximum, count: values.length, spanSeconds: Math.max(0, Math.round((end - (samples[0]?.time ?? end)) / 1000)) }
}

/** Config text can include user-controlled URLs; reveal neither embedded credentials nor query strings. */
export function visibleConfigUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) return ''
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol)) return '—'
    return url.origin + url.pathname
  } catch { return '—' }
}
