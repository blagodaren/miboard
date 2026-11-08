<script lang="ts">
  import { onMount } from 'svelte'
  import earth from '../lib/data/equal-earth.json'
  import { t } from '../lib/i18n.svelte'
  import { IconPlus, IconMinus, IconMove, IconArrowRight, IconGeography } from '../lib/icons'

  type Country = { code: string; name: string; value: number; count: number }
  type Props = {
    countries: Country[]
    selected: string | null
    onselect: (code: string | null) => void
    metricLabel: string
    formatValue: (value: number) => string
  }

  let { countries, selected, onselect, metricLabel, formatValue }: Props = $props()
  let hovered = $state<string | null>(null)
  const MIN_ZOOM = 1
  const MAX_ZOOM = 8
  const ZOOM_STEP = 1.5
  let zoom = $state(1)
  let offsetX = $state(0)
  let offsetY = $state(0)
  let dragging = $state(false)
  let panOpen = $state(false)
  let svg: SVGSVGElement
  let viewport: HTMLDivElement
  let panButton: HTMLButtonElement
  let gesture: { id: number; clientX: number; clientY: number; x: number; y: number; offsetX: number; offsetY: number } | null = null
  let suppressClick = false

  const byCode = $derived(new Map(countries.map((country) => [country.code, country])))
  const maximum = $derived(Math.max(0, ...countries.map((country) => country.value)))
  const active = $derived(earth.countries.filter((country) => byCode.has(country.code)))
  const detail = $derived(byCode.get(hovered ?? selected ?? ''))

  function strength(value: number): number {
    return maximum > 0 ? Math.sqrt(Math.max(0, value) / maximum) : 0
  }

  function fill(code: string): string {
    const country = byCode.get(code)
    if (!country) return 'var(--map-land)'
    const percentage = Math.round(36 + strength(country.value) * 60)
    return `color-mix(in oklab, var(--accent) ${percentage}%, var(--map-land))`
  }

  function bound(x: number, y: number, scale = zoom) {
    return {
      x: Math.max(earth.width * (1 - scale), Math.min(0, x)),
      y: Math.max(earth.height * (1 - scale), Math.min(0, y)),
    }
  }

  // The root SVG matrix accounts for responsive sizing and letterboxing.
  function point(clientX: number, clientY: number) {
    const matrix = svg?.getScreenCTM()
    return matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : null
  }

  function setZoom(value: number, anchor = { x: earth.width / 2, y: earth.height / 2 }) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value))
    const position = bound(anchor.x - (anchor.x - offsetX) * next / zoom, anchor.y - (anchor.y - offsetY) * next / zoom, next)
    zoom = next
    offsetX = position.x
    offsetY = position.y
    hovered = null
    if (next === MIN_ZOOM) panOpen = false
  }

  function reset() {
    zoom = MIN_ZOOM
    offsetX = 0
    offsetY = 0
    panOpen = false
    hovered = null
  }

  function pan(dx: number, dy: number) {
    const next = bound(offsetX + dx, offsetY + dy)
    offsetX = next.x
    offsetY = next.y
    hovered = null
  }

  function wheel(event: WheelEvent) {
    // Browser zoom remains available through Ctrl/Command + wheel.
    if (event.ctrlKey || event.metaKey || gesture) return
    const anchor = point(event.clientX, event.clientY)
    if (!anchor) return
    event.preventDefault()
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? svg.clientHeight : 1
    const delta = Math.max(-240, Math.min(240, event.deltaY * unit))
    setZoom(zoom * Math.exp(-delta * 0.003), anchor)
  }

  onMount(() => {
    svg.addEventListener('wheel', wheel, { passive: false })
    return () => svg.removeEventListener('wheel', wheel)
  })

  function pointerDown(event: PointerEvent) {
    // Touch keeps native page scrolling and pinch-to-zoom.
    if (event.button !== 0 || event.pointerType === 'touch' || !event.isPrimary) return
    const position = point(event.clientX, event.clientY)
    if (!position) return
    suppressClick = false
    gesture = {
      id: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      x: position.x, y: position.y, offsetX, offsetY,
    }
  }

  function pointerMove(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.id) return
    if (!(event.buttons & 1)) { cancelGesture(); return }
    if (!dragging && Math.hypot(event.clientX - gesture.clientX, event.clientY - gesture.clientY) < 4) return
    const position = point(event.clientX, event.clientY)
    if (!position) return
    if (!dragging) {
      dragging = true
      suppressClick = true
      svg.setPointerCapture(event.pointerId)
      viewport.focus({ preventScroll: true })
    }
    const next = bound(gesture.offsetX + position.x - gesture.x, gesture.offsetY + position.y - gesture.y)
    offsetX = next.x
    offsetY = next.y
    hovered = null
  }

  function cancelGesture() {
    const id = gesture?.id
    gesture = null
    dragging = false
    if (id !== undefined && svg.hasPointerCapture(id)) svg.releasePointerCapture(id)
  }

  function pointerUp(event: PointerEvent) {
    if (event.pointerId === gesture?.id) cancelGesture()
  }

  function captureClick(event: MouseEvent) {
    if (!suppressClick) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function navigate(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey || gesture) return
    const actions: Record<string, () => void> = {
      '+': () => setZoom(zoom * ZOOM_STEP), '=': () => setZoom(zoom * ZOOM_STEP),
      '-': () => setZoom(zoom / ZOOM_STEP), '0': reset, Home: reset,
      ArrowLeft: () => pan(earth.width * 0.12, 0), ArrowRight: () => pan(-earth.width * 0.12, 0),
      ArrowUp: () => pan(0, earth.height * 0.12), ArrowDown: () => pan(0, -earth.height * 0.12),
    }
    if (actions[event.key]) { event.preventDefault(); actions[event.key]() }
  }

  function focusCountry(code: string, position: number[], event: FocusEvent) {
    hovered = code
    if (!(event.currentTarget as SVGElement).matches(':focus-visible')) return
    // Keep a keyboard-focused marker away from both clipping and the corner tooltip.
    const next = bound(earth.width / 2 - position[0] * zoom, earth.height / 2 - position[1] * zoom)
    offsetX = next.x
    offsetY = next.y
  }

  function closePan(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    panOpen = false
    panButton.focus()
  }

  function toggle(code: string) {
    onselect(selected === code ? null : code)
  }

  function keydown(event: KeyboardEvent, code: string) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle(code)
    }
    if (event.key === 'Escape') onselect(null)
  }
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={cancelGesture} onblur={cancelGesture} />

<div class="earth-map">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (This is a keyboard-operated map application with equivalent visible navigation controls.) -->
  <div class="map-stage" class:dragging data-testid="map-viewport" bind:this={viewport}
    role="application" tabindex="0" aria-label={t('geography.mapAccessibility')}
    onpointerdown={pointerDown} onlostpointercapture={cancelGesture} onclickcapture={captureClick} onkeydown={navigate}>
    <svg
      bind:this={svg}
      viewBox="0 0 {earth.width} {earth.height}"
      role="group"
      data-testid="map-svg"
      aria-label={t('geography.mapLabel')}
    >
      <g data-testid="map-transform" transform="translate({offsetX} {offsetY}) scale({zoom})">
      <path class="ocean" d={earth.sphere} />
      <path class="graticule" d={earth.graticule} />
      <g class="land" aria-hidden="true">
        {#each earth.countries as country (country.code)}
          {#if country.path}
            <path
              d={country.path}
              fill={fill(country.code)}
              class:dimmed={selected !== null && selected !== country.code && byCode.has(country.code)}
            />
          {/if}
        {/each}
      </g>
      {#each active as country (country.code)}
        {@const item = byCode.get(country.code)!}
        {@const isSelected = selected === country.code}
        <g
          class="country"
          class:selected={isSelected}
          class:dimmed={selected !== null && !isSelected}
          role="button"
          tabindex="0"
          aria-label={t('geography.countryAccessibility', { name: item.name, metric: metricLabel.toLowerCase(), value: formatValue(item.value), count: item.count })}
          aria-pressed={isSelected}
          data-country={country.code}
          onclick={() => toggle(country.code)}
          onkeydown={(event) => keydown(event, country.code)}
          onpointerenter={() => (hovered = country.code)}
          onpointerleave={() => (hovered = null)}
          onfocus={(event) => focusCountry(country.code, country.point, event)}
          onblur={() => (hovered = null)}
        >
          <title>{item.name}: {formatValue(item.value)}</title>
          {#if country.path}
            <path class="hit-shape" d={country.path} />
          {/if}
        </g>
      {/each}
      <!-- Keep every visible marker above every country's geographic hit area. -->
      {#each active as country (country.code)}
        {@const item = byCode.get(country.code)!}
        {@const isSelected = selected === country.code}
        <g
          class="country-marker"
          class:selected={isSelected}
          class:highlighted={hovered === country.code}
          class:dimmed={selected !== null && !isSelected}
          role="button"
          tabindex="-1"
          aria-label={t('geography.countryAccessibility', { name: item.name, metric: metricLabel.toLowerCase(), value: formatValue(item.value), count: item.count })}
          aria-pressed={isSelected}
          data-marker-country={country.code}
          onclick={() => toggle(country.code)}
          onkeydown={(event) => keydown(event, country.code)}
          onpointerenter={() => (hovered = country.code)}
          onpointerleave={() => (hovered = null)}
          onfocus={(event) => focusCountry(country.code, country.point, event)}
          onblur={() => (hovered = null)}
        >
          <title>{item.name}: {formatValue(item.value)}</title>
          <circle class="point-ring" cx={country.point[0]} cy={country.point[1]} r={(8 + strength(item.value) * 6) / zoom} />
          <circle class="point" cx={country.point[0]} cy={country.point[1]} r={(3 + strength(item.value) * 3) / zoom} />
        </g>
      {/each}
      </g>
    </svg>
    <div class="map-detail" class:has-detail={!!detail} aria-hidden="true">
      {#if detail}
        <span class="detail-name">{detail.name}</span>
        <span class="detail-value">{formatValue(detail.value)}<span class="detail-label"> · {metricLabel.toLowerCase()}</span></span>
      {:else}
        <span class="map-hint">{t('geography.mapHint')}</span>
      {/if}
    </div>
  </div>
  <div class="map-navigation">
    <p class="interaction-hint">{t('geography.navigationHint')}</p>
    <div class="zoom-controls" role="group" aria-label={t('geography.mapNavigation')} onfocusout={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) panOpen = false
    }}>
      <button aria-label={t('geography.zoomOut')} title={t('geography.zoomOut')} disabled={zoom <= MIN_ZOOM} onclick={() => setZoom(zoom / ZOOM_STEP)}><IconMinus aria-hidden="true" /></button>
      <span class="zoom-value" data-testid="map-zoom-value" aria-label={t('geography.zoomLevel')}>{Math.round(zoom * 100)}%</span>
      <button aria-label={t('geography.zoomIn')} title={t('geography.zoomIn')} disabled={zoom >= MAX_ZOOM} onclick={() => setZoom(zoom * ZOOM_STEP)}><IconPlus aria-hidden="true" /></button>
      <div class="pan-menu">
        <button bind:this={panButton} aria-label={t('geography.panMap')} title={t('geography.panMap')} aria-expanded={panOpen} disabled={zoom <= MIN_ZOOM} onclick={() => (panOpen = !panOpen)} onkeydown={closePan}><IconMove aria-hidden="true" /></button>
        {#if panOpen}
          <div class="pan-pad" role="group" aria-label={t('geography.panMap')}>
            <button class="pan-up" aria-label={t('geography.panUp')} onclick={() => pan(0, earth.height * 0.12)} onkeydown={closePan}><IconArrowRight aria-hidden="true" /></button>
            <button class="pan-left" aria-label={t('geography.panLeft')} onclick={() => pan(earth.width * 0.12, 0)} onkeydown={closePan}><IconArrowRight aria-hidden="true" /></button>
            <button class="pan-down" aria-label={t('geography.panDown')} onclick={() => pan(0, -earth.height * 0.12)} onkeydown={closePan}><IconArrowRight aria-hidden="true" /></button>
            <button class="pan-right" aria-label={t('geography.panRight')} onclick={() => pan(-earth.width * 0.12, 0)} onkeydown={closePan}><IconArrowRight aria-hidden="true" /></button>
          </div>
        {/if}
      </div>
      <button aria-label={t('geography.resetMap')} title={t('geography.resetMap')} disabled={zoom === MIN_ZOOM} onclick={reset}><IconGeography aria-hidden="true" /></button>
    </div>
  </div>
  <div class="map-footer">
    <span class="projection">Equal Earth <span class="separator">·</span> Natural Earth</span>
    <div class="legend" aria-label={t('geography.legendAccessibility', { maximum: formatValue(maximum), metric: metricLabel })}>
      <span>0</span>
      <span class="legend-scale" aria-hidden="true">
        {#each [36, 51, 66, 81, 96] as opacity}
          <span style:background="color-mix(in oklab, var(--accent) {opacity}%, var(--map-land))"></span>
        {/each}
      </span>
      <span>{formatValue(maximum)}</span>
    </div>
  </div>
</div>

<style>
  .earth-map {
    min-width: 0;
    --map-ocean: light-dark(#eef1f4, #18181a);
    --map-land: light-dark(#cbd0d7, #2b2b30);
    --map-border: light-dark(#a2aab5, #45454b);
    --map-grid: light-dark(rgb(82 95 112 / 0.18), rgb(237 237 237 / 0.09));
  }
  .map-stage { position: relative; aspect-ratio: 1000 / 560; min-height: 220px; overflow: hidden; isolation: isolate; background: var(--map-ocean); }
  svg { display: block; width: 100%; height: 100%; position: absolute; inset: 0; cursor: grab; touch-action: pan-y pinch-zoom; user-select: none; }
  .map-stage:focus-visible { outline-offset: -3px; border-radius: 0; }
  .map-stage.dragging svg, .map-stage.dragging .country, .map-stage.dragging .country-marker { cursor: grabbing; }
  .ocean { fill: var(--map-ocean); stroke: var(--map-border); stroke-width: 0.8; vector-effect: non-scaling-stroke; }
  .graticule { fill: none; stroke: var(--map-grid); stroke-width: 0.6; vector-effect: non-scaling-stroke; }
  .land path { stroke: var(--map-border); stroke-width: 0.6; stroke-linejoin: round; vector-effect: non-scaling-stroke; transition: fill 180ms ease, opacity 180ms ease; }
  .country, .country-marker { cursor: pointer; outline: none; transition: opacity 180ms ease; }
  .country.dimmed, .country-marker.dimmed, .land .dimmed { opacity: 0.55; }
  .hit-shape { fill: transparent; stroke: transparent; stroke-width: 1; vector-effect: non-scaling-stroke; }
  .point-ring { fill: color-mix(in oklab, var(--accent) 14%, transparent); stroke: color-mix(in oklab, var(--accent-ink) 50%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }
  .point { fill: var(--accent-ink); stroke: var(--card); stroke-width: 1.6; vector-effect: non-scaling-stroke; pointer-events: all; }
  .country:hover .hit-shape, .country.selected .hit-shape, .country:focus-visible .hit-shape { stroke: var(--accent-ink); stroke-width: 1.4; }
  .country-marker.highlighted .point-ring, .country-marker.selected .point-ring, .country-marker:focus-visible .point-ring { fill: color-mix(in oklab, var(--accent) 22%, transparent); stroke: var(--accent-ink); stroke-width: 2; }
  .country-marker.highlighted .point, .country-marker:focus-visible .point { stroke: var(--text); stroke-width: 2; }
  .map-detail { position: absolute; top: 8px; left: 16px; pointer-events: none; display: grid; gap: 2px; padding: 9px 12px; border: 1px solid transparent; border-radius: 8px; }
  .map-detail.has-detail { border-color: var(--line); background: var(--card); box-shadow: var(--shadow-float); }
  .detail-name { font-size: 13px; color: var(--text); }
  .detail-value { font-family: var(--font-mono); font-size: 12px; color: var(--accent-ink); }
  .detail-label { color: var(--text-3); font-family: var(--font-sans); }
  .map-hint { font-size: 12px; color: var(--text-3); }
  .map-navigation { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px 8px 20px; border-top: 1px solid var(--line); }
  .interaction-hint { color: var(--text-3); font-size: 11px; line-height: 16px; }
  .zoom-controls { display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--card); }
  .zoom-controls button { display: flex; width: 44px; height: 44px; flex: none; align-items: center; justify-content: center; border-radius: 7px; color: var(--text-2); cursor: pointer; transition: background-color 120ms, color 120ms; }
  .zoom-controls button:hover:not(:disabled) { background: var(--raised); color: var(--text); }
  .zoom-controls button:active:not(:disabled) { transform: scale(0.95); }
  .zoom-controls button:disabled { opacity: 0.35; cursor: default; }
  .zoom-controls :global(svg) { position: static; width: 16px; height: 16px; cursor: inherit; }
  .zoom-value { width: 48px; text-align: center; font-family: var(--font-mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-2); }
  .pan-menu { position: relative; }
  .pan-pad { position: absolute; right: -44px; bottom: calc(100% + 10px); z-index: 2; display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(2, 44px); gap: 4px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--card); padding: 6px; box-shadow: var(--shadow-float); }
  .pan-up { grid-column: 2; }
  .pan-left { grid-column: 1; grid-row: 2; }
  .pan-down { grid-column: 2; grid-row: 2; }
  .pan-right { grid-column: 3; grid-row: 2; }
  .pan-up :global(svg) { transform: rotate(-90deg); }
  .pan-left :global(svg) { transform: rotate(180deg); }
  .pan-down :global(svg) { transform: rotate(90deg); }
  .map-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 20px 16px; color: var(--text-3); font-size: 11px; line-height: 16px; }
  .projection { white-space: nowrap; }
  .separator { padding: 0 5px; }
  .legend { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); }
  .legend-scale { display: flex; gap: 2px; }
  .legend-scale span { width: 18px; height: 8px; border-radius: 1px; }
  @media (max-width: 600px) {
    .map-detail { top: 0; left: 8px; padding: 5px 8px; }
    .map-hint { font-size: 11px; }
    .map-navigation { padding: 8px 12px; }
    .interaction-hint { width: 100%; }
    .zoom-controls { margin-left: auto; }
    .map-footer { padding: 4px 12px 12px; gap: 8px; }
    .legend-scale span { width: 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .land path, .country, .country-marker, .zoom-controls button { transition: none; }
  }
</style>
