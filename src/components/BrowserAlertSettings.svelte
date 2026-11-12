<script lang="ts">
  import { onMount } from 'svelte'
  import Button from './Button.svelte'
  import Toggle from './Toggle.svelte'
  import { t } from '../lib/i18n.svelte'
  import { browserNotificationsAvailable, loadBrowserAlertPreferences, saveBrowserAlertPreferences, subscribeBrowserAlertPreferences, sameBrowserAlertPreferences, showBrowserNotification, type BrowserAlertPreferences } from '../lib/browser-alerts'
  let preferences = $state(loadBrowserAlertPreferences())
  let permission = $state(typeof Notification === 'undefined' ? 'default' : Notification.permission)
  let busy = $state(false), failed = $state(false), saved = $state(true)
  const available = browserNotificationsAvailable()
  const enabled = $derived(preferences.enabled && permission === 'granted')
  onMount(() => {
    const unsubscribe = subscribeBrowserAlertPreferences((next, stored) => { if (!sameBrowserAlertPreferences(preferences, next)) preferences = next; saved = stored })
    const refresh = () => { permission = typeof Notification === 'undefined' ? 'default' : Notification.permission }
    window.addEventListener('focus', refresh)
    return () => { unsubscribe(); window.removeEventListener('focus', refresh) }
  })
  function change(key: keyof BrowserAlertPreferences, value: boolean) {
    saved = saveBrowserAlertPreferences({ ...preferences, [key]: value })
  }
  async function enable() {
    if (!available || busy) return
    busy = true; failed = false
    try { permission = await Notification.requestPermission(); if (permission === 'granted') change('enabled', true) }
    catch { failed = true }
    finally { busy = false }
  }
  async function test() {
    if (busy) return
    busy = true; failed = !await showBrowserNotification(t('panelTools.testTitle'), t('panelTools.testBody'), 'miboard-test', '#/settings?category=maintenance'); busy = false
  }
</script>

<section class="rounded-panel border border-line bg-card p-4 sm:p-5" data-testid="browser-alert-settings">
  <h2 class="font-medium">{t('panelTools.alertTitle')}</h2>
  <p class="mt-2 max-w-3xl text-[13px] leading-6 text-fg-3">{t('panelTools.alertHint')}</p>
  <div class="my-4 flex flex-wrap items-center gap-3">
    <Button size="sm" disabled={!available || busy} onclick={() => enabled ? change('enabled', false) : void enable()}>{t(enabled ? 'panelTools.alertDisable' : 'panelTools.alertEnable')}</Button>
    <Button size="sm" disabled={!enabled || busy} onclick={test}>{t('panelTools.alertTest')}</Button>
    <span class="text-xs text-fg-3" role="status">{t(enabled ? 'panelTools.alertOn' : 'panelTools.alertOff')}</span>
  </div>
  <div class="flex flex-col gap-3">
    <div class="flex min-h-11 items-center justify-between gap-4 text-[13px]"><span>{t('panelTools.alertNodes')}</span><Toggle label={t('panelTools.alertNodes')} checked={preferences.nodes} onchange={value => change('nodes', value)} /></div>
    <div class="flex min-h-11 items-center justify-between gap-4 text-[13px]"><span>{t('panelTools.alertCore')}</span><Toggle label={t('panelTools.alertCore')} checked={preferences.core} onchange={value => change('core', value)} /></div>
    <div class="flex min-h-11 items-center justify-between gap-4 text-[13px]"><span>{t('panelTools.alertSubscriptions')}</span><Toggle label={t('panelTools.alertSubscriptions')} checked={preferences.subscriptions} onchange={value => change('subscriptions', value)} /></div>
  </div>
  {#if !available || permission === 'denied' || failed}<p class="mt-3 text-[13px] text-warning" role="status">{t(!available ? 'panelTools.alertUnavailable' : permission === 'denied' ? 'panelTools.alertDenied' : 'panelTools.alertError')}</p>{/if}
  {#if !saved}<p class="mt-3 text-[13px] text-warning" role="status">{t('panelTools.alertUnsaved')}</p>{/if}
</section>
