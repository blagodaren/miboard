import type { Message } from '../../i18n-types'

export const en = {
  'liveUpdates.title': 'Live updates',
  'liveUpdates.mode': 'Background collection',
  'liveUpdates.realtime': 'Continuous',
  'liveUpdates.eco': 'Economy',
  'liveUpdates.hint': 'Applies to traffic, connections and core memory across all pages',
  'liveUpdates.realtimeHint': 'Continue collecting while this browser tab is open, including in the background',
  'liveUpdates.ecoHint': 'Pause collection while this tab is hidden. Resume when you return; history will contain gaps. Connections that start and end during a pause cannot be recorded',
  'liveUpdates.memory': 'Applied for this session. Browser storage is unavailable',
  'liveUpdates.paused': 'Economy mode: collection is paused while this tab is hidden',
  'liveUpdates.reconnecting': 'Restoring live updates. Values remain a snapshot until new data arrives',
  'liveUpdates.gap': 'This session contains gaps in observation. Traffic during a pause is not reconstructed; connection totals may include bytes transferred during the gap',
  'liveUpdates.dismiss': 'Dismiss the observation gap notice',
} satisfies Record<string, Message>
