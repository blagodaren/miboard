<script lang="ts">
  import PageHeader from '../components/PageHeader.svelte'
  import LongHistory from '../components/LongHistory.svelte'
  import { t } from '../lib/i18n.svelte'
</script>

<PageHeader title={t('nav.history')} />
<LongHistory />
