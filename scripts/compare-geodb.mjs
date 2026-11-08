// Compare both databases against one captured DNS sample, never against different resolutions.
// node scripts/compare-geodb.mjs --baseline old-country.bin.gz --baseline-manifest old-manifest.json
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GeoDatabase, publicIp } from '../src/lib/geo-db.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`)
  return args[index + 1]
}
const baselinePath = option('--baseline')
if (!baselinePath) throw new Error('Pass --baseline path/to/old-country.bin.gz; the current database is never overwritten')
const baselineManifestPath = option('--baseline-manifest')
const candidatePath = option('--candidate', path.join(root, 'public/geodb/country.bin.gz'))
const candidateManifestPath = option('--candidate-manifest', path.join(path.dirname(path.resolve(candidatePath)), 'manifest.json'))
const casesPath = option('--cases', path.join(root, 'reports/geodb-reference-cases.json'))
const snapshotPath = option('--dns-snapshot')
const output = option('--out', path.join(root, 'reports/geodb-comparison-' + new Date().toISOString().slice(0, 10)))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function database(filename, manifestFile) {
  const packed = await readFile(filename)
  const manifest = manifestFile ? JSON.parse(await readFile(manifestFile, 'utf8')) : { provider: path.basename(filename) }
  if (manifest.sha256 && manifest.sha256 !== sha256(packed)) throw new Error(`Database hash mismatch: ${filename}`)
  return { lookup: new GeoDatabase(gunzipSync(packed)), manifest: { ...manifest, sha256: sha256(packed) } }
}
const [before, after] = await Promise.all([
  database(path.resolve(baselinePath), baselineManifestPath && path.resolve(baselineManifestPath)),
  database(path.resolve(candidatePath), path.resolve(candidateManifestPath)),
])
const referenceCases = JSON.parse(await readFile(casesPath, 'utf8'))
if (!Array.isArray(referenceCases) || !referenceCases.length) throw new Error('Expected a non-empty reference case array')
for (const entry of referenceCases) {
  if (!entry.domain || !/^[a-z0-9.-]+$/i.test(entry.domain) || !entry.domain.includes('.')) throw new Error('Invalid public reference domain')
  if (entry.expectedCountry !== null && !/^[A-Z]{2}$/.test(entry.expectedCountry)) throw new Error(`Invalid expected country for ${entry.domain}`)
  if (entry.confidence === 'provider' && (!entry.expectedCountry || !/^https:\/\//.test(entry.referenceUrl))) {
    throw new Error(`A scored case needs a provider reference: ${entry.domain}`)
  }
}

async function dns(domain, type) {
  const endpoints = [
    new URL('https://dns.google/resolve'),
    new URL('https://cloudflare-dns.com/dns-query'),
  ]
  const failures = []
  for (const url of endpoints) {
    url.searchParams.set('name', domain)
    url.searchParams.set('type', type)
    try {
      const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      if (typeof data.Status !== 'number') throw new Error('Invalid DNS JSON')
      return {
        type, resolver: url.origin, query: url.href, capturedAt: new Date().toISOString(), status: data.Status,
        answers: (Array.isArray(data.Answer) ? data.Answer : []).map(({ name, type, TTL, data }) => ({ name, type, TTL, data })),
      }
    } catch (error) { failures.push(`${url.origin}: ${error.message}`) }
  }
  return { type, capturedAt: new Date().toISOString(), status: null, answers: [], error: failures.join('; ') }
}

let captures
if (snapshotPath) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  captures = snapshot.dns ?? snapshot
} else {
  captures = new Array(referenceCases.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, referenceCases.length) }, async () => {
    while (next < referenceCases.length) {
      const index = next++
      const { domain } = referenceCases[index]
      captures[index] = { domain, queries: await Promise.all(['A', 'AAAA'].map((type) => dns(domain, type))) }
    }
  }))
}
if (!Array.isArray(captures)) throw new Error('Invalid DNS snapshot')

const rows = []
const cases = []
for (const entry of referenceCases) {
  const capture = captures.find((item) => item.domain === entry.domain)
  if (!capture || !Array.isArray(capture.queries)) throw new Error(`DNS snapshot missing ${entry.domain}`)
  const addresses = new Map()
  for (const query of capture.queries) {
    const type = query.type === 'A' ? 1 : 28
    for (const answer of query.answers ?? []) {
      if (answer.type !== type) continue
      const ip = publicIp(answer.data)
      if (ip) addresses.set(ip, { ip, family: type === 1 ? 4 : 6, resolver: query.resolver })
    }
  }
  const results = [...addresses.values()].map((address) => ({
    ...entry, ...address,
    before: before.lookup.lookup(address.ip), after: after.lookup.lookup(address.ip),
    scored: entry.confidence === 'provider' && !!entry.expectedCountry,
  }))
  rows.push(...results)
  cases.push({ ...entry, addresses: results.length, error: results.length ? null : capture.queries.map((q) => q.error || `DNS ${q.type}: status ${q.status}`).join('; ') })
}

const scored = rows.filter((row) => row.scored)
const uniqueScored = [...new Map(scored.map((row) => [`${row.ip}|${row.expectedCountry}`, row])).values()]
const scoredCases = cases.filter((entry) => entry.confidence === 'provider' && entry.expectedCountry)
const score = (key) => ({
  correct: uniqueScored.filter((row) => row[key] === row.expectedCountry).length,
  total: uniqueScored.length,
  unknown: uniqueScored.filter((row) => !row[key]).length,
  domainsCorrect: scoredCases.filter((entry) => {
    const domainRows = rows.filter((row) => row.domain === entry.domain)
    return domainRows.length > 0 && domainRows.every((row) => row[key] === entry.expectedCountry)
  }).length,
  domainsTotal: scoredCases.length,
})
const families = Object.fromEntries([4, 6].map((family) => {
  const sample = uniqueScored.filter((row) => row.family === family)
  return [family, Object.fromEntries(['before', 'after'].map((key) => [key, {
    correct: sample.filter((row) => row[key] === row.expectedCountry).length, total: sample.length,
  }]))]
}))
const report = {
  generatedAt: new Date().toISOString(),
  dnsCapturedAt: captures.flatMap((capture) => capture.queries.map((query) => query.capturedAt)).filter(Boolean).sort()[0] ?? null,
  method: 'Both local databases receive exactly the same public DNS A/AAAA addresses. Only provider-documented reference countries are scored. This is a small targeted sample, not a global accuracy measurement. Anycast and user-claimed countries are excluded from the score.',
  before: before.manifest, after: after.manifest,
  summary: { domains: cases.length, addresses: rows.length, changed: rows.filter((row) => row.before !== row.after).length, before: score('before'), after: score('after'), families },
  cases, rows, dns: captures,
}
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const names = new Intl.DisplayNames('ru', { type: 'region' })
const country = (code) => code ? `${code} · ${names.of(code)}` : 'Не определено'
const label = (manifest) => manifest.provider === 'sapics/ip-location-db server-country' ? 'server-country' : manifest.provider || 'GeoDB'
const urlLink = (url, label) => /^https:\/\//.test(url ?? '') ? `<a href="${escape(url)}" target="_blank" rel="noreferrer">${escape(label)}</a>` : escape(label)
const classification = (row, key) => !row.scored ? '' : row[key] === row.expectedCountry ? 'correct' : 'incorrect'
const percent = (value) => value.total ? `${Math.round(value.correct / value.total * 1000) / 10}%` : 'Нет эталонов'
const tableRows = cases.map((entry) => {
  const sample = rows.filter((row) => row.domain === entry.domain)
  const cell = (key) => [4, 6].map((family) => {
    const addresses = sample.filter((row) => row.family === family)
    if (!addresses.length) return `<small>IPv${family}: нет ответа</small>`
    const code = addresses.some((row) => classification(row, key) === 'incorrect') ? 'incorrect' : classification(addresses[0], key)
    return `<div class="${code}">IPv${family}: ${[...new Set(addresses.map((row) => country(row[key])))].map(escape).join(', ')}</div>`
  }).join('')
  return `<tr><th scope="row">${escape(entry.domain)}<details><summary>${sample.length} IP · раскрыть адреса</summary><small>${sample.map((row) => escape(row.ip)).join('<br>')}</small></details></th><td>${cell('before')}</td><td>${cell('after')}</td><td>${entry.confidence === 'provider' ? escape(country(entry.expectedCountry)) : 'Вне оценки: anycast'}<small>${entry.userClaimCountry ? `По словам пользователя: ${escape(country(entry.userClaimCountry))}` : ''}</small></td><td>${urlLink(entry.referenceUrl, entry.confidence === 'provider' ? 'Данные провайдера' : 'Источник / ограничения')}<details><summary>Основание</summary><small>${escape(entry.notes)}</small></details></td></tr>`
}).join('\n')
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Сравнение GeoIP — miboard</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#141415;color:#ededed;font:14px/1.5 system-ui,sans-serif}main{max-width:1480px;margin:auto;padding:40px 24px}h1{font-size:30px;font-weight:500;margin:0 0 12px}p{max-width:1000px;color:#a1a1a6}a{color:#e8a33d}small{display:block;font-size:12px;font-weight:400;color:#a1a1a6;margin-top:6px}section{display:flex;gap:24px;flex-wrap:wrap;margin:28px 0}section div{padding:16px 24px;border:1px solid #343437;border-radius:12px}strong{display:block;font:500 24px ui-monospace,monospace}.table{overflow:auto;border:1px solid #343437;border-radius:12px}table{width:100%;border-collapse:collapse;text-align:left;min-width:900px}th,td{padding:16px;border-bottom:1px solid #343437;vertical-align:top}thead{background:#232325}tbody th{font-weight:500;max-width:360px;overflow-wrap:anywhere}.correct{color:#8bdaa9}.incorrect{color:#f4a1a5}input{width:100%;max-width:560px;margin:12px 0 20px;padding:12px;border:1px solid #525252;border-radius:8px;background:#19191b;color:#ededed;font:inherit}:focus-visible{outline:2px solid #e8a33d;outline-offset:3px}footer{margin-top:28px;color:#a1a1a6;max-width:1050px}code{font-family:ui-monospace,monospace}@media(max-width:600px){main{padding:24px 16px}section{gap:12px}section div{flex:1;padding:12px}h1{font-size:26px}}</style>
<main><h1>Сравнение GeoIP по доменам</h1><p>Один снимок DNS, одинаковые IP для обеих баз. Эталон — страна тестового узла, опубликованная его провайдером. Anycast и неподтверждённые страны показываются отдельно и не входят в процент.</p>
<small>DNS-снимок: ${escape(new Date(report.dnsCapturedAt ?? report.generatedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} МСК · ${cases.length} доменов · ${rows.length} адресов</small>
<section><div>${escape(label(before.manifest))}: совпадений с эталоном<strong>${report.summary.before.correct}/${report.summary.before.total} · ${percent(report.summary.before)}</strong><small>Полностью совпали домены: ${report.summary.before.domainsCorrect}/${report.summary.before.domainsTotal}</small></div><div>${escape(label(after.manifest))}: совпадений с эталоном<strong>${report.summary.after.correct}/${report.summary.after.total} · ${percent(report.summary.after)}</strong><small>Полностью совпали домены: ${report.summary.after.domainsCorrect}/${report.summary.after.domainsTotal}</small></div><div>Изменились результаты<strong>${report.summary.changed}/${rows.length}</strong><small>IPv4 и IPv6 учитываются отдельно; повторяющиеся эталонные IP не увеличивают процент</small></div></section>
<p>IPv4: ${escape(label(before.manifest))} ${families[4].before.correct}/${families[4].before.total}, ${escape(label(after.manifest))} ${families[4].after.correct}/${families[4].after.total}. IPv6: ${escape(label(before.manifest))} ${families[6].before.correct}/${families[6].before.total}, ${escape(label(after.manifest))} ${families[6].after.correct}/${families[6].after.total}.</p>
<label for="filter">Фильтр по домену или IP</label><br><input id="filter" type="search" placeholder="Например, discord.media"><div class="table"><table><thead><tr><th>Домен / IP</th><th>${escape(label(before.manifest))}</th><th>${escape(label(after.manifest))}</th><th>Эталон</th><th>Основание</th></tr></thead><tbody>${tableRows}</tbody></table></div>
${cases.filter((entry) => entry.error).length ? `<p>Без публичного DNS-ответа: ${cases.filter((entry) => entry.error).map((entry) => escape(entry.domain)).join(', ')}</p>` : ''}
<footer>Это ограниченная проверочная выборка, а не оценка глобальной точности. DNS отражает ответы указанного в JSON резолвера в момент измерения; ваш mihomo может получить другие IP. Anycast-IP не имеет единственной подтверждённой физической страны. ${urlLink(before.manifest.attributionUrl ?? before.manifest.source, before.manifest.attribution ?? label(before.manifest))} · baseline ${escape(before.manifest.release)} · ${escape(before.manifest.license)}. ${urlLink(after.manifest.attributionUrl ?? after.manifest.source, after.manifest.attribution ?? label(after.manifest))} · ${escape(after.manifest.license)}. Полные DNS-ответы, ссылки и SHA-256 обеих баз сохранены в соседнем JSON-файле.</footer></main>
<script>document.querySelector('#filter').addEventListener('input',event=>{const value=event.target.value.toLowerCase();document.querySelectorAll('tbody tr').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(value))})</script></html>`
await mkdir(path.dirname(path.resolve(output)), { recursive: true })
await writeFile(output + '.json', JSON.stringify(report, null, 2) + '\n')
await writeFile(output + '.html', html)
console.log(JSON.stringify({ ...report.summary, report: output + '.html' }, null, 2))
for (const entry of cases) {
  const domainRows = rows.filter((row) => row.domain === entry.domain)
  console.log([entry.domain, domainRows.map((row) => `IPv${row.family}:${row.before ?? 'ZZ'}>${row.after ?? 'ZZ'}`).join(' '), entry.confidence === 'provider' ? `reference=${entry.expectedCountry}` : 'not scored'].join('\t'))
}
