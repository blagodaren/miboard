<script lang="ts">
  import { api } from '../lib/api'
  import { core, type ConnRow } from '../lib/core.svelte'
  import { bytes, speed, since, count } from '../lib/format'
  import { t, i18n } from '../lib/i18n.svelte'
  import { IconClose, IconPause, IconPlay } from '../lib/icons'
  import PageHeader from '../components/PageHeader.svelte'
  import Button from '../components/Button.svelte'
  import SearchInput from '../components/SearchInput.svelte'
  import Confirm from '../components/Confirm.svelte'

  type SortKey = 'rate' | 'total' | 'start' | 'host'
  const LIMIT = 300

  let query = $state('')
  let paused = $state(false)
  let frozen = $state.raw<ConnRow[]>([])
  let sort = $state<SortKey>('rate')
  let confirmAll = $state(false)
  let now = $state(Date.now())

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(t)
  })

  function togglePause() {
    paused = !paused
    if (paused) frozen = core.conns
  }

  const host = (c: ConnRow) => c.metadata.host || c.metadata.sniffHost || c.metadata.destinationIP
  const chain = (c: ConnRow) => [...c.chains].reverse().join(' / ')

  const rows = $derived.by(() => {
    const src = paused ? frozen : core.conns
    const q = query.trim().toLowerCase()
    const list = q
      ? src.filter((c) =>
          [host(c), c.metadata.destinationIP, c.metadata.sourceIP, c.metadata.process ?? '', c.rule, c.rulePayload, ...c.chains]
            .join(' ')
            .toLowerCase()
            .includes(q),
        )
      : [...src]
    const by: Record<SortKey, (a: ConnRow, b: ConnRow) => number> = {
      rate: (a, b) => b.dl + b.ul - (a.dl + a.ul) || b.download - a.download,
      total: (a, b) => b.download + b.upload - (a.download + a.upload),
      start: (a, b) => b.start.localeCompare(a.start),
      host: (a, b) => host(a).localeCompare(host(b), i18n.intlLocale),
    }
    return list.sort(by[sort])
  })

  async function close(id: string) {
    try {
      await api.closeConnection(id)
    } catch {
      /* соединение уже закрылось само */
    }
  }

  const th = 'px-3 py-2 font-normal text-xs text-fg-3 whitespace-nowrap'
</script>

{#snippet sortHead(key: SortKey, label: string, right = false)}
  <th class="{th} {right ? 'text-right' : 'text-left'}" aria-sort={sort === key ? 'descending' : 'none'}>
    <button class="transition-colors hover:text-fg {sort === key ? 'text-fg' : ''}" onclick={() => (sort = key)}>{label}</button>
  </th>
{/snippet}

<PageHeader title={t('connections.title')} meta={t('connections.meta', { shown: count(rows.length), total: count(core.conns.length) }) + (paused ? t('connections.paused') : '')}>
  {#snippet actions()}
    <SearchInput bind:value={query} placeholder={t('connections.search')} />
    <Button size="sm" onclick={togglePause} aria-pressed={paused}>
      {#if paused}<IconPlay strokeWidth={1.5} />{t('connections.resume')}{:else}<IconPause strokeWidth={1.5} />{t('connections.pause')}{/if}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => (confirmAll = true)} disabled={!core.conns.length}>{t('connections.closeAll')}</Button>
  {/snippet}
</PageHeader>

<div class="relative overflow-x-auto rounded-2xl border border-line bg-card">
  <table class="w-full min-w-[960px] text-[13px]">
    <thead>
      <tr>
        <th class="w-8 pl-4"><span class="sr-only">{t('connections.activity')}</span></th>
        {@render sortHead('host', t('connections.host'))}
        <th class="{th} text-left">{t('connections.rule')}</th>
        <th class="{th} text-left">{t('connections.chain')}</th>
        {@render sortHead('rate', t('connections.speed'), true)}
        {@render sortHead('total', t('connections.total'), true)}
        {@render sortHead('start', t('connections.time'), true)}
        <th class="w-12"><span class="sr-only">{t('connections.close')}</span></th>
      </tr>
    </thead>
    <tbody>
      {#each rows.slice(0, LIMIT) as c (c.id)}
        <tr class="group border-t border-line transition-colors hover:bg-hover">
          <td class="pl-4"><span class="led" data-on={c.dl + c.ul > 0} title={c.dl + c.ul > 0 ? t('connections.active') : t('connections.idle')}></span></td>
          <td class="max-w-[320px] px-3 py-2">
            <div class="truncate" title={host(c)}>{host(c)}<span class="text-fg-3">:{c.metadata.destinationPort}</span></div>
            <div class="mt-0.5 truncate font-mono text-xs text-fg-3">
              {c.metadata.network} · {c.metadata.process || c.metadata.sourceIP}
            </div>
          </td>
          <td class="max-w-[220px] px-3 py-2">
            <div class="truncate">{c.rule}</div>
            {#if c.rulePayload}<div class="mt-0.5 truncate font-mono text-xs text-fg-3" title={c.rulePayload}>{c.rulePayload}</div>{/if}
          </td>
          <td class="max-w-[240px] truncate px-3 py-2 text-fg-2" title={chain(c)}>{chain(c)}</td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
            <div class={c.dl ? 'text-fg' : 'text-fg-3'}>↓ {speed(c.dl)}</div>
            <div class="mt-0.5 text-fg-3">↑ {speed(c.ul)}</div>
          </td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
            <div class="text-fg-2">↓ {bytes(c.download)}</div>
            <div class="mt-0.5 text-fg-3">↑ {bytes(c.upload)}</div>
          </td>
          <td class="num whitespace-nowrap px-3 py-2 text-right font-mono text-xs text-fg-2">{since(c.start, now)}</td>
          <td class="pr-3 text-right">
            <button
              class="inline-flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-raised hover:text-fg"
              aria-label={t('connections.closeHost', { host: host(c) })}
              onclick={() => close(c.id)}
            >
              <IconClose class="size-4" strokeWidth={1.5} />
            </button>
          </td>
        </tr>
      {:else}
        <tr class="border-t border-line">
          <td colspan="8" class="px-4 py-8 text-center text-fg-3">{query ? t('connections.noResults') : t('connections.noConnections')}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if rows.length > LIMIT}
    <p class="border-t border-line px-4 py-3 font-mono text-xs text-fg-3">{t('connections.limit', { limit: count(LIMIT) })}</p>
  {/if}
</div>

<Confirm
  bind:open={confirmAll}
  title={t('connections.confirmTitle')}
  description={t('connections.confirmDescription', { count: core.conns.length, total: count(core.conns.length) })}
  action={t('connections.closeAll')}
  onconfirm={() => api.closeAll()}
/>
