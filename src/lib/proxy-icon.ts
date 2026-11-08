/** Keep configured images as image URLs; never turn icon content into inline markup. */
export function resolveProxyIcon(icon: string | undefined, backendUrl: string): string | null {
  const source = icon?.trim()
  if (!source) return null

  // SVG is rendered in the browser's image context, like remote SVG icons.
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[^,]*)?,.+/is.test(source)) return source

  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(source)
    const url = absolute ? new URL(source) : new URL(source, backendUrl.replace(/\/+$/, '') + '/')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
