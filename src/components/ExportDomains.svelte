<script lang="ts">
  import IconDownload from '@lucide/svelte/icons/download'
  import Button from './Button.svelte'
  import { domainExport } from '../lib/domain-export'
  import { t } from '../lib/i18n.svelte'

  let { domains, name = '', testId = 'export-domains' }: { domains: readonly unknown[]; name?: string; testId?: string } = $props()
  const file = $derived(domainExport(domains, name))
  let failed = $state(false)
  function download() {
    if (!file.domains.length) return
    failed = false
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = file.filename
      document.body.append(link)
      link.click()
      link.remove()
    } catch { failed = true }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000) }
  }
</script>

<div class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
  <Button size="sm" onclick={download} disabled={!file.domains.length} data-testid={testId} title={t('traffic.exportHint', { count: file.domains.length })}>
    <IconDownload strokeWidth={1.5} aria-hidden="true" />{t('traffic.export')}
  </Button>
  {#if failed}<span class="text-xs text-bad" role="alert">{t('traffic.exportError')}</span>{/if}
</div>
