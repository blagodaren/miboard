export type RuleProviderBatchOutcome = {
  succeeded: string[]
  failed: Array<{ name: string; error: unknown }>
  interrupted: string[]
  pending: string[]
  cancelled: boolean
}

/** Keep unfinished work across separate jobs, excluding only confirmed outcomes. */
export function remainingRuleProviderNames(previous: readonly string[], outcome: RuleProviderBatchOutcome): string[] {
  const settled = new Set([...outcome.succeeded, ...outcome.failed.map(item => item.name)])
  const candidates = outcome.cancelled ? [...previous, ...outcome.interrupted, ...outcome.pending] : previous
  return [...new Set(candidates)].filter(name => !settled.has(name))
}

type RuleProviderBatchOptions = {
  signal: AbortSignal
  update: (name: string, signal: AbortSignal) => Promise<void>
  onStart?: (name: string) => void
  onProgress?: (snapshot: RuleProviderBatchOutcome) => void
}

/** Abort leaves queued work pending and treats unfinished requests as unknown server state. */
export async function runRuleProviderBatch(
  names: readonly string[],
  options: RuleProviderBatchOptions,
): Promise<RuleProviderBatchOutcome> {
  const queue = [...new Set(names)]
  const succeeded = new Set<string>()
  const failed = new Map<string, unknown>()
  const interrupted = new Set<string>()
  let next = 0

  const snapshot = (): RuleProviderBatchOutcome => ({
    succeeded: queue.filter(name => succeeded.has(name)),
    failed: queue.filter(name => failed.has(name)).map(name => ({ name, error: failed.get(name) })),
    interrupted: queue.filter(name => interrupted.has(name)),
    pending: queue.slice(next),
    cancelled: options.signal.aborted,
  })

  options.onProgress?.(snapshot())

  async function worker() {
    while (!options.signal.aborted && next < queue.length) {
      const name = queue[next++]
      options.onStart?.(name)
      // A synchronous onStart cancellation leaves this request undispatched.
      if (options.signal.aborted) { next--; break }
      try {
        await options.update(name, options.signal)
        if (options.signal.aborted) interrupted.add(name)
        else succeeded.add(name)
      } catch (error) {
        if (options.signal.aborted) interrupted.add(name)
        else failed.set(name, error)
      }
      options.onProgress?.(snapshot())
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()))
  return snapshot()
}
