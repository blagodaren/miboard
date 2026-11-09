/** Only host names belong in a one-domain-per-line rule list; URLs and IPs do not. */
export function exportDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  const candidate = value.trim().toLowerCase().replace(/\.+$/, '')
  if (!candidate || candidate.length > 253 || /[\s/\\:@\[\]?#%*\u0000-\u001f\u007f]/.test(candidate)) return ''
  try {
    const host = new URL(`http://${candidate}/`).hostname
    if (host.length > 253 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return ''
    return host.split('.').every((label) => label.length <= 63 && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/.test(label)) ? host : ''
  } catch { return '' }
}

/** Deduplicate without changing the source's filtered/sorted order. */
export function domainList(values: readonly unknown[]): string[] {
  const domains = new Set<string>()
  for (const value of values) {
    const domain = exportDomain(value)
    if (domain) domains.add(domain)
  }
  return [...domains]
}

export function domainExport(values: readonly unknown[], name = '') {
  const domains = domainList(values)
  const suffix = name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80)
  return {
    domains,
    text: domains.length ? domains.join('\n') + '\n' : '',
    filename: `miboard-domains${suffix ? `-${suffix}` : ''}.txt`,
  }
}
