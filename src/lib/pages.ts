import type { Component } from 'svelte'
import type { Route } from './core.svelte'

// Literal imports let Vite split pages and their heavy dependencies into chunks.
export const pages = {
  overview: () => import('../pages/Overview.svelte'),
  proxies: () => import('../pages/Proxies.svelte'),
  connections: () => import('../pages/Connections.svelte'),
  devices: () => import('../pages/Devices.svelte'),
  analysis: () => import('../pages/Analysis.svelte'),
  geography: () => import('../pages/Geography.svelte'),
  rules: () => import('../pages/Rules.svelte'),
  logs: () => import('../pages/Logs.svelte'),
  settings: () => import('../pages/Settings.svelte'),
  setup: () => import('../pages/Setup.svelte'),
} satisfies Record<Route, () => Promise<{ default: Component }>>
