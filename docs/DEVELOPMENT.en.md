# Developing MIBoard

[Русский](DEVELOPMENT.ru.md) · [English](DEVELOPMENT.en.md) · [README](../README.en.md) · [Features](FEATURES.en.md)

## Downloads

- [dist.zip](https://github.com/blagodaren/miboard/releases/download/v0.1.4/dist.zip) — the main archive. All fonts are included; loading them requires no external connection.
- [dist-cdn-fonts.zip](https://github.com/blagodaren/miboard/releases/download/v0.1.4/dist-cdn-fonts.zip) — an alternative archive without font files. Fonts are loaded from `unpkg.com`.

Each archive has a checksum:
[dist.zip.sha256](https://github.com/blagodaren/miboard/releases/download/v0.1.4/dist.zip.sha256)
and [dist-cdn-fonts.zip.sha256](https://github.com/blagodaren/miboard/releases/download/v0.1.4/dist-cdn-fonts.zip.sha256).

The CDN build needs access to `unpkg.com` to load fonts. If the CDN is unavailable,
the dashboard uses system fonts; colored flags may be unavailable on Windows.
Both archives have the same features and local GeoDB.

Font versions are pinned: Geist and Geist Mono `5.3.0`, and Twemoji Country Flags
from `country-flag-emoji-polyfill` `0.1.8`. The five exact URLs are listed in
[`scripts/font-sources.mjs`](../scripts/font-sources.mjs).

## Development

Requires **Node.js 24 or later**. Install dependencies with `npm ci`.
Node.js is not needed to run the built dashboard.

| Command | Purpose |
| --- | --- |
| `npm run mock` | Runs a mock mihomo API at `127.0.0.1:9090`, with secret `test`; serves `dist/` at `/ui/` |
| `npm run dev` | Runs Vite on `:5173`; connect to `http://127.0.0.1:9090` |
| `npm run check` / `npm test` | Checks types and runs all unit tests, including release packaging |
| `npm run test:ui` | Builds once, then checks UI scenarios, all ten screens, both themes and contrast against isolated mocks |
| `npm run release` | Checks types, runs unit tests, builds both variants, creates ZIPs and SHA-256 files, and verifies their contents |
| `node scripts/shots.mjs <dir> [dark\|light] [mobile]` | Captures screenshots of all screens using the mock |

Install Chromium before running UI checks: `npx playwright install chromium`.
For Linux CI, use `npx playwright install --with-deps chromium`.

Build the CDN variant separately with `npm run build:cdn-fonts`.
To check font loading and system-font fallback in both completed builds, run
`npm run test:fonts`.

To reproduce the README screenshots, first run `npm run build`, then
`node scripts/readme-screenshots.mjs`. The script uses synthetic data in an isolated
fixture and writes the images to `docs/images/`.

## Release 0.1.4

1. Run `npm run test:ui`. The checks use a local mock and do not connect
   to the user's controller.
2. Run `npm run release`. This creates `dist.zip`, `dist-cdn-fonts.zip`
   and their `.sha256` files in the repository root. Each archive has
   `index.html` at its root; each ZIP is limited to 10 MiB.
3. Run `npm run test:fonts` for both completed builds.
4. Push the verified source to `main` in `blagodaren/miboard`.
   Builds, archives, UI test screenshots, `node_modules/` and `.env*` are excluded from Git.
5. Create and push the `v0.1.4` tag. The workflow checks the tag against `package.json`,
   repeats validation and creates a GitHub release with both ZIPs and checksums.
   Versions without a suffix become `latest`; versions with a suffix remain prereleases.

For the next version, update `package.json`, synchronize the lockfile with
`npm install --package-lock-only`, and add an entry to `CHANGELOG.md`.
The version shown in the interface is read automatically from `package.json`.

To validate existing archives locally, run `npm run check:release` and
`npm run check:release:cdn-fonts`. Both commands compare the build version with
`package.json` to prevent publishing an old archive after a version bump.
Archives contain only the built dashboard, GeoDB and licenses, PWA manifest,
service worker, icons and version metadata. The main archive also contains
the font files. Source code, tests and development configuration are not included.

## Licenses

MIBoard code is distributed under the [MIT License](../LICENSE). Licenses for
the fonts, icon, Twemoji and bundled JavaScript dependencies are in
[`public/licenses/`](../public/licenses/); dependency notices are updated
automatically during the build. The DB-IP Country Lite GeoDB uses
[CC BY 4.0](../public/geodb/NOTICE.md), and the map outlines are in the
[public domain](../src/lib/data/NOTICE.md). All these notices are included in the release.

## Stack

Svelte 5, Vite, Tailwind v4, bits-ui (the foundation of shadcn-svelte), lucide,
uPlot, Geist / Geist Mono (Latin and Cyrillic).

## Languages and translations

The interface defaults to English regardless of the browser language. Select Russian
on the connection screen or under **Settings → Appearance → Language**. The choice
is stored in `localStorage` under `miboard.locale`. Switching languages updates pages,
messages, the browser tab title, numbers, times and traffic units without reloading.
If storage is unavailable, the language selection works until the page is closed.

`src/lib/i18n.svelte.ts` contains the language registry and the `t()` function.
Dictionaries in `src/lib/locales/` are split by application section; `en.ts` and
`ru.ts` assemble them. The English dictionary defines the typed message keys.
Reactivity uses standard [Svelte 5 `$state` and `$derived`](https://svelte.dev/docs/svelte/$derived),
with no additional dependencies.

To add a language:

1. Create `src/lib/locales/fr.ts`. A complete translation is optional — missing
   messages fall back to English:

   ```ts
   import type { Messages } from '../i18n.svelte'

   export default {
     'nav.overview': 'Vue d’ensemble',
     'common.language': 'Langue',
   } satisfies Partial<Messages>
   ```

2. Import the dictionary in `src/lib/i18n.svelte.ts` and add an entry to `locales`:

   ```ts
   fr: { label: 'Français', intlLocale: 'fr-FR', dir: 'ltr', messages: fr },
   ```

   The language appears in both selectors automatically. For right-to-left text,
   use `dir: 'rtl'`.

3. Run `npm run check` and `npm run test:i18n`.

In components, use `t('key', { name: value })`; use `$derived(...)` for computed
lists of labels. Plurals are defined as an object with
`{ one: '…', few: '…', many: '…', other: '…' }` and a numeric `count` parameter.
`Intl.PluralRules` chooses the form, and numeric parameters are formatted according
to the selected language. Text and names received from mihomo remain API data.

## Design

Graphite neutral surfaces, with one amber accent for selected items and status
indicators. Charts show traffic load; latency is displayed as numbers.

Both themes use tokens from `src/app.css`. Shared color roles, sizes and the panel
template are documented in [UI_KIT.md](../UI_KIT.md).

In the light theme, the page and navigation backgrounds are distinct from the white
panels. Fields use `--field` / `--field-border`; selected states use
`--selected` / `--selected-border` / `--selected-text`.
Secondary text maintains a contrast ratio of at least 4.5:1 on standard surfaces;
green latency values and amber text use darker shades.

Checks for all ten screens, both themes, contrast and states are included in
`npm run test:ui`. To run them against an existing build, use
`node scripts/test-dashboard-ui.mjs`. To check the current Vite development server,
run `npm run test:theme`. Check for colors outside the shared palette with
`npm run test:palette` (also included in `npm test`).
