export type ProxyGroupBatchResult = {
  /** Every settled group, including failed groups. */
  completed: number
  failed: number
  /** Errors in the original group order, independent of completion order. */
  errors: unknown[]
  cancelled: boolean
}

export type ProxyGroupBatchOptions = { concurrency?: number; signal?: AbortSignal }

/**
 * Schedule a snapshot of groups without letting one failed test stop the rest.
 * Abort stops queued work; the caller is responsible for cancelling active requests.
 */
export async function runProxyGroupBatch<T>(
  groups: readonly T[],
  run: (group: T) => Promise<void>,
  onProgress: (done: number, total: number) => void,
  options: ProxyGroupBatchOptions = {},
): Promise<ProxyGroupBatchResult> {
  const queue = [...groups]
  const total = queue.length
  const concurrency = Number.isInteger(options.concurrency) && (options.concurrency ?? 0) > 0
    ? options.concurrency! : 2
  const failures = new Map<number, unknown>()
  let next = 0
  let completed = 0

  onProgress(0, total)

  async function worker(): Promise<void> {
    while (!options.signal?.aborted && next < total) {
      // Claim synchronously before awaiting so workers cannot start the same group.
      const index = next++
      try {
        await run(queue[index])
      } catch (error) {
        failures.set(index, error)
      }
      completed++
      onProgress(completed, total)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
  return {
    completed,
    failed: failures.size,
    errors: [...failures].sort(([a], [b]) => a - b).map(([, error]) => error),
    cancelled: options.signal?.aborted ?? false,
  }
}
