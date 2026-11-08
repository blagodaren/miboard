<script lang="ts">
  import { onMount } from 'svelte'
  import type { RuleChainStat } from '../lib/rules-analytics'
  import { bytes, count } from '../lib/format'
  import { t } from '../lib/i18n.svelte'
  import { IconRules, IconProxies, IconServer, IconPlus, IconMinus, IconMove, IconArrowRight, IconEye } from '../lib/icons'

  let {
    chains,
    ruleNames,
    ruleColors = {},
    panorama = false,
    onpanorama,
  }: {
    chains: RuleChainStat[]
    ruleNames: Record<string, string>
    ruleColors?: Record<string, string>
    panorama?: boolean
    onpanorama?: () => void
  } = $props()

  const PAGE_SIZE = 12
  const GRAPH_WIDTH = 920
  const ROW_HEIGHT = 144
  let policy = $state('')
  let zoom = $state(1)
  let limit = $state(PAGE_SIZE)
  let viewport: HTMLDivElement
  let viewportWidth = $state(0)

  const policies = $derived([...new Set(chains.map((chain) => chain.policy).filter(Boolean))].sort((a, b) => a.localeCompare(b)))
  const activePolicy = $derived(policies.includes(policy) ? policy : '')
  const filtered = $derived(activePolicy ? chains.filter((chain) => chain.policy === activePolicy) : chains)
  const visible = $derived(filtered.slice(0, limit))
  const graphHeight = $derived(visible.length * ROW_HEIGHT)

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => { viewportWidth = entry.contentRect.width })
    observer.observe(viewport)
    return () => observer.disconnect()
  })

  function changeZoom(amount: number) {
    zoom = Math.max(0.5, Math.min(1.5, Math.round((zoom + amount) * 10) / 10))
  }

  function fitView() {
    zoom = Math.max(0.3, Math.min(1, (viewportWidth - 48) / GRAPH_WIDTH))
    viewport.scrollTo({ left: 0, top: 0 })
  }
</script>

<section class="chain-panel" aria-labelledby="rule-chain-title">
  <header class="chain-header">
    <h2 id="rule-chain-title"><IconProxies size={18} strokeWidth={1.5} aria-hidden="true" />{t('rules.analytics.chainFlow')}</h2>
    <div class="chain-actions"><label class="policy-filter">
      <span class="sr-only">{t('rules.analytics.policy')}</span>
      <select value={activePolicy} disabled={policies.length === 0} onchange={(event) => { policy = event.currentTarget.value; limit = PAGE_SIZE }}>
        <option value="">{t('rules.analytics.allPolicies')}</option>
        {#each policies as name (name)}<option value={name}>{name}</option>{/each}
      </select>
    </label>
    {#if onpanorama}<button class="panorama-button" class:active={panorama} aria-pressed={panorama} onclick={onpanorama}><IconEye size={16} strokeWidth={1.5} aria-hidden="true" />{t('rules.analytics.panorama')}</button>{/if}</div>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable graph must receive focus for native keyboard scrolling.) -->
  <div class="chain-viewport" bind:this={viewport} tabindex={chains.length ? 0 : undefined} role="region" aria-label={t('rules.analytics.scrollHint')}>
    {#if visible.length}
      <div class="chain-sizer" style:width="{GRAPH_WIDTH * zoom + 48}px" style:height="{graphHeight * zoom + 48}px">
        <div class="chain-graph" style:transform="scale({zoom})" style:width="{GRAPH_WIDTH}px">
          {#each visible as chain (chain.id)}
            <div class="chain-row" style:--chain-color={ruleColors[chain.ruleId] || 'var(--accent)'}>
              <article class="chain-node rule-node">
                <div class="node-eyebrow"><span>{t('rules.analytics.rule')}</span><span class="num connection-count" title={t('rules.analytics.connections')}>{count(chain.connections)}</span></div>
                <div class="node-name"><span class="node-icon"><IconRules size={18} strokeWidth={1.5} aria-hidden="true" /></span><strong title={ruleNames[chain.ruleId] || t('rules.analytics.rule')}>{ruleNames[chain.ruleId] || t('rules.analytics.rule')}</strong></div>
                <div class="node-traffic num"><span title={t('rules.analytics.download')}>↓ {bytes(chain.download)}</span><span title={t('rules.analytics.upload')}>↑ {bytes(chain.upload)}</span></div>
              </article>
              <div class="chain-link" aria-hidden="true"><span></span><IconArrowRight size={16} strokeWidth={1.5} /></div>
              <article class="chain-node policy-node">
                <div class="node-eyebrow">{t('rules.analytics.policy')}</div>
                <div class="node-name"><span class="node-icon"><IconProxies size={18} strokeWidth={1.5} aria-hidden="true" /></span><strong title={chain.policy}>{chain.policy || t('rules.analytics.unknownPolicy')}</strong></div>
                <div class="node-via" title={chain.via.join(' → ')}>{chain.via.length ? chain.via.join(' → ') : bytes(chain.total)}</div>
              </article>
              <div class="chain-link outbound-link" aria-hidden="true"><span></span><IconArrowRight size={16} strokeWidth={1.5} /></div>
              <article class="chain-node outbound-node">
                <div class="node-eyebrow">{t('rules.analytics.outbound')}</div>
                <div class="node-name"><span class="node-icon"><IconServer size={18} strokeWidth={1.5} aria-hidden="true" /></span><strong title={chain.outbound}>{chain.outbound || t('rules.analytics.unknownOutbound')}</strong></div>
                <div class="node-traffic num"><span title={t('rules.analytics.download')}>↓ {bytes(chain.download)}</span><span title={t('rules.analytics.upload')}>↑ {bytes(chain.upload)}</span></div>
              </article>
            </div>
          {/each}
        </div>
      </div>
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
      <button onclick={() => changeZoom(-0.1)} disabled={!chains.length || zoom <= 0.5} aria-label={t('rules.analytics.zoomOut')} title={t('rules.analytics.zoomOut')}><IconMinus size={16} strokeWidth={1.5} /></button>
      <span class="num">{count(zoom * 100)}%</span>
      <button onclick={() => changeZoom(0.1)} disabled={!chains.length || zoom >= 1.5} aria-label={t('rules.analytics.zoomIn')} title={t('rules.analytics.zoomIn')}><IconPlus size={16} strokeWidth={1.5} /></button>
      <button class="fit-button" onclick={fitView} disabled={!chains.length} aria-label={t('rules.analytics.fitView')} title={t('rules.analytics.fitView')}><IconMove size={16} strokeWidth={1.5} /></button>
    </div>
    <span class="chain-count num">{t('rules.analytics.chainCount', { shown: visible.length, total: filtered.length })}</span>
    {#if visible.length < filtered.length}<button class="show-more" onclick={() => { limit += PAGE_SIZE }}>{t('rules.analytics.showMoreChains')}</button>{/if}
  </footer>
</section>

<style>
  .chain-panel { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: var(--card); }
  .chain-header { display: flex; min-height: 76px; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; }
  h2 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 14px; font-weight: 550; }
  h2 :global(svg) { color: var(--accent-ink); }
  .chain-actions { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 8px; }
  .panorama-button { display: flex; min-height: 40px; align-items: center; gap: 7px; border: 1px solid var(--field-border); border-radius: 9px; background: var(--field); padding: 0 12px; color: var(--text-2); font-size: 12px; cursor: pointer; transition: background-color 150ms, border-color 150ms; }
  .panorama-button:hover { background: var(--hover); }
  .panorama-button.active { border-color: var(--selected-border); background: var(--selected); color: var(--selected-text); }
  .policy-filter { min-width: 0; max-width: 240px; }
  select { min-height: 40px; max-width: 100%; border: 1px solid var(--field-border); border-radius: 9px; background: var(--field); padding: 0 30px 0 12px; color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
  select:disabled { cursor: default; opacity: 0.6; }
  .chain-viewport { overflow: auto; max-height: 410px; min-height: 220px; background-color: var(--deep); background-image: radial-gradient(var(--line-strong) 0.8px, transparent 0.8px); background-size: 20px 20px; overscroll-behavior: contain; }
  .chain-sizer { position: relative; min-width: 100%; }
  .chain-graph { position: absolute; left: 24px; top: 24px; transform-origin: top left; }
  .chain-row { display: grid; height: 144px; grid-template-columns: 248px 88px 248px 88px 248px; align-items: center; }
  .chain-node { min-width: 0; padding: 12px 16px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--card); box-shadow: var(--shadow-panel); }
  .rule-node { border-color: color-mix(in oklab, var(--chain-color) 65%, var(--line)); background: color-mix(in oklab, var(--chain-color) 7%, var(--card)); }
  .outbound-node { border-color: color-mix(in oklab, var(--good) 45%, var(--line)); background: color-mix(in oklab, var(--good) 5%, var(--card)); }
  .node-eyebrow { display: flex; height: 20px; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: var(--text-3); font-size: 11px; line-height: 16px; }
  .connection-count { color: var(--text-2); }
  .node-name { display: flex; min-width: 0; align-items: center; gap: 9px; }
  .node-icon { display: inline-flex; width: 30px; height: 30px; flex: none; align-items: center; justify-content: center; border-radius: 8px; background: var(--raised); color: var(--text-2); }
  .rule-node .node-icon { background: color-mix(in oklab, var(--chain-color) 15%, var(--card)); color: var(--accent-ink); }
  .outbound-node .node-icon { background: color-mix(in oklab, var(--good) 12%, var(--card)); color: var(--good); }
  .node-name strong { overflow: hidden; min-width: 0; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
  .node-traffic { display: flex; justify-content: space-between; gap: 8px; margin-top: 11px; color: var(--text-2); font-family: var(--font-mono); font-size: 11px; line-height: 16px; }
  .node-via { overflow: hidden; margin-top: 11px; color: var(--text-2); font-family: var(--font-mono); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
  .chain-link { position: relative; display: flex; align-items: center; color: color-mix(in oklab, var(--chain-color) 70%, var(--text-3)); }
  .chain-link span { width: 100%; height: 2px; background: currentColor; opacity: 0.7; }
  .chain-link::before { position: absolute; left: -4px; width: 7px; height: 7px; border: 1px solid var(--card); border-radius: 50%; background: currentColor; content: ''; }
  .chain-link :global(svg) { position: absolute; right: -3px; }
  .outbound-link { color: var(--good); }
  .chain-footer { display: flex; min-height: 65px; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 20px; border-top: 1px solid var(--line); }
  .zoom-controls { display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--field); }
  .zoom-controls button { display: flex; width: 40px; height: 40px; align-items: center; justify-content: center; border-radius: 8px; color: var(--text-2); cursor: pointer; transition: background-color 150ms, color 150ms; }
  .zoom-controls button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  .zoom-controls button:active:not(:disabled) { transform: scale(0.95); }
  .zoom-controls button:disabled { cursor: default; opacity: 0.35; }
  .zoom-controls span { min-width: 40px; text-align: center; color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }
  .zoom-controls .fit-button { border-left: 1px solid var(--line); border-top-left-radius: 0; border-bottom-left-radius: 0; }
  .chain-count { margin-left: auto; color: var(--text-3); font-size: 12px; }
  .show-more { min-height: 40px; border-radius: 8px; padding: 0 10px; color: var(--accent-ink); font-size: 12px; cursor: pointer; transition: background-color 150ms; }
  .show-more:hover { background: var(--hover); }
  .chain-empty { display: flex; min-height: 220px; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 32px 20px; text-align: center; color: var(--text-3); }
  .chain-empty p { color: var(--text-2); font-size: 13px; }
  .chain-empty span { font-size: 12px; }
  @media (max-width: 639px) {
    .chain-header { gap: 10px; padding: 16px; }
    .chain-actions { width: 100%; }
    .policy-filter { min-width: 0; flex: 1; max-width: none; }
    .panorama-button { min-height: 44px; }
    select { width: 100%; min-height: 44px; }
    .chain-footer { gap: 8px; padding: 10px 12px; }
    .zoom-controls button { width: 44px; height: 44px; }
    .zoom-controls span { min-width: 35px; }
    .chain-count { font-size: 11px; }
    .show-more { width: 100%; min-height: 44px; }
  }
  @media (prefers-reduced-motion: reduce) { button { transition: none !important; } }
</style>
