<script lang="ts">
  import PageHeader from '../components/PageHeader.svelte'
  import CoreFleet from '../components/CoreFleet.svelte'
  import { t } from '../lib/i18n.svelte'
</script>

<PageHeader title={t('nav.fleet')} />
<CoreFleet />
