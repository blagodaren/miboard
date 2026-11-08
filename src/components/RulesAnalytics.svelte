<script lang="ts">
  import type { Connection, Rule } from '../lib/api'
  import { buildRulesAnalytics, type RuleTrafficStat } from '../lib/rules-analytics'
  import { bytes, count } from '../lib/format'
  import { i18n, t } from '../lib/i18n.svelte'
  import { IconRules, IconGeography, IconConnections, IconPause, IconPlay } from '../lib/icons'
  import RuleChainFlow from './RuleChainFlow.svelte'

  let { connections, rules, ready, online }: {
    connections: readonly Connection[]
    rules: readonly Rule[]
    ready: boolean
    online: boolean
  } = $props()

  const PALETTE = ['var(--accent)', 'var(--chart-blue)', 'var(--chart-teal)', 'var(--chart-rose)', 'var(--chart-slate)']
  const assignedColors = new Map<string, string>()
  const CIRCUMFERENCE = 2 * Math.PI * 76
  let selectedId = $state<string | null>(null)
  let panorama = $state(false)
  let rankingLimit = $state(50)
  let paused = $state(false)
  let frozen = $state.raw<ReturnType<typeof buildRulesAnalytics> | null>(null)
  const liveStats = $derived(buildRulesAnalytics(connections, rules))
  const stats = $derived(paused && frozen ? frozen : liveStats)
  const selected = $derived(stats.rules.find((rule) => rule.id === selectedId) ?? stats.rules[0])
  const colors = $derived(Object.fromEntries(stats.rules.map((rule) => [rule.id, colorFor(rule.id)])))
  const names = $derived(Object.fromEntries(stats.rules.map((rule) => [rule.id, ruleName(rule)])))
  const domains = $derived(selected?.domains.slice(0, 10) ?? [])
  const maxDomain = $derived(Math.max(...domains.map((domain) => domain.total), 1))
  const percentFormat = $derived(new Intl.NumberFormat(i18n.intlLocale, { style: 'percent', maximumFractionDigits: 1 }))
  const segments = $derived.by(() => {
    let offset = 0
    const withTraffic = stats.rules.filter((rule) => rule.total > 0)
    return withTraffic.slice(0, 11).map((rule, index) => {
      const start = offset
      const share = index === 10 ? 1 - offset : rule.share
      offset += share
      return { rule, start, share, other: index === 10 && withTraffic.length > 11 }
    })
  })
  const percentage = (share: number) => percentFormat.format(share)

  function colorFor(id: string) {
    let color = assignedColors.get(id)
    if (!color) {
      color = PALETTE[assignedColors.size % PALETTE.length]
      assignedColors.set(id, color)
    }
    return color
  }

  function ruleName(rule: RuleTrafficStat) {
    return rule.payload || rule.type || t('rules.analytics.unknownRule')
  }

  function togglePause() {
    if (!paused) frozen = liveStats
    paused = !paused
  }
</script>

<section class="rules-analytics" aria-label={t('rules.analytics.title')}>
  <div class="analytics-toolbar">
    <div class="scope">
      <span class="led" data-on={online && !paused && connections.length > 0} data-state={!online ? 'down' : undefined}></span>
      <span>{t('rules.analytics.scope')}</span>
      <span class="scope-count num">{count(stats.totals.connections)}</span>
      {#if !online && ready}<span class="text-bad">{t('rules.analytics.offline')}</span>{/if}
      {#if paused}<span class="text-accent-ink">{t('rules.analytics.paused')}</span>{/if}
    </div>
    <button class="pause-button" onclick={togglePause} aria-pressed={paused} disabled={!ready}>
      {#if paused}<IconPlay size={14} strokeWidth={1.5} aria-hidden="true" />{:else}<IconPause size={14} strokeWidth={1.5} aria-hidden="true" />{/if}
      {t(paused ? 'rules.analytics.resume' : 'rules.analytics.pause')}
    </button>
  </div>

  <div class="analytics-grid">
    <section class="analytics-panel distribution" aria-labelledby="rules-distribution-heading">
      <h2 id="rules-distribution-heading">{t('rules.analytics.distribution')}</h2>
      <div class="donut-wrap">
        <svg class="donut" viewBox="0 0 200 200" role="img" aria-label={t('rules.analytics.distributionDescription', { total: bytes(stats.totals.total) })}>
          <circle class="donut-track" cx="100" cy="100" r="76" fill="none" stroke-width="23" />
          {#each segments as segment (segment.rule.id)}
            <circle cx="100" cy="100" r="76" fill="none" stroke={segment.other ? 'var(--chart-slate)' : colors[segment.rule.id]} stroke-width="23"
              stroke-dasharray="{Math.max(0, segment.share * CIRCUMFERENCE - (segments.length > 1 ? 2.8 : 0))} {CIRCUMFERENCE}"
              stroke-dashoffset={-segment.start * CIRCUMFERENCE} transform="rotate(-90 100 100)">
              <title>{segment.other ? t('rules.analytics.other') : ruleName(segment.rule)}: {percentage(segment.share)}</title>
            </circle>
          {/each}
        </svg>
        <div class="donut-center">
          <strong class="num">{bytes(stats.totals.total)}</strong>
          <span>{t('rules.analytics.totalTraffic')}</span>
        </div>
      </div>
      <div class="traffic-directions num">
        <span title={t('rules.analytics.download')}>↓ {bytes(stats.totals.download)}</span>
        <span title={t('rules.analytics.upload')}>↑ {bytes(stats.totals.upload)}</span>
      </div>
      <div class="legend" aria-label={t('rules.analytics.topRules')}>
        {#each stats.rules.slice(0, 4) as rule (rule.id)}
          <button class="legend-item" class:active={selected?.id === rule.id} aria-pressed={selected?.id === rule.id}
            onclick={() => selectedId = rule.id} title="{ruleName(rule)} · {rule.policy}">
            <span class="legend-dot" style:background={colors[rule.id]}></span>
            <span class="legend-name">{ruleName(rule)}</span>
            <span class="num">{percentage(rule.share)}</span>
          </button>
        {:else}
          <p class="empty-inline">{t(ready ? 'rules.analytics.noTraffic' : 'rules.analytics.waiting')}</p>
        {/each}
      </div>
    </section>

    <section class="analytics-panel ranking-panel" aria-labelledby="rules-ranking-heading">
      <div class="panel-heading">
        <h2 id="rules-ranking-heading"><IconRules size={16} strokeWidth={1.5} aria-hidden="true" />{t('rules.analytics.ruleList')}</h2>
        <span class="num panel-count">{count(stats.rules.length)}</span>
      </div>
      <div class="rule-ranking" role="region" aria-label={t('rules.analytics.ruleList')}>
        {#each stats.rules.slice(0, rankingLimit) as rule, index (rule.id)}
          <button class="ranked-rule" class:active={selected?.id === rule.id} aria-pressed={selected?.id === rule.id}
            style:--rule-color={colors[rule.id]} onclick={() => selectedId = rule.id}>
            <span class="rule-rank num">{count(index + 1)}</span>
            <span class="rule-info">
              <span class="rule-topline">
                <span class="rule-name" title={ruleName(rule)}>{ruleName(rule)}</span>
                <strong class="num">{bytes(rule.total)}</strong>
              </span>
              <span class="rule-subline" title="{rule.type} → {rule.policy}">{rule.type || t('rules.analytics.unknownRule')}<span aria-hidden="true"> → </span>{rule.policy || t('rules.analytics.unknownPolicy')}</span>
              <span class="rule-progress"><span style:transform="scaleX({Math.max(0, Math.min(1, rule.share))})"></span></span>
              <span class="rule-bottomline num">
                <span title={t('rules.analytics.download')}>↓ {bytes(rule.download)}</span>
                <span title={t('rules.analytics.upload')}>↑ {bytes(rule.upload)}</span>
                <span class="connection-count" title={t('rules.analytics.connections')}><IconConnections size={12} strokeWidth={1.5} aria-hidden="true" />{count(rule.connections)}</span>
                <span class="rule-percent">{percentage(rule.share)}</span>
              </span>
            </span>
          </button>
        {:else}
          <div class="panel-empty">
            <IconRules size={24} strokeWidth={1.25} aria-hidden="true" />
            <p>{t(ready ? 'rules.analytics.noTraffic' : 'rules.analytics.waiting')}</p>
            <span>{t('rules.analytics.noTrafficHint')}</span>
          </div>
        {/each}
        {#if stats.rules.length > rankingLimit}
          <button class="more-rules" onclick={() => rankingLimit += 50}>{t('rules.analytics.showMoreRules', { shown: rankingLimit, total: stats.rules.length })}</button>
        {/if}
      </div>
    </section>

    <section class="analytics-panel domains-panel" aria-labelledby="rules-domains-heading">
      <div class="panel-heading">
        <h2 id="rules-domains-heading"><IconGeography size={16} strokeWidth={1.5} aria-hidden="true" />{t('rules.analytics.topDomains')}</h2>
      </div>
      <p class="domain-selection" title={selected ? `${ruleName(selected)} → ${selected.policy}` : undefined}>
        {#if selected}<span class="legend-dot" style:background={colors[selected.id]}></span><span>{ruleName(selected)}</span>{:else}—{/if}
      </p>
      <div class="domain-chart">
        {#each domains as domain (domain.name)}
          <div class="domain-row" title="{domain.name} · {bytes(domain.total)} · ↓ {bytes(domain.download)} · ↑ {bytes(domain.upload)}">
            <span class="domain-name">{domain.name}</span>
            <div class="domain-bar-track"><span class="domain-bar" style:background={selected ? colors[selected.id] : 'var(--accent)'} style:transform="scaleX({domain.total / maxDomain})"></span></div>
            <span class="domain-value num">{bytes(domain.total)}</span>
          </div>
        {:else}
          <div class="panel-empty">
            <IconGeography size={24} strokeWidth={1.25} aria-hidden="true" />
            <p>{t('rules.analytics.noDomains')}</p>
            <span>{t('rules.analytics.noDomainsHint')}</span>
          </div>
        {/each}
      </div>
      {#if domains.length}
        <div class="domain-axis num"><span>0</span><span>{bytes(maxDomain / 2)}</span><span>{bytes(maxDomain)}</span></div>
      {/if}
    </section>
  </div>

  <RuleChainFlow chains={panorama ? stats.chains : selected?.chains ?? []} ruleNames={names} ruleColors={colors} {panorama} onpanorama={() => panorama = !panorama} />
</section>

<style>
  .rules-analytics { min-width: 0; }
  .analytics-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 16px; margin-bottom: 12px; }
  .scope { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text-2); font-size: 12px; }
  .scope-count { padding: 1px 7px; border: 1px solid var(--line); border-radius: 5px; font-family: var(--font-mono); }
  .pause-button { display: inline-flex; min-height: 44px; align-items: center; gap: 6px; padding: 0 10px; border-radius: 8px; color: var(--text-2); font-size: 12px; transition: background-color 150ms, color 150ms; }
  .pause-button:hover { background: var(--hover); color: var(--text); }
  .pause-button:disabled { opacity: .5; }
  .analytics-grid { display: grid; grid-template-columns: minmax(0, .82fr) minmax(0, 1.14fr) minmax(0, 1.24fr); gap: 16px; margin-bottom: 20px; }
  .analytics-panel { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--card); box-shadow: var(--shadow-panel); }
  h2 { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: var(--text-2); }
  .panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .panel-count { font-size: 12px; color: var(--text-3); font-family: var(--font-mono); }
  .donut-wrap { position: relative; width: min(100%, 206px); margin: 14px auto 0; aspect-ratio: 1; }
  .donut { display: block; width: 100%; height: 100%; }
  .donut-track { stroke: var(--raised); }
  .donut-center { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 5px; pointer-events: none; }
  .donut-center strong { font-size: clamp(18px, 1.6vw, 23px); line-height: 1.2; font-weight: 500; letter-spacing: -.03em; }
  .donut-center > span { font-size: 12px; color: var(--text-3); }
  .traffic-directions { display: flex; justify-content: center; flex-wrap: wrap; gap: 5px 12px; margin: 3px 0 15px; font-size: 11px; color: var(--text-2); font-family: var(--font-mono); }
  .legend { display: grid; gap: 3px; }
  .legend-item { display: flex; width: 100%; min-width: 0; min-height: 32px; align-items: center; gap: 7px; padding: 3px 5px; border-radius: 6px; color: var(--text-2); font-size: 12px; text-align: left; transition: background-color 150ms; }
  .legend-item:hover, .legend-item.active { background: var(--raised); color: var(--text); }
  .legend-item > .num { margin-left: auto; color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }
  .legend-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .legend-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rule-ranking { height: 352px; overflow-y: auto; margin: 16px -8px -4px; padding: 2px 8px 4px; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
  .more-rules { width: 100%; min-height: 44px; border-radius: 8px; color: var(--accent-ink); font-size: 12px; transition: background-color 150ms; }
  .more-rules:hover { background: var(--hover); }
  .ranked-rule { display: flex; width: 100%; min-width: 0; gap: 9px; padding: 12px 10px; margin-bottom: 8px; border: 1px solid var(--line); border-radius: 11px; text-align: left; transition: background-color 150ms, border-color 150ms; }
  .ranked-rule:hover { background: var(--hover); }
  .ranked-rule.active { border-color: var(--selected-border); background: var(--selected); }
  .rule-rank { display: flex; width: 20px; height: 20px; flex: none; align-items: center; justify-content: center; border-radius: 5px; background: var(--raised); color: var(--text-3); font-size: 11px; font-family: var(--font-mono); }
  .ranked-rule.active .rule-rank { color: var(--selected-text); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .rule-info { min-width: 0; flex: 1; }
  .rule-topline { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .rule-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
  .rule-topline strong { font-size: 12px; font-weight: 500; white-space: nowrap; }
  .rule-subline { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; color: var(--text-3); font-size: 11px; }
  .rule-progress { display: block; height: 4px; overflow: hidden; margin: 8px 0 6px; border-radius: 2px; background: var(--raised); }
  .rule-progress > span { display: block; height: 100%; background: var(--rule-color); transform-origin: left; }
  .rule-bottomline { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 8px; color: var(--text-2); font-size: 10px; line-height: 16px; font-family: var(--font-mono); }
  .connection-count { display: inline-flex; align-items: center; gap: 3px; color: var(--text-3); }
  .rule-percent { margin-left: auto; color: var(--text-3); }
  .domain-selection { display: flex; align-items: center; gap: 6px; margin-top: 12px; color: var(--text-2); font-size: 12px; }
  .domain-selection > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .domain-chart { display: grid; gap: 10px; margin-top: 20px; min-height: 274px; align-content: start; }
  .domain-row { display: grid; grid-template-columns: minmax(58px, .7fr) minmax(32px, 1fr) 62px; gap: 9px; align-items: center; min-width: 0; }
  .domain-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-2); }
  .domain-bar-track { min-width: 0; height: 18px; background: var(--raised); border-radius: 3px; overflow: hidden; }
  .domain-bar { display: block; width: 100%; height: 100%; transform-origin: left; border-radius: 3px; opacity: .9; }
  .domain-value { font-family: var(--font-mono); color: var(--text-2); font-size: 10px; white-space: nowrap; text-align: right; }
  .domain-axis { display: flex; justify-content: space-between; gap: 8px; margin-top: 12px; padding-left: calc((100% - 80px) * .41); padding-right: 71px; color: var(--text-3); font-family: var(--font-mono); font-size: 10px; white-space: nowrap; }
  .panel-empty { display: flex; min-height: 270px; height: 100%; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; color: var(--text-3); }
  .panel-empty p { font-size: 13px; color: var(--text-2); }
  .panel-empty > span { max-width: 230px; font-size: 12px; }
  .empty-inline { padding: 12px 0; font-size: 12px; text-align: center; color: var(--text-3); }
  @media (min-width: 768px) and (max-width: 1199px) {
    .analytics-grid { grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); }
    .domains-panel { grid-column: 1 / -1; }
    .domain-chart { min-height: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; }
    .domain-axis { display: none; }
  }
  @media (max-width: 767px) {
    .analytics-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .analytics-panel { padding: 18px; }
    .rule-ranking { height: 320px; }
    .domain-chart { min-height: 0; }
    .panel-empty { min-height: 170px; }
    .legend-item { min-height: 44px; }
    .donut-wrap { width: 200px; }
    .donut-center strong { font-size: 23px; }
    .domain-row { grid-template-columns: minmax(66px, .8fr) minmax(35px, 1fr) 64px; }
  }
</style>
