<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { RuleChainStat } from '../lib/rules-analytics'
  import { buildRuleChainGraph, getRuleChainHighlight } from '../lib/rule-chain-graph'
  import { bytes, count } from '../lib/format'
  import { t } from '../lib/i18n.svelte'
  import { IconRules, IconProxies, IconServer, IconPlus, IconMinus, IconMove } from '../lib/icons'

  let {
    chains,
    ruleNames,
    ruleColors = {},
  }: {
    chains: RuleChainStat[]
    ruleNames: Record<string, string>
    ruleColors?: Record<string, string>
  } = $props()

  type GraphNode = ReturnType<typeof buildRuleChainGraph>['nodes'][number]
  let policy = $state('')
  let zoom = $state(1)
  let viewport: HTMLDivElement
  let viewportWidth = $state(0)
  let initiallyFitted = false
  let hoveredNodeId = $state<string | null>(null)
  let focusedNodeId = $state<string | null>(null)

  const policies = $derived([...new Set(chains.map((chain) => chain.policy).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
  const activePolicy = $derived(policies.includes(policy) ? policy : '')
  const filtered = $derived(activePolicy ? chains.filter((chain) => chain.policy === activePolicy) : chains)
  const graph = $derived(buildRuleChainGraph(filtered))
  const nodeById = $derived(new Map(graph.nodes.map((node) => [node.id, node])))
  const activeNodeId = $derived(hoveredNodeId ?? focusedNodeId)
  const highlight = $derived(getRuleChainHighlight(graph, activeNodeId))
  const activeRuleId = $derived(activeNodeId ? nodeById.get(activeNodeId)?.ruleId : undefined)
  const highlightColor = $derived(activeRuleId ? ruleColors[activeRuleId] || 'var(--accent)' : 'var(--accent)')
  const edges = $derived(graph.edges.map((edge) => {
    const source = nodeById.get(edge.source)!
    const target = nodeById.get(edge.target)!
    return { ...edge, sourceNode: source, targetNode: target, ...edgeGeometry(source, target) }
  }))

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => { viewportWidth = entry.contentRect.width })
    observer.observe(viewport)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (viewportWidth > 0 && graph.nodes.length && !initiallyFitted) {
      initiallyFitted = true
      // Keep node labels readable in narrow panels; the overview remains one click away.
      untrack(() => { void (viewportWidth < 640 ? centerView() : fitView()) })
    }
  })

  $effect(() => {
    if (hoveredNodeId && !nodeById.has(hoveredNodeId)) hoveredNodeId = null
    if (focusedNodeId && !nodeById.has(focusedNodeId)) focusedNodeId = null
  })

  function changeZoom(amount: number) {
    zoom = Math.max(0.3, Math.min(1.5, Math.round((zoom + amount) * 100) / 100))
  }

  async function centerView() {
    await tick()
    viewport.scrollTo({ left: 0, top: Math.max(0, (graph.height * zoom + 48 - viewport.clientHeight) / 2) })
  }

  async function fitView() {
    zoom = Math.max(0.3, Math.min(1, Math.floor((viewportWidth - 48) / Math.max(graph.width, 1) * 100) / 100))
    await centerView()
  }

  function nodeName(node: GraphNode) {
    if (node.kind === 'rule') return ruleNames[node.ruleId!] || t('rules.analytics.unknownRule')
    return node.name || t(node.kind === 'group' ? 'rules.analytics.unknownPolicy' : 'rules.analytics.unknownOutbound')
  }

  function edgeGeometry(source: GraphNode, target: GraphNode) {
    const startX = source.x + source.width
    const startY = source.y + source.height / 2
    const endY = target.y + target.height / 2
    const backward = target.x <= source.x
    const endX = backward ? target.x + target.width : target.x
    const bend = backward ? Math.max(startX, endX) + 40 : (startX + endX) / 2
    const tipX = endX + (backward ? 6 : -6)
    let path = `M ${startX} ${startY} C ${bend} ${startY}, ${bend} ${endY}, ${endX} ${endY}`
    // A direct rule → Select/exit edge can skip columns. Route it through a free
    // horizontal gap so passing behind another card cannot imply a false hop.
    const obstacles = graph.nodes.filter((node) => node.x > source.x && node.x < target.x)
    if (!backward && obstacles.length) {
      const blocked: [number, number][] = []
      for (const node of obstacles.sort((a, b) => a.y - b.y)) {
        const interval: [number, number] = [node.y - 10, node.y + node.height + 10]
        const previous = blocked.at(-1)
        if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
        else blocked.push(interval)
      }
      let trackY = (startY + endY) / 2
      const interval = blocked.find(([top, bottom]) => trackY > top && trackY < bottom)
      if (interval) trackY = trackY - interval[0] < interval[1] - trackY ? interval[0] : interval[1]
      const firstBend = startX + 24
      const lastBend = endX - 24
      path = `M ${startX} ${startY} C ${firstBend} ${startY}, ${firstBend} ${trackY}, ${firstBend + 12} ${trackY} L ${lastBend - 12} ${trackY} C ${lastBend} ${trackY}, ${lastBend} ${endY}, ${endX} ${endY}`
    }
    return {
      path,
      arrow: `M ${tipX} ${endY - 4} L ${endX} ${endY} L ${tipX} ${endY + 4}`,
    }
  }
</script>

<section class="chain-panel" aria-labelledby="rule-chain-title">
  <header class="chain-header">
    <h2 id="rule-chain-title"><IconProxies size={18} strokeWidth={1.5} aria-hidden="true" />{t('rules.analytics.chainFlow')}</h2>
    <label class="policy-filter">
      <span class="sr-only">{t('rules.analytics.policy')}</span>
      <select value={activePolicy} disabled={policies.length === 0} onchange={(event) => { hoveredNodeId = null; focusedNodeId = null; policy = event.currentTarget.value; void centerView() }}>
        <option value="">{t('rules.analytics.allPolicies')}</option>
        {#each policies as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable graph must receive focus for native keyboard scrolling.) -->
  <div class="chain-viewport" bind:this={viewport} tabindex={chains.length ? 0 : undefined} role="region" aria-label={t('rules.analytics.scrollHint')}>
    {#if filtered.length}
      <div class="chain-sizer" style:width="{graph.width * zoom + 48}px" style:height="{graph.height * zoom + 48}px">
        <div class="chain-graph" style:transform="scale({zoom})" style:width="{graph.width}px" style:height="{graph.height}px" style:--route-color={highlightColor}>
          <svg class="chain-links" width={graph.width} height={graph.height} aria-hidden="true">
            {#each edges as edge (edge.id)}
              <g class="chain-edge" class:is-highlighted={highlight?.edgeIds.has(edge.id)} class:is-muted={highlight !== null && !highlight.edgeIds.has(edge.id)} data-source={edge.source} data-target={edge.target}
                data-highlighted={highlight?.edgeIds.has(edge.id) ? 'true' : undefined} data-muted={highlight !== null && !highlight.edgeIds.has(edge.id) ? 'true' : undefined}
                style:--edge-color={edge.sourceNode.kind === 'rule' ? ruleColors[edge.sourceNode.ruleId!] || 'var(--accent)' : 'var(--text-3)'}>
                <title>{nodeName(edge.sourceNode)} → {nodeName(edge.targetNode)} · {bytes(edge.total)}</title>
                <path d={edge.path} />
                <path d={edge.arrow} />
              </g>
            {/each}
          </svg>
          {#each graph.nodes as node (node.id)}
            <button type="button" class="chain-node" class:rule-node={node.kind === 'rule'} class:policy-node={node.kind === 'group'} class:outbound-node={node.kind === 'outbound'}
              class:is-highlighted={highlight?.nodeIds.has(node.id)} class:is-muted={highlight !== null && !highlight.nodeIds.has(node.id)} data-node-id={node.id} data-kind={node.kind}
              data-highlighted={highlight?.nodeIds.has(node.id) ? 'true' : undefined} data-muted={highlight !== null && !highlight.nodeIds.has(node.id) ? 'true' : undefined}
              aria-label={t('rules.analytics.highlightRoute', { name: nodeName(node) })}
              onpointerenter={(event) => { if (event.pointerType !== 'touch') hoveredNodeId = node.id }}
              onpointerleave={() => { if (hoveredNodeId === node.id) hoveredNodeId = null }}
              onfocus={() => focusedNodeId = node.id}
              onblur={() => { if (focusedNodeId === node.id) focusedNodeId = null }}
              onclick={(event) => event.currentTarget.focus()}
              onkeydown={(event) => { if (event.key === 'Escape') { hoveredNodeId = null; focusedNodeId = null; event.currentTarget.blur(); event.stopPropagation() } }}
              style:left="{node.x}px" style:top="{node.y}px" style:width="{node.width}px" style:height="{node.height}px" style:--chain-color={node.ruleId ? ruleColors[node.ruleId] || 'var(--accent)' : 'var(--accent)'}>
              <div class="node-eyebrow"><span>{t(node.kind === 'rule' ? 'rules.analytics.rule' : node.kind === 'group' ? 'rules.analytics.group' : 'rules.analytics.outbound')}</span><span class="num connection-count" title={t('rules.analytics.connections')}>{count(node.connections)}</span></div>
              <div class="node-name"><span class="node-icon">
                {#if node.kind === 'rule'}<IconRules size={18} strokeWidth={1.5} aria-hidden="true" />{:else if node.kind === 'group'}<IconProxies size={18} strokeWidth={1.5} aria-hidden="true" />{:else}<IconServer size={18} strokeWidth={1.5} aria-hidden="true" />{/if}
              </span><strong title={nodeName(node)}>{nodeName(node)}</strong></div>
              <div class="node-traffic num"><span title={t('rules.analytics.download')}>↓ {bytes(node.download)}</span><span title={t('rules.analytics.upload')}>↑ {bytes(node.upload)}</span></div>
            </button>
          {/each}
        </div>
      </div>
      <ol class="sr-only">
        {#each filtered as chain (chain.id)}<li>{ruleNames[chain.ruleId] || t('rules.analytics.unknownRule')} → {chain.path.length ? chain.path.join(' → ') : t('rules.analytics.unknownOutbound')} · {t('rules.analytics.connections')}: {count(chain.connections)} · ↓ {bytes(chain.download)} · ↑ {bytes(chain.upload)}</li>{/each}
      </ol>
    {:else}
      <div class="chain-empty">
        <IconProxies size={28} strokeWidth={1} aria-hidden="true" />
        <p>{t('rules.analytics.noChains')}</p>
        <span>{t('rules.analytics.noChainsHint')}</span>
      </div>
    {/if}
  </div>

  <footer class="chain-footer">
    <div class="zoom-controls" role="group" aria-label={t('rules.analytics.fitView')}>
      <button onclick={() => changeZoom(-0.1)} disabled={!chains.length || zoom <= 0.3} aria-label={t('rules.analytics.zoomOut')} title={t('rules.analytics.zoomOut')}><IconMinus size={16} strokeWidth={1.5} /></button>
      <span class="num">{count(zoom * 100)}%</span>
      <button onclick={() => changeZoom(0.1)} disabled={!chains.length || zoom >= 1.5} aria-label={t('rules.analytics.zoomIn')} title={t('rules.analytics.zoomIn')}><IconPlus size={16} strokeWidth={1.5} /></button>
      <button class="fit-button" onclick={fitView} disabled={!chains.length} aria-label={t('rules.analytics.fitView')} title={t('rules.analytics.fitView')}><IconMove size={16} strokeWidth={1.5} /></button>
    </div>
    <span class="chain-count num">{t('rules.analytics.chainCount', { count: count(filtered.length) })}</span>
  </footer>
</section>

<style>
  .chain-panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .chain-header { display: flex; min-height: 76px; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; }
  h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
  h2 :global(svg) { color: var(--text-2); }
  .policy-filter { min-width: 0; max-width: 240px; }
  select { min-height: 40px; max-width: 100%; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--field); padding: 0 30px 0 12px; color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
  select:disabled { cursor: default; opacity: 0.6; }
  .chain-viewport { overflow: auto; max-height: 520px; min-height: 220px; background-color: var(--deep); background-image: radial-gradient(var(--line-strong) 0.8px, transparent 0.8px); background-size: 20px 20px; overscroll-behavior: contain; }
  .chain-sizer { position: relative; min-width: 100%; }
  .chain-graph { position: absolute; left: 24px; top: 24px; transform-origin: top left; }
  .chain-links { position: absolute; inset: 0; overflow: visible; }
  .chain-edge { color: var(--edge-color); fill: none; stroke: currentColor; stroke-width: 1.5; opacity: 0.8; transition: opacity 150ms var(--ease-out), color 150ms var(--ease-out); }
  .chain-edge.is-highlighted { color: var(--route-color); opacity: 1; stroke-width: 2.5; }
  .chain-edge.is-muted { opacity: 0.12; }
  .chain-node { position: absolute; box-sizing: border-box; min-width: 0; padding: 12px 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-card); background: var(--card); box-shadow: var(--shadow-panel); color: var(--text); text-align: left; font: inherit; cursor: pointer; transition: border-color 150ms var(--ease-out), background-color 150ms var(--ease-out), box-shadow 150ms var(--ease-out); }
  .rule-node { border-color: color-mix(in oklab, var(--chain-color) 65%, var(--line)); background: color-mix(in oklab, var(--chain-color) 7%, var(--card)); }
  .chain-node.is-highlighted { border-color: var(--route-color); background: color-mix(in oklab, var(--route-color) 9%, var(--card)); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--route-color) 40%, transparent), var(--shadow-panel); }
  .chain-node.is-muted { border-color: var(--line); box-shadow: none; }
  .node-eyebrow { display: flex; height: 20px; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--text-3); font-size: 12px; line-height: 16px; }
  .connection-count { color: var(--text-2); }
  .node-name { display: flex; min-width: 0; align-items: center; gap: 8px; }
  .node-icon { display: inline-flex; width: 28px; height: 28px; flex: none; align-items: center; justify-content: center; border-radius: 8px; background: var(--raised); color: var(--text-2); }
  .rule-node .node-icon { background: var(--raised); color: var(--text-2); }
  .node-name strong { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
  .node-traffic { display: flex; justify-content: space-between; gap: 8px; margin-top: 8px; color: var(--text-2); font-family: var(--font-mono); font-size: 12px; line-height: 16px; }
  .chain-footer { display: flex; min-height: 64px; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--line); }
  .zoom-controls { display: flex; align-items: center; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--field); }
  .zoom-controls button { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; border-radius: 8px; color: var(--text-2); cursor: pointer; transition: background-color 150ms var(--ease-out), color 150ms var(--ease-out); }
  .zoom-controls button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  .zoom-controls button:active:not(:disabled) { transform: scale(0.95); }
  .zoom-controls button:disabled { cursor: default; opacity: 0.35; }
  .zoom-controls span { min-width: 40px; text-align: center; color: var(--text-3); font-family: var(--font-mono); font-size: 12px; }
  .zoom-controls .fit-button { border-left: 1px solid var(--line); border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .chain-count { margin-left: auto; color: var(--text-3); font-size: 12px; }
  .chain-empty { display: flex; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 32px 20px; text-align: center; color: var(--text-3); }
  .chain-empty p { color: var(--text-2); font-size: 13px; }
  .chain-empty span { font-size: 12px; }
  @media (max-width: 639px) {
    .chain-header { gap: 12px; padding: 16px; }
    .policy-filter { width: 100%; max-width: none; }
    select { width: 100%; min-height: 44px; }
    .chain-footer { gap: 8px; padding: 12px; }
    .zoom-controls button { width: 44px; height: 44px; }
    .zoom-controls span { min-width: 36px; }
  }
  @media (prefers-reduced-motion: reduce) { button, .chain-edge { transition: none !important; } }
</style>
