export type LatencyDistribution = {
  fast: number
  ok: number
  slow: number
  none: number
  total: number
}

/** Count the same delay bands shown on node cards; missing/failed results stay neutral. */
export function summarizeLatencyDistribution(
  values: readonly (number | undefined)[],
  yellow: number,
  red: number,
): LatencyDistribution {
  const result: LatencyDistribution = { fast: 0, ok: 0, slow: 0, none: 0, total: values.length }
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value) || value <= 0) result.none++
    else if (value < yellow) result.fast++
    else if (value < red) result.ok++
    else result.slow++
  }
  return result
}
