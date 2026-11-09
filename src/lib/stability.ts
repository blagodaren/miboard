import type { DelayTarget } from './latency'

export const STABILITY_ATTEMPTS = 10
export type StabilitySample = { attempt: number; delay: number | null }
export type StabilityStats = {
  completed: number
  successful: number
  failed: number
  median: number | null
  p95: number | null
  min: number | null
  max: number | null
}

export function summarizeStability(samples: readonly StabilitySample[]): StabilityStats {
  const values = samples.flatMap(({ delay }) => typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? [delay] : []).sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return {
    completed: samples.length,
    successful: values.length,
    failed: samples.length - values.length,
    median: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null,
    p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    min: values[0] ?? null,
    max: values.at(-1) ?? null,
  }
}

/** A manual series keeps one request in flight and never counts cancellation as failure. */
export async function runStabilitySeries(
  target: DelayTarget,
  settings: { url: string; timeout: number },
  measure: (target: DelayTarget, url: string, timeout: number, signal: AbortSignal) => Promise<{ delay: number }>,
  signal: AbortSignal,
  onProgress: (samples: readonly StabilitySample[]) => void,
): Promise<{ samples: StabilitySample[]; cancelled: boolean }> {
  const endpoint = { name: target.name, ...(target.provider ? { provider: target.provider } : {}) }
  const { url, timeout } = settings
  const samples: StabilitySample[] = []
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS && !signal.aborted; attempt++) {
    let delay: number | null = null
    try {
      const result = await measure(endpoint, url, timeout, signal)
      if (Number.isFinite(result.delay) && result.delay > 0) delay = result.delay
    } catch {
      // An HTTP error contributes one failed check; user cancellation does not.
    }
    if (signal.aborted) break
    samples.push({ attempt, delay })
    onProgress(samples.map((sample) => ({ ...sample })))
  }
  return { samples, cancelled: signal.aborted }
}
