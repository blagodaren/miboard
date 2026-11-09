<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import { api, errorMessage, type DnsResponse } from '../lib/api'
  import { core } from '../lib/core.svelte'
  import { connectionJournal } from '../lib/connection-journal.svelte'
  import { diagnosticRoute, domainObservations, dnsQueryName, dnsRecords, dnsRecordType, dnsQuestions, dnsFlags, DNS_QUERY_TYPES, type DnsQueryType, type DnsSection } from '../lib/domain-diagnostics'
  import { t, i18n } from '../lib/i18n.svelte'
  import { bytes } from '../lib/format'
  import Button from './Button.svelte'

  let { initialHost = '', requestId = 0, onclose }: { initialHost?: string; requestId?: number; onclose: () => void } = $props()
  const backend = { ...core.backend }
  type DNSResult = { type: DnsQueryType; state: 'pending' | 'done' | 'error' | 'cancelled'; answer?: DnsResponse; error?: unknown }
  const sections: { name: DnsSection; label: 'dns.inspector.answer' | 'dns.inspector.authority' | 'dns.inspector.additional' }[] = [
    { name: 'Answer', label: 'dns.inspector.answer' }, { name: 'Authority', label: 'dns.inspector.authority' }, { name: 'Additional', label: 'dns.inspector.additional' },
  ]
  let queryType = $state<DnsQueryType | 'A+AAAA'>('A+AAAA')
  let reverse = $state(false)
  let input = $state('')
  let host = $state('')
  let field: HTMLInputElement
  let invalid = $state(false)
  let busy = $state(false)
  let cancelled = $state(false)
  let checkedAt = $state<number | null>(null)
  let dns = $state.raw<DNSResult[]>([])
  let visibleCount = $state(5)
  let controller: AbortController | null = null
  let generation = 0
  let alive = true
  const current = () => alive && core.backend.url === backend.url && core.backend.secret === backend.secret
  const observed = $derived(host ? domainObservations(host, core.conns,
    connectionJournal.backendUrl === backend.url ? connectionJournal.entries : [], Date.now()) : [])
  const dateTime = (time: number) => new Date(time).toLocaleString(i18n.intlLocale)

  $effect(() => {
    const value = initialHost
    void requestId
    untrack(() => {
      input = value
      queryType = 'A+AAAA'
      void tick().then(() => { if (alive) field?.focus() })
      if (value) void check()
    })
  })

  function cancel() {
    generation++
    controller?.abort()
    controller = null
    busy = false
    cancelled = true
    dns = dns.map(result => result.state === 'pending' ? { ...result, state: 'cancelled' } : result)
  }

  async function check() {
    const normalized = dnsQueryName(input, queryType)
    invalid = !normalized
    if (!normalized || !current()) return
    controller?.abort()
    const run = ++generation
    const abort = new AbortController()
    controller = abort
    host = normalized
    reverse = queryType === 'PTR'
    input = normalized
    visibleCount = 5
    checkedAt = null
    busy = true
    cancelled = false
    const types: DnsQueryType[] = queryType === 'A+AAAA' ? ['A', 'AAAA'] : [queryType]
    dns = types.map(type => ({ type, state: 'pending' }))
    await Promise.all(dns.map(async ({ type }) => {
      let result: DNSResult
      try {
        const answer = await api.dnsQuery(normalized, type, backend, abort.signal)
        if (!answer || !Number.isInteger(answer.Status) || answer.Status < 0) throw new Error(t('diagnostics.invalidResponse'))
        result = { type, state: 'done', answer }
      } catch (error) {
        result = { type, state: 'error', error }
      }
      if (current() && run === generation && !abort.signal.aborted) dns = dns.map(value => value.type === type ? result : value)
    }))
    if (!current() || run !== generation || abort.signal.aborted) return
    checkedAt = Date.now()
    busy = false
    controller = null
  }

  onDestroy(() => { alive = false; generation++; controller?.abort() })
</script>

<section id="domain-diagnostics" class="mb-6 rounded-panel border border-line bg-card p-4 sm:p-5" aria-labelledby="domain-diagnostics-heading">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div><h2 id="domain-diagnostics-heading" class="font-medium">{t('diagnostics.title')}</h2><p class="mt-1 text-[13px] text-fg-2">{t('diagnostics.description')}</p></div>
    <Button size="sm" variant="ghost" onclick={onclose}>{t('diagnostics.close')}</Button>
  </div>
  <form class="mt-4" onsubmit={(event) => { event.preventDefault(); void check() }}>
    <label class="mb-2 block text-[13px]" for="diagnostic-domain">{t('dns.inspector.input')}</label>
    <div class="flex flex-wrap gap-2">
      <input bind:this={field} bind:value={input} id="diagnostic-domain" class="h-11 min-w-0 flex-1 basis-52 rounded-control border border-field-border bg-field px-3 font-mono text-[13px]" placeholder={t('diagnostics.placeholder')} maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" aria-invalid={invalid} aria-describedby={invalid ? 'diagnostic-domain-error' : undefined} oninput={() => invalid = false} />
      <select class="h-11 max-w-full rounded-control border border-field-border bg-field px-3 font-mono text-[13px]" aria-label={t('dns.inspector.type')} bind:value={queryType} disabled={busy} onchange={() => invalid = false} data-testid="dns-query-type">
        <option value="A+AAAA">{t('dns.inspector.addresses')}</option>
        {#each DNS_QUERY_TYPES as type}<option value={type}>{type}</option>{/each}
      </select>
      <Button variant="primary" type="submit" disabled={busy}>{t(busy ? 'diagnostics.checking' : 'diagnostics.check')}</Button>
      {#if busy}<Button type="button" onclick={cancel}>{t('diagnostics.cancel')}</Button>{/if}
    </div>
    {#if invalid}<p id="diagnostic-domain-error" class="mt-2 text-[13px] text-bad" role="alert">{t('dns.inspector.invalid')}</p>{/if}
  </form>

  {#if host}
    <div class="mt-5 flex flex-wrap items-baseline justify-between gap-2">
      <h3 class="min-w-0 break-all font-mono text-[13px]">{t('diagnostics.result', { host })}</h3>
      <span class="text-xs text-fg-3" role="status">{t(busy ? 'diagnostics.checking' : cancelled ? 'diagnostics.cancelled' : 'diagnostics.ready')}</span>
    </div>
    <div class="mt-3 grid gap-3 {dns.length > 1 ? 'sm:grid-cols-2' : ''}">
      {#each dns as result (result.type)}
        <section class="min-w-0 rounded-card border border-line bg-raised p-4" aria-label={`DNS ${result.type}`}>
          <h4 class="font-mono text-[13px] font-medium">{result.type}</h4>
          {#if result.state === 'pending' || result.state === 'cancelled'}
            <p class="mt-2 text-[13px] text-fg-2">{t(result.state === 'pending' ? 'diagnostics.pending' : 'diagnostics.cancelled')}</p>
          {:else if result.state === 'error'}
            <p class="mt-2 break-words text-[13px] text-bad">{errorMessage(result.error)}</p>
          {:else if result.answer}
            {#if result.answer.Status !== 0}
              <p class="mt-2 text-[13px] text-bad">{t(result.answer.Status === 3 ? 'diagnostics.nxdomain' : 'diagnostics.dnsError', { code: result.answer.Status })}</p>
            {:else if !dnsRecords(result.answer).length}
              <p class="mt-2 text-[13px] text-fg-2">{t('diagnostics.emptyDns')}</p>
            {/if}
            {#if dnsQuestions(result.answer).length}
              <div class="mt-3 border-t border-line pt-3" data-testid="dns-question">
                <h5 class="text-xs text-fg-3">{t('dns.inspector.question')}</h5>
                {#each dnsQuestions(result.answer) as question, index (index)}<p class="mt-1 break-all font-mono text-xs">{question.Name} · {dnsRecordType(question.Qtype)} · {question.Qclass === 1 ? 'IN' : question.Qclass}</p>{/each}
              </div>
            {/if}
            {#each sections as section (section.name)}
              {@const records = dnsRecords(result.answer, section.name)}
              {#if records.length}
                <section class="mt-3 border-t border-line pt-3" aria-label={t(section.label)} data-testid={`dns-section-${section.name}`}>
                  <h5 class="text-xs font-medium text-fg-2">{t(section.label)}</h5>
                  <ul class="mt-2 max-h-60 space-y-3 overflow-auto">
                    {#each records as record, index (index)}
                      <li class="text-xs"><div class="break-all font-mono">{record.data}</div><div class="mt-1 break-all font-mono text-fg-3">{record.name}</div><div class="mt-1 flex flex-wrap gap-x-3 text-fg-3"><span>{dnsRecordType(record.type)}</span><span>{t('diagnostics.ttl', { seconds: record.TTL })}</span></div></li>
                    {/each}
                  </ul>
                  {#if (result.answer[section.name]?.length ?? 0) > 100}<p class="mt-2 text-xs text-fg-3">{t('diagnostics.recordsLimited')}</p>{/if}
                </section>
              {/if}
            {/each}
            {#if dnsFlags(result.answer).length}
              <dl class="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-3 font-mono text-xs" aria-label={t('dns.inspector.flags')} data-testid="dns-flags">
                {#each dnsFlags(result.answer) as flag (flag.name)}<div class="flex gap-1"><dt class="text-fg-3">{flag.name}</dt><dd>{t(flag.value ? 'dns.inspector.flagOn' : 'dns.inspector.flagOff')}</dd></div>{/each}
              </dl>
            {/if}
          {/if}
        </section>
      {/each}
    </div>
    <p class="mt-3 text-xs leading-5 text-fg-3">{t('diagnostics.dnsNote')}{#if checkedAt}<span class="mt-1 block">{t('diagnostics.dnsAt', { time: dateTime(checkedAt) })}</span>{/if}</p>
    <p class="mt-1 text-xs leading-5 text-fg-3">{t('dns.inspector.note')}</p>

    {#if reverse}
      <p class="mt-5 text-[13px] leading-5 text-fg-2">{t('dns.inspector.ptrNote')}</p>
    {:else}
    <h3 class="mt-5 text-[13px] font-medium">{t('diagnostics.observed')}</h3>
    {#if observed.length}
      <ol class="mt-3 space-y-3">
        {#each observed.slice(0, visibleCount) as item (item.key)}
          {@const connection = item.connection}
          {@const path = diagnosticRoute(connection)}
          <li class="rounded-card border border-line p-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
              <span class={item.source === 'active' && core.connectionsOnline ? 'text-good' : 'text-fg-2'}>{t(item.source === 'closed' ? 'diagnostics.closed' : core.connectionsOnline ? 'diagnostics.active' : 'diagnostics.stale')}</span>
              <span class="font-mono text-fg-3">{connection.metadata.network} · {bytes(connection.download + connection.upload)}</span>
            </div>
            <dl class="mt-3 grid gap-3 text-xs sm:grid-cols-2">
              <div class="min-w-0"><dt class="text-fg-3">{t('diagnostics.rule')}</dt><dd class="mt-1 break-all font-mono">{connection.rule ? `${connection.rule}${connection.rulePayload ? ' · ' + connection.rulePayload : ''}` : t('diagnostics.noRule')}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('diagnostics.route')}</dt><dd class="mt-1 break-all font-mono">{path.length ? path.join(' → ') : t('diagnostics.noRoute')}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('diagnostics.device')}</dt><dd class="mt-1 break-all font-mono">{connection.metadata.sourceIP || '—'}</dd></div>
              <div class="min-w-0"><dt class="text-fg-3">{t('diagnostics.destination')}</dt><dd class="mt-1 break-all font-mono">{connection.metadata.destinationIP || '—'}{connection.metadata.destinationPort ? ` · ${connection.metadata.destinationPort}` : ''}</dd></div>
              {#if connection.metadata.process}<div class="min-w-0"><dt class="text-fg-3">{t('diagnostics.process')}</dt><dd class="mt-1 break-all font-mono">{connection.metadata.process}</dd></div>{/if}
            </dl>
            {#if item.source === 'closed'}<p class="mt-3 text-xs text-fg-3">{t('diagnostics.lastSeen', { time: dateTime(item.observedAt) })}{#if item.afterGap} · {t('diagnostics.afterGap')}{/if}</p>{/if}
          </li>
        {/each}
      </ol>
      {#if observed.length > visibleCount}<Button class="mt-3" size="sm" onclick={() => visibleCount += 10}>{t('diagnostics.more')}</Button>{/if}
      <p class="mt-3 text-xs text-fg-3">{t('diagnostics.limit')}</p>
    {:else}
      <div class="mt-3 rounded-card border border-line p-4"><p class="text-[13px] text-fg-2">{t('diagnostics.noObservation')}</p><p class="mt-2 text-xs leading-5 text-fg-3">{t('diagnostics.noObservationHint')}</p></div>
    {/if}
    {/if}
  {/if}
</section>
