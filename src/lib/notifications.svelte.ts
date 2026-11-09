import { NotificationCenter, type NotificationInput } from './notifications'

class Notifications {
  #center = new NotificationCenter()
  #revision = $state(0)
  constructor() { this.#center.subscribe(() => { this.#revision++ }) }
  get visible() { this.#revision; return this.#center.visible }
  get entries() { this.#revision; return this.#center.entries }
  show(input: NotificationInput) { return this.#center.show(input) }
  dismiss(id: string) { this.#center.dismiss(id) }
  clear() { this.#center.clear() }
  setVisibleLimit(limit: number) { this.#center.setVisibleLimit(limit) }
  dismissOtherScopes(scope: string) { this.#center.dismissOtherScopes(scope) }
  pause(id: string, reason: string) { this.#center.pause(id, reason) }
  resume(id: string, reason: string) { this.#center.resume(id, reason) }
  pauseAll(reason: string) { this.#center.pauseAll(reason) }
  resumeAll(reason: string) { this.#center.resumeAll(reason) }
}

export const notifications = new Notifications()
