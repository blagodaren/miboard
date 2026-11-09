<script lang="ts">
  import uPlot from 'uplot'
  import { onMount, untrack } from 'svelte'
  import { core } from '../lib/core.svelte'
  import { speed } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import type { TrafficSnapshot } from '../lib/traffic-history'

  let { height = 300, range = 1800 }: { height?: number; range?: number } = $props()
  let el: HTMLDivElement
  let plot: uPlot | null = null
  let data = $state.raw<TrafficSnapshot>({ t: [], down: [], up: [], download: 0, upload: 0, startedAt: null })
  let selected = $state<{ time: number; down: number; up: number; x: number } | null>(null)
  const tooltipId = $props.id()

  function css(name: string): string {
    if (!getComputedStyle(el).getPropertyValue(name).trim()) return ''
    // Canvas strokeStyle does not resolve raw light-dark() custom properties.
    const probe = document.createElement('span')
    probe.style.display = 'none'
    probe.style.color = `var(${name})`
    el.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }
  const timeLabel = (time: number) => new Date(time * 1000).toLocaleTimeString(i18n.intlLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  function showCursor(chart: uPlot) {
    const index = chart.cursor.idx
    if (index === null || index === undefined || chart.cursor.left === undefined || chart.cursor.left < 0 || !Number.isFinite(data.t[index]) || data.down[index] === null) {
      selected = null
      return
    }
    selected = {
      time: data.t[index], down: data.down[index] ?? 0, up: data.up[index] ?? 0,
      x: Math.max(8, Math.min(el.clientWidth - 200, chart.cursor.left + chart.bbox.left / devicePixelRatio + 12)),
    }
  }

  function refresh() {
    data = core.trafficHistory.snapshot(range)
    plot?.setData([data.t, data.down, data.up])
    if (plot) showCursor(plot)
  }

  function build() {
    plot?.destroy()
    selected = null
    data = core.trafficHistory.snapshot(range)
    const down = css('--traffic-down') || css('--accent')
    const up = css('--traffic-up') || css('--text-3')
    const axis = {
      stroke: css('--text-3'),
      font: '11px "Geist Mono", ui-monospace, monospace',
      grid: { stroke: css('--line'), width: 1, dash: [3, 4] },
      ticks: { show: false },
    }
    plot = new uPlot(
      {
        width: Math.max(1, el.clientWidth),
        height,
        padding: [12, 6, 0, 0],
        cursor: { points: { size: 5 }, drag: { x: false, y: false } },
        legend: { show: false },
        scales: {
          x: { time: true, range: () => {
            const start = data.t[0] ?? Date.now() / 1000
            if (data.t.length === 1) return [start - 1, start + 1]
            return [start, Math.max(data.t[data.t.length - 1] ?? start, start + 1)]
          } },
          y: { range: (_u, _min, max) => [0, Math.max((max ?? 0) * 1.15, 32 * 1024)] },
        },
        axes: [
          { ...axis, grid: { show: false }, size: 32, space: 76,
            incrs: [1, 2, 5, 10, 15, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 86400],
            values: (_u, ts) => {
              const seconds = (data.t[data.t.length - 1] ?? 0) - (data.t[0] ?? 0) < 600
              return ts.map((time) => new Date(time * 1000).toLocaleTimeString(i18n.intlLocale, {
                hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } as const : {}),
              }))
          } },
          { ...axis, size: el.clientWidth < 500 ? 64 : 76, space: 48, values: (_u, vs) => vs.map((v) => speed(v)) },
        ],
        series: [
          {},
          { label: t('chart.download'), stroke: down, width: 1.7, fill: `color-mix(in srgb, ${down} 7%, transparent)`, points: { show: () => data.t.length === 1, size: 5, fill: down, stroke: down }, spanGaps: false },
          { label: t('chart.upload'), stroke: up, width: 1.7, dash: [5, 4], points: { show: () => data.t.length === 1, size: 5, fill: up, stroke: up }, spanGaps: false },
        ],
        hooks: { setCursor: [showCursor] },
      },
      [data.t, data.down, data.up],
      el,
    )
  }

  function keyboard(event: KeyboardEvent) {
    if (!plot || !data.t.length) return
    if (event.key === 'Escape') {
      selected = null
      plot.setCursor({ left: -10, top: -10 })
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    let index = selected ? data.t.indexOf(selected.time) : -1
    const direction = event.key === 'ArrowLeft' || event.key === 'End' ? -1 : 1
    if (event.key === 'Home') index = 0
    else if (event.key === 'End' || index === -1) index = data.t.length - 1
    else index = Math.max(0, Math.min(data.t.length - 1, index + direction))
    while (data.down[index] === null && index >= 0 && index < data.t.length) index += direction
    if (index < 0 || index >= data.t.length) return
    plot.setCursor({ left: plot.valToPos(data.t[index], 'x'), top: 1 })
  }

  onMount(() => {
    build()
    const ro = new ResizeObserver(() => plot?.setSize({ width: Math.max(1, el.clientWidth), height }))
    ro.observe(el)
    const mo = new MutationObserver(build)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', build)
    return () => {
      ro.disconnect()
      mo.disconnect()
      mq.removeEventListener('change', build)
      plot?.destroy()
      plot = null
    }
  })

  $effect(() => {
    void core.tick
    void range
    if (plot) untrack(refresh)
  })

  $effect(() => {
    void i18n.locale
    if (plot) untrack(build)
  })
</script>

<div class="traffic-chart" role="slider" aria-label={t('chart.label')} aria-valuemin={0} aria-valuemax={Math.max(0, data.t.length - 1)} aria-valuenow={selected ? Math.max(0, data.t.indexOf(selected.time)) : 0} aria-valuetext={selected ? `${timeLabel(selected.time)} · ${t('chart.download')} ${speed(selected.down)} · ${t('chart.upload')} ${speed(selected.up)}` : undefined} aria-describedby={selected ? tooltipId : undefined} tabindex="0" onkeydown={keyboard} onblur={() => { selected = null }}>
  <div bind:this={el} class="w-full" style:height="{height}px"></div>
  {#if selected}
    <div id={tooltipId} class="traffic-tooltip" style:left="{selected.x}px" role="status">
      <div class="tooltip-time">{timeLabel(selected.time)}</div>
      <div><span class="download">{t('chart.download')}</span><strong>{speed(selected.down)}</strong></div>
      <div><span class="upload">{t('chart.upload')}</span><strong>{speed(selected.up)}</strong></div>
    </div>
  {/if}
</div>

<style>
  .traffic-chart { position: relative; min-width: 0; }
  .traffic-tooltip {
    position: absolute; z-index: 2; top: 16px; width: 188px; padding: 12px;
    border: 1px solid var(--line); border-radius: var(--radius-control);
    background: var(--card); box-shadow: var(--shadow-float); pointer-events: none;
    font-size: 12px; line-height: 20px; font-variant-numeric: tabular-nums;
  }
  .traffic-tooltip > div { display: flex; justify-content: space-between; gap: 12px; }
  .traffic-tooltip .tooltip-time { margin-bottom: 4px; color: var(--text-2); }
  .traffic-tooltip strong { font-weight: 500; }
  .download { color: var(--traffic-down-ink); }
  .upload { color: var(--traffic-up-ink); }
</style>
