<script lang="ts">
  import { tick } from 'svelte'
  import Monitor from '@lucide/svelte/icons/monitor'
  import Globe from '@lucide/svelte/icons/globe'
  import Network from '@lucide/svelte/icons/network'
  import { IconPlus, IconMinus, IconMove } from '../lib/icons'
  import type { DeviceConnection } from '../lib/devices'
  import { buildDeviceFlow, DEVICE_FLOW_COLUMN_WIDTH, DEVICE_FLOW_NODE_WIDTH, type DeviceFlowNode, type DeviceFlowMetric } from '../lib/device-flow'
  import { bytes, count } from '../lib/format'
  import { t } from '../lib/i18n.svelte'

  let { connections, metric, selectedDevice, onselect, names = {} }: {
    connections: readonly DeviceConnection[]
    metric: DeviceFlowMetric
    selectedDevice: string | null
    onselect: (deviceId: string | null) => void
    names?: Record<string, string>
  } = $props()

  const headingId = $props.id()
  let viewport: HTMLDivElement
  let zoom = $state(1)
  const graph = $derived(buildDeviceFlow(connections, metric, selectedDevice))
  const nodesById = $derived(new Map(graph.nodes.map((node) => [node.id, node])))
  const columns = $derived([
    { label: t('devices.device'), index: 0 },
    { label: t('devices.proxy'), index: 1 },
    { label: t('devices.domain'), index: 2 },
  ])

  function nodeName(node: DeviceFlowNode): string {
    if (node.other) return t(node.kind === 'device' ? 'devices.otherDevices' : node.kind === 'proxy' ? 'devices.otherProxies' : 'devices.otherDomains')
    if (node.unknown) return t(node.kind === 'device' ? 'devices.unknownDevice' : node.kind === 'proxy' ? 'devices.unknownProxy' : 'devices.unknownDomain')
    return node.kind === 'device' ? names[node.deviceId!] || node.name : node.name
  }

  async function fitView() {
    if (!viewport || !graph.nodes.length) return
    zoom = Math.max(0.3, Math.min(1, Math.floor(Math.min((viewport.clientWidth - 40) / graph.width, (viewport.clientHeight - 40) / graph.height) * 100) / 100))
    await tick()
    viewport.scrollTo({ left: 0, top: 0 })
  }

  function changeZoom(delta: number) {
    zoom = Math.max(0.3, Math.min(1.5, Math.round((zoom + delta) * 100) / 100))
  }

</script>

<section class="device-flow-panel" data-testid="device-flow" aria-labelledby={headingId}>
  <header class="flow-header">
    <div class="flow-title">
      <h2 id={headingId}><Network size={18} strokeWidth={1.5} aria-hidden="true" />{t('devices.flowTitle')}</h2>
      <p>{t('devices.flowMeta')}</p>
    </div>
    {#if selectedDevice !== null}<button class="clear-device" onclick={() => onselect(null)}>{t('devices.allDevices')}</button>{/if}
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scroll region supports native keyboard scrolling independently of the page.) -->
  <div class="flow-viewport" bind:this={viewport} role="region" aria-label={t('devices.flowAccessibility')} tabindex={graph.nodes.length ? 0 : undefined}>
    {#if graph.nodes.length}
      <div class="flow-sizer" style:width="{graph.width * zoom + 40}px" style:height="{graph.height * zoom + 40}px">
        <div class="flow-graph" style:width="{graph.width}px" style:height="{graph.height}px" style:transform="scale({zoom})">
          {#each columns as column (column.index)}
            <span class="column-heading" style:left="{column.index * DEVICE_FLOW_COLUMN_WIDTH}px" style:width="{DEVICE_FLOW_NODE_WIDTH}px">{column.label}</span>
          {/each}
          <svg class="flow-links" width={graph.width} height={graph.height} aria-hidden="true">
            {#each graph.links as link (link.id)}
              <g data-testid="device-flow-link" data-source={link.source} data-target={link.target} class="flow-link" class:proxy-link={nodesById.get(link.source)?.kind === 'proxy'}>
                <path d={link.path} stroke-width={link.strokeWidth} />
              </g>
            {/each}
          </svg>

          {#each graph.nodes as node (node.id)}
            {#if node.kind === 'device' && !node.other}
              <button
                class="flow-node device-node"
                class:chosen={selectedDevice === node.deviceId}
                style:left="{node.x}px" style:top="{node.y}px" style:width="{node.width}px" style:height="{node.height}px"
                data-testid="device-flow-node" data-kind={node.kind} data-node-id={node.id} data-name={node.name} data-device-id={node.deviceId} data-unknown={node.unknown}
                aria-pressed={selectedDevice === node.deviceId}
                aria-label={t('devices.selectDevice', { name: nodeName(node) })}
                onclick={() => onselect(selectedDevice === node.deviceId ? null : node.deviceId!)}
              >
                {@render nodeContent(node)}
              </button>
            {:else}
              <article class="flow-node" class:other-node={node.other}
                style:left="{node.x}px" style:top="{node.y}px" style:width="{node.width}px" style:height="{node.height}px"
                data-testid="device-flow-node" data-kind={node.kind} data-node-id={node.id} data-name={node.name} data-other={node.other} data-unknown={node.unknown}>
                {@render nodeContent(node)}
              </article>
            {/if}
          {/each}
        </div>
      </div>
      <ol class="sr-only">
        {#each graph.links as link (link.id)}
          <li>{nodeName(nodesById.get(link.source)!)} → {nodeName(nodesById.get(link.target)!)} · {t('devices.connections')}: {count(link.connections)} · {t('devices.download')}: {bytes(link.download)} · {t('devices.upload')}: {bytes(link.upload)}</li>
        {/each}
      </ol>
    {:else}
      <div class="flow-empty"><Network size={30} strokeWidth={1} aria-hidden="true" /><p>{t('devices.noFlows')}</p><span>{t('devices.noFlowsHint')}</span></div>
    {/if}
  </div>

  <footer class="flow-footer">
    <div class="zoom-controls" role="group" aria-label={t('devices.fitView')}>
      <button onclick={() => changeZoom(-0.1)} disabled={!graph.nodes.length || zoom <= 0.3} aria-label={t('devices.zoomOut')} title={t('devices.zoomOut')}><IconMinus size={16} strokeWidth={1.5} aria-hidden="true" /></button>
      <span class="num">{count(zoom * 100)}%</span>
      <button onclick={() => changeZoom(0.1)} disabled={!graph.nodes.length || zoom >= 1.5} aria-label={t('devices.zoomIn')} title={t('devices.zoomIn')}><IconPlus size={16} strokeWidth={1.5} aria-hidden="true" /></button>
      <button onclick={fitView} disabled={!graph.nodes.length} aria-label={t('devices.fitView')} title={t('devices.fitView')}><IconMove size={16} strokeWidth={1.5} aria-hidden="true" /></button>
    </div>
    <span class="flow-count num">{t('devices.flowCount', { count: graph.links.length })}</span>
  </footer>
</section>

{#snippet nodeContent(node: DeviceFlowNode)}
  <span class="node-line">
    <span class="node-icon" aria-hidden="true">{#if node.kind === 'device'}<Monitor size={16} strokeWidth={1.5} />{:else if node.kind === 'proxy'}<Network size={16} strokeWidth={1.5} />{:else}<Globe size={16} strokeWidth={1.5} />{/if}</span>
    <strong title={nodeName(node)}>{nodeName(node)}</strong>
    <span class="node-value num">{metric === 'traffic' ? bytes(node.total) : count(node.connections)}</span>
  </span>
  <span class="node-details num">
    {#if node.kind === 'device' && node.name && names[node.deviceId!]}<span class="node-address" title={node.name}>{node.name}</span>
    {:else}<span title={t('devices.download')}>↓ {bytes(node.download)}</span><span title={t('devices.upload')}>↑ {bytes(node.upload)}</span>{/if}
    <span class="node-connections" title={t('devices.connections')}>{count(node.connections)}</span>
  </span>
{/snippet}

<style>
  .device-flow-panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--card); box-shadow: var(--shadow-panel); }
  .flow-header { display: flex; flex-wrap: wrap; min-height: 80px; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; }
  h2 { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; line-height: 20px; }
  h2 :global(svg) { color: var(--text-2); }
  .flow-title p { margin-top: 4px; color: var(--text-3); font-size: 12px; line-height: 20px; }
  .clear-device { min-height: 40px; padding: 0 12px; border: 1px solid var(--field-border); border-radius: var(--radius-control); color: var(--text-2); font-size: 12px; cursor: pointer; transition: color 150ms, background-color 150ms; }
  .clear-device:hover { color: var(--text); background: var(--hover); }
  .flow-viewport { height: 440px; overflow: auto; overscroll-behavior: contain; background: var(--deep); border-block: 1px solid var(--line); }
  .flow-viewport:focus-visible { outline-offset: -3px; }
  .flow-sizer { position: relative; min-width: 100%; }
  .flow-graph { position: absolute; left: 20px; top: 20px; transform-origin: top left; }
  .column-heading { position: absolute; top: 0; padding-left: 1px; color: var(--text-3); font-size: 12px; font-weight: 500; line-height: 20px; }
  .flow-links { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  .flow-link { fill: none; stroke: var(--accent); opacity: 0.38; }
  .proxy-link { stroke: var(--chart-blue, var(--text-3)); opacity: 0.45; }
  .flow-node { position: absolute; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; min-width: 0; padding: 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-card); background: var(--card); box-shadow: var(--shadow-panel); text-align: left; }
  .device-node { cursor: pointer; border-color: color-mix(in oklab, var(--accent) 45%, var(--line)); transition: border-color 150ms, background-color 150ms; }
  .device-node:hover, .device-node.chosen { border-color: var(--selected-border); background: var(--selected); }
  .other-node { border-style: dashed; }
  .node-line { display: flex; min-width: 0; align-items: center; gap: 8px; }
  .node-icon { display: flex; align-items: center; flex-shrink: 0; color: var(--text-3); }
  .device-node .node-icon { color: var(--accent-ink); }
  .node-line strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; line-height: 20px; }
  .node-value { margin-left: auto; flex-shrink: 0; white-space: nowrap; font-size: 12px; color: var(--text-2); }
  .node-details { display: flex; min-width: 0; align-items: center; gap: 8px; margin-top: 4px; padding-left: 24px; font-size: 12px; line-height: 16px; color: var(--text-3); }
  .node-details > span { white-space: nowrap; }
  .node-connections { margin-left: auto; }
  .node-address { overflow: hidden; text-overflow: ellipsis; }
  .flow-footer { display: flex; flex-wrap: wrap; min-height: 64px; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px; }
  .zoom-controls { display: inline-flex; align-items: center; border: 1px solid var(--field-border); border-radius: var(--radius-control); background: var(--field); }
  .zoom-controls button { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; flex-shrink: 0; border-radius: var(--radius-control); color: var(--text-2); cursor: pointer; transition: color 150ms, background-color 150ms; }
  .zoom-controls button:hover:not(:disabled) { color: var(--text); background: var(--hover); }
  .zoom-controls button:disabled { opacity: .4; cursor: default; }
  .zoom-controls span { width: 48px; color: var(--text-2); text-align: center; font-size: 12px; }
  .flow-count { color: var(--text-3); font-size: 12px; }
  .flow-empty { display: flex; height: 100%; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; text-align: center; color: var(--text-3); }
  .flow-empty p { color: var(--text-2); font-size: 13px; }
  .flow-empty span { max-width: 42ch; font-size: 12px; }
  @media (max-width: 639px) { .flow-header { padding: 16px; } .flow-viewport { height: 360px; } .flow-footer { padding: 12px 16px; } .zoom-controls button { width: 40px; height: 40px; } }
  @media (prefers-reduced-motion: reduce) { .clear-device, .device-node, .zoom-controls button { transition: none; } }
</style>
