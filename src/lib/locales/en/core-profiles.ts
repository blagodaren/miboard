import type { Message } from '../../i18n-types'

export const en = {
  'coreProfiles.title': 'Memory profiles',
  'coreProfiles.hint': 'Download a snapshot for analysis with Go pprof. Available when the core was started with debug logging. Downloading does not change its settings.',
  'coreProfiles.heap': 'Download heap',
  'coreProfiles.allocs': 'Download allocations',
  'coreProfiles.busy': 'Downloading…',
  'coreProfiles.saved': 'Profile downloaded · {size}',
  'coreProfiles.unsupported': 'Profiles are unavailable. The core must support pprof and have been started with log-level: debug.',
  'coreProfiles.unauthorized': 'The core denied access to this profile. Check the connection credentials.',
  'coreProfiles.network': 'Could not download the profile. Check the connection and CORS settings.',
  'coreProfiles.timeout': 'The profile download timed out. Try again.',
  'coreProfiles.invalid': 'The core returned an unsupported profile format.',
  'coreProfiles.tooLarge': 'The profile exceeds the 32 MB download limit.',
  'coreProfiles.http': 'The core could not provide the profile. Try again.',
} satisfies Record<string, Message>
