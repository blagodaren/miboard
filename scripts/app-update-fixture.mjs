import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const APP_UPDATE_URL = 'https://api.github.com/repos/blagodaren/miboard/releases/latest'

/** Non-PWA browser tests never depend on GitHub availability or release timing. */
export async function stubAppUpdates(context) {
  await context.route(APP_UPDATE_URL, route => route.fulfill({ json: {
    tag_name: `v${version}`,
    html_url: `https://github.com/blagodaren/miboard/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
  } }))
}
