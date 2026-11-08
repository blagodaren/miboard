import { DEFAULT_DELAY_SETTINGS, readDelaySettings, saveDelaySettings, type DelaySettings } from './latency'

class DelayPreferences {
  #value = $state<DelaySettings>(readDelaySettings())

  get value(): Readonly<DelaySettings> {
    return this.#value
  }

  set(value: DelaySettings): boolean {
    if (!saveDelaySettings(value)) return false
    this.#value = { ...value }
    return true
  }

  reset(): void {
    this.set({ ...DEFAULT_DELAY_SETTINGS })
  }
}

export const delaySettings = new DelayPreferences()
