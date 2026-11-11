import { ConnectionJournal, type JournalRetention } from './connection-journal'
import type { Connection } from './api'
export type { JournalEntry, JournalRetention } from './connection-journal'

class ReactiveConnectionJournal {
  #journal = new ConnectionJournal()
  #revision = $state(0)
  constructor() {
    this.#journal.subscribe(() => { this.#revision++ })
    // Retention still expires while the controller is offline.
    setInterval(() => this.#journal.prune(), 60000)
    // Backgrounding is usually observable before a mobile browser suspends or
    // closes the document. pagehide also covers navigation and the back cache.
    document.addEventListener('visibilitychange', () => { if (document.hidden) void this.#journal.flush() })
    window.addEventListener('pagehide', () => { void this.#journal.flush() })
  }
  get entries() { this.#revision; return this.#journal.entries }
  get backendUrl() { this.#revision; return this.#journal.backendUrl }
  get retention() { this.#revision; return this.#journal.retention }
  get loading() { this.#revision; return this.#journal.loading }
  get storageState() { this.#revision; return this.#journal.storageState }
  activateBackend(url: string) { return this.#journal.activateBackend(url) }
  observe(connections: readonly Connection[], now?: number) { this.#journal.observe(connections, now) }
  pause(reset = false) { this.#journal.pause(reset) }
  setRetention(value: JournalRetention) { this.#journal.setRetention(value) }
  clear() { this.#journal.clear() }
  flush() { return this.#journal.flush() }
}

export const connectionJournal = new ReactiveConnectionJournal()
