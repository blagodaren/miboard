<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { request, errorMessage, type Backend } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { t } from '../lib/i18n.svelte'
  import { parseSiteUrls, runSiteChecks, siteCheckPath, siteTargetKey, SITE_NODE_LIMIT, type SiteCell, type SiteTarget } from '../lib/site-checks'
  import Button from './Button.svelte'
  import DomainDiagnostics from './DomainDiagnostics.svelte'

  let { backend, targets, initialUrl, disabled = false, onrunning, oncomplete }: { backend: Backend; targets: SiteTarget[]; initialUrl: string; disabled?: boolean; onrunning: (value: boolean) => void; oncomplete: () => void } = $props()
  let input = $state(untrack(() => initialUrl))
  let selected = $state<string[]>([])
  let filter = $state('')
  let timeout = $state<number | undefined>(5000)
  let busy = $state(false)
  let issue = $state<'invalidUrls' | 'invalidNodes' | 'invalidTimeout' | null>(null)
  let cells = $state.raw<SiteCell[]>([])
  let diagnosticHost = $state('')
  let diagnosticRequest = $state(0)
  let runUrls = $state<string[]>([])
  let runTargets = $state<SiteTarget[]>([])
  let alive = true
  let controller: AbortController | null = null
  const available = $derived(targets.filter(target => `${target.name} ${target.provider ?? ''}`.toLowerCase().includes(filter.toLowerCase())))
  const chosen = $derived(targets.filter(target => selected.includes(siteTargetKey(target))))
  const completed = $derived(cells.filter(cell => ['done', 'failed', 'cancelled'].includes(cell.state)).length)
  const inputClass = 'min-h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-3 text-[13px]'
  const current = () => alive && core.backend.url === backend.url && core.backend.secret === backend.secret
  const targetLabel = (target: SiteTarget) => target.provider ? `${target.name} · ${target.provider}` : target.name
  function choose(target: SiteTarget, checked: boolean) {
    const key = siteTargetKey(target)
    selected = checked ? [...new Set([...selected, key])].slice(0, SITE_NODE_LIMIT) : selected.filter(value => value !== key)
  }
  async function start() {
    if (busy || disabled || !current()) return
    let urls: string[]
    try { urls = parseSiteUrls(input) } catch { issue = 'invalidUrls'; return }
    if (!chosen.length || chosen.length > SITE_NODE_LIMIT) { issue = 'invalidNodes'; return }
    if (!Number.isInteger(timeout) || timeout! < 100 || timeout! > 30000) { issue = 'invalidTimeout'; return }
    issue = null; busy = true; onrunning(true)
    runUrls = urls; runTargets = chosen.map(target => ({ ...target })); cells = []
    const abort = new AbortController(); controller = abort
    try {
      await runSiteChecks(urls, runTargets, timeout!, (target, url, duration, signal) => {
        if (!current()) { abort.abort(); signal.throwIfAborted() }
        return request<{ delay: number }>(siteCheckPath(target), { query: { url, timeout: duration }, timeout: duration + 2000, signal }, backend)
      }, abort.signal, value => { if (current()) cells = value })
    } finally {
      if (alive) { busy = false; onrunning(false); if (current()) oncomplete() }
      if (controller === abort) controller = null
    }
  }
  function inspect(url: string) { diagnosticHost = new URL(url).hostname; diagnosticRequest++ }
  const result = (url: string, target: SiteTarget) => cells.find(cell => cell.url === url && siteTargetKey(cell.target) === siteTargetKey(target))
  onDestroy(() => { alive = false; controller?.abort(); onrunning(false) })
</script>

<details class="mb-4 min-w-0 rounded-panel border border-line bg-card" data-testid="site-checks">
  <summary class="min-h-11 cursor-pointer px-4 py-3 text-[13px] font-medium">{t('sites.title')}</summary>
  <div class="space-y-4 border-t border-line p-4">
    <p class="text-xs leading-5 text-fg-3">{t('sites.hint')}</p>
    <form class="space-y-4" onsubmit={event => { event.preventDefault(); void start() }}>
      <label class="block text-xs text-fg-2">{t('sites.urls')}<textarea class={inputClass + ' mt-1 py-2 font-mono'} rows="3" bind:value={input} disabled={busy} maxlength="10245" required aria-invalid={issue === 'invalidUrls'} data-testid="site-urls"></textarea></label>
      <fieldset disabled={busy || disabled} class="min-w-0"><legend class="mb-2 text-xs text-fg-2">{t('sites.nodes')}</legend>
        <label class="block text-xs text-fg-2">{t('sites.search')}<input type="search" class={inputClass + ' mt-1'} bind:value={filter} /></label>
        <div class="mt-2 grid max-h-52 grid-cols-1 gap-x-4 overflow-y-auto sm:grid-cols-2">
          {#each available as target (siteTargetKey(target))}<label class="flex min-h-11 min-w-0 items-center gap-2 text-xs"><input type="checkbox" class="size-4 shrink-0 accent-[var(--accent-ink)]" checked={selected.includes(siteTargetKey(target))} disabled={chosen.length >= SITE_NODE_LIMIT && !selected.includes(siteTargetKey(target))} onchange={event => choose(target, event.currentTarget.checked)} /><span class="min-w-0 break-words">{targetLabel(target)}</span></label>{/each}
        </div>
        {#if !targets.length}<p class="text-xs text-fg-3">{t('sites.empty')}</p>{/if}
        <div class="mt-2 flex flex-wrap items-center gap-3"><span class="text-xs text-fg-3" role="status">{t('sites.selection', { count: chosen.length })}</span><Button type="button" size="sm" variant="ghost" onclick={() => selected = []}>{t('sites.clear')}</Button></div>
      </fieldset>
      <div class="flex flex-wrap items-end gap-3"><label class="max-w-44 text-xs text-fg-2">{t('sites.timeout')}<input class={inputClass + ' mt-1'} type="number" min="100" max="30000" step="100" bind:value={timeout} required disabled={busy} aria-invalid={issue === 'invalidTimeout'} /></label>
        {#if busy}<Button type="button" size="sm" onclick={() => controller?.abort()}>{t('sites.cancel')}</Button>{:else}<Button type="submit" size="sm" disabled={disabled || !targets.length}>{t('sites.start')}</Button>{/if}
      </div>
      {#if issue}<p class="text-xs text-bad" role="alert">{t(`sites.${issue}`)}</p>{/if}
    </form>
    {#if cells.length}
      <p class="text-xs text-fg-2" role="status">{t('sites.progress', { done: completed, total: cells.length })}</p>
      <div class="isolate max-h-96 overflow-auto rounded-control border border-line"><table class="w-full border-collapse text-xs" data-testid="site-results"><thead><tr><th class="sticky top-0 left-0 z-20 min-w-28 bg-card p-3 text-left font-medium sm:min-w-40">{t('sites.node')}</th>{#each runUrls as url}<th class="sticky top-0 z-10 min-w-44 max-w-64 break-all bg-card p-3 text-left font-normal"><span>{url}</span><button type="button" class="mt-2 block min-h-11 text-accent-ink underline" onclick={() => inspect(url)}>{t('sites.inspect')}</button></th>{/each}</tr></thead><tbody>{#each runTargets as target (siteTargetKey(target))}<tr class="border-t border-line"><th class="sticky left-0 z-0 min-w-28 max-w-56 break-words bg-card p-3 text-left font-normal sm:min-w-40">{targetLabel(target)}</th>{#each runUrls as url}{@const cell = result(url, target)}<td class="p-3 font-mono" title={cell?.error ? errorMessage(cell.error) : ''}>{#if cell?.state === 'done'}{t('sites.done', { delay: cell.delay! })}{:else}{t(`sites.${cell?.state ?? 'pending'}`)}{/if}</td>{/each}</tr>{/each}</tbody></table></div>
      <p class="text-xs leading-5 text-fg-3">{t('sites.dnsHint')}</p>
    {/if}
    {#if diagnosticHost}<DomainDiagnostics initialHost={diagnosticHost} requestId={diagnosticRequest} onclose={() => diagnosticHost = ''} />{/if}
  </div>
</details>
