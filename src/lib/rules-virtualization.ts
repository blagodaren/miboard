/** Prefix sums allow variable-height rows and an expanded detail row to share one scroll surface. */
export function ruleOffsets(heights: readonly number[]): number[] {
  const offsets = [0]
  for (const height of heights) offsets.push(offsets[offsets.length - 1] + (Number.isFinite(height) && height > 0 ? height : 1))
  return offsets
}

export function measuredRuleRange(offsets: readonly number[], scrollTop: number, viewport: number, overscan = 5) {
  const count = Math.max(0, offsets.length - 1)
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0
  const height = Number.isFinite(viewport) ? Math.max(1, viewport) : 1
  const extra = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 5
  function indexAt(position: number): number {
    let low = 0, high = count
    while (low < high) { const middle = (low + high) >>> 1; if (offsets[middle + 1] <= position) low = middle + 1; else high = middle }
    return Math.min(Math.max(0, count - 1), low)
  }
  const start = Math.max(0, indexAt(top) - extra)
  const end = count ? Math.min(count, indexAt(top + height) + extra + 1) : 0
  return { start, end, top: offsets[start] ?? 0, bottom: Math.max(0, (offsets[count] ?? 0) - (offsets[end] ?? 0)) }
}

/** Keep an expanded/focused row mounted without rendering the gap between it and the viewport. */
export function pinnedRuleIndices(start: number, end: number, count: number, pinned: readonly number[] = []): number[] {
  const rows = new Set<number>()
  for (let index = Math.max(0, start); index < Math.min(count, end); index++) rows.add(index)
  for (const index of pinned) if (Number.isInteger(index) && index >= 0 && index < count) rows.add(index)
  return [...rows].sort((a, b) => a - b)
}
