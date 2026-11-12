// Мок mihomo external-controller для разработки и скриншотов.
// node mock/server.js  → http://127.0.0.1:9090, secret: test, панель из dist на /ui/
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 9090)
const SECRET = process.env.SECRET ?? 'test'
// PRIZRAK=1 включает дополнительные API; обычный mock остаётся mihomo.
const PRIZRAK = process.env.PRIZRAK === '1'
const DIST = path.resolve(process.env.MIBOARD_UI_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'))

const rnd = (a, b) => Math.floor(a + Math.random() * (b - a))
const pick = (arr) => arr[rnd(0, arr.length)]

// ——— прокси ———
const nodes = [
  ['nl-ams-01', 'Vless'],
  ['nl-ams-02', 'Vless'],
  ['de-fra-01', 'Hysteria2'],
  ['fi-hel-01', 'Vless'],
  ['se-sto-01', 'Trojan'],
  ['us-nyc-01', 'Vless'],
  ['jp-tyo-01', 'Hysteria2'],
  ['tr-ist-01', 'Vless'],
]
const proxies = {}
const hist = (d) => [{ time: new Date().toISOString(), delay: d }]
function measureDelay(name, url) {
  const node = proxies[name]
  if (!node) return undefined
  const ipv6Unavailable = url === 'https://ipv6.google.com/generate_204' && ['jp-tyo-01', 'tr-ist-01'].includes(name)
  const delay = name === 'tr-ist-01' || node.type === 'Reject' || ipv6Unavailable ? 0 : rnd(35, name === 'jp-tyo-01' ? 900 : 300)
  node.history = hist(delay)
  node.extra ??= {}
  node.extra[url] = { alive: delay > 0, history: node.history }
  return delay
}
for (const [n, t] of nodes) proxies[n] = {
  name: n, type: t, udp: true, uot: false, xudp: t === 'Vless', tfo: false, mptcp: false, smux: false,
  interface: '', 'routing-mark': 0, 'provider-name': 'mock-nodes', 'dialer-proxy': '', alive: true,
  history: Array.from({ length: 6 }, (_, i) => ({ time: new Date(Date.now() - (5 - i) * 60_000).toISOString(), delay: rnd(40, 260) })),
}
proxies['jp-tyo-01'].history = hist(412)
proxies['tr-ist-01'].history = hist(0)
proxies.DIRECT = { name: 'DIRECT', type: 'Direct', udp: true, alive: true, history: [] }
proxies.REJECT = { name: 'REJECT', type: 'Reject', udp: true, alive: true, history: [] }
const group = (name, type, all, now = all[0]) =>
  (proxies[name] = { name, type, all, now, udp: true, alive: true, history: hist(rnd(50, 120)) })
const names = nodes.map((n) => n[0])
const proxyProviders = {
  'mock-nodes': {
    name: 'mock-nodes',
    type: 'Proxy',
    vehicleType: 'HTTP',
    testUrl: 'https://www.gstatic.com/generate_204',
    expectedStatus: '204',
    updatedAt: new Date().toISOString(),
    subscriptionInfo: { Download: 92_000_000_000, Upload: 8_000_000_000, Total: 500_000_000_000, Expire: Math.floor(Date.now() / 1000) + 30 * 86400 },
    proxies: names.map((name) => proxies[name]),
  },
}
group('Авто', 'URLTest', names, 'fi-hel-01')
group('Прокси', 'Selector', ['Авто', ...names, 'DIRECT'], 'Авто')
group('YouTube', 'Selector', ['Прокси', 'nl-ams-01', 'de-fra-01', 'DIRECT'])
group('Telegram', 'Selector', ['Прокси', 'fi-hel-01', 'se-sto-01'])
group('Россия', 'Selector', ['DIRECT', 'Прокси'])
group('Реклама', 'Selector', ['REJECT', 'DIRECT'])
group('Остальное', 'Selector', ['Прокси', 'DIRECT'])
group('GLOBAL', 'Selector', ['Прокси', 'Авто', 'YouTube', 'Telegram', 'Россия', 'Реклама', 'Остальное', ...names, 'DIRECT', 'REJECT'], 'Прокси')

if (PRIZRAK) {
  group('Smart', 'Smart', names, 'fi-hel-01')
  Object.assign(proxies.Smart, {
    useLightGBM: true, collectData: true, sampleRate: 1, preferASN: true,
    tolerance: 0, 'policy-priority': '',
  })
  proxies.GLOBAL.all.unshift('Smart')
}
const smartWeights = [{ Name: 'fi-hel-01', Rank: 'MostUsed', Weight: 95 }, { Name: 'nl-ams-01', Rank: 'OccasionalUsed', Weight: 62.5 }]

// Иконки конфигурации для локальной проверки: остальные группы используют fallback.
proxies['Прокси'].icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#e8a33d"/><path d="M6 7h12M6 12h8M6 17h12" stroke="#1a1204" stroke-width="2" stroke-linecap="round"/></svg>')
proxies['Авто'].icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#3c8d87"/><path d="m12 5 6 7-6 7-6-7Z" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="#fff"/></svg>')

const resolveNode = (n) => (proxies[n]?.now ? resolveNode(proxies[n].now) : n)

// ——— правила ———
const rules = [
  { type: 'RuleSet', payload: 'ads', proxy: 'Реклама', size: -1 },
  { type: 'DomainSuffix', payload: 'youtube.com', proxy: 'YouTube', size: -1 },
  { type: 'DomainSuffix', payload: 'googlevideo.com', proxy: 'YouTube', size: -1 },
  { type: 'DomainSuffix', payload: 'ytimg.com', proxy: 'YouTube', size: -1 },
  { type: 'RuleSet', payload: 'telegram', proxy: 'Telegram', size: -1 },
  { type: 'IPCIDR', payload: '91.108.4.0/22', proxy: 'Telegram', size: -1 },
  { type: 'RuleSet', payload: 'ru-domains', proxy: 'Россия', size: -1 },
  { type: 'GeoIP', payload: 'ru', proxy: 'Россия', size: -1 },
  { type: 'DomainSuffix', payload: 'github.com', proxy: 'Прокси', size: -1 },
  { type: 'DomainKeyword', payload: 'example', proxy: 'Прокси', size: -1 },
  { type: 'ProcessName', payload: 'qbittorrent', proxy: 'DIRECT', size: -1 },
  { type: 'Match', payload: '', proxy: 'Остальное', size: -1 },
]
rules.forEach((rule, index) => Object.assign(rule, { index, extra: {
  disabled: false, hitCount: index === 10 ? 0 : 1200 - index * 87, missCount: index * 103,
  hitAt: index === 10 ? '0001-01-01T00:00:00Z' : new Date(Date.now() - index * 60_000).toISOString(),
  missAt: new Date(Date.now() - index * 30_000).toISOString(),
} }))

const ruleProviders = {
  ads: {
    name: 'ads',
    behavior: 'Domain',
    format: 'mrs',
    ruleCount: 48213,
    type: 'Rule',
    vehicleType: 'HTTP',
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  telegram: {
    name: 'telegram',
    behavior: 'Classical',
    ruleCount: 3,
    type: 'Rule',
    vehicleType: 'Inline',
    updatedAt: new Date().toISOString(),
    payload: ['DOMAIN-SUFFIX,telegram.org', 'DOMAIN-SUFFIX,t.me', 'IP-CIDR,149.154.160.0/20'],
  },
  'ru-domains': {
    name: 'ru-domains',
    behavior: 'Domain',
    format: 'yaml',
    ruleCount: 61902,
    type: 'Rule',
    vehicleType: 'File',
    updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
  },
}

// ——— соединения ———
const targets = [
  ['rr3---sn-4g5e6nsz.googlevideo.com', 443, 'DomainSuffix', 'googlevideo.com', 'YouTube', 'tcp', 4_000_000, 'DE', '173.194.163.10'],
  ['i.ytimg.com', 443, 'DomainSuffix', 'ytimg.com', 'YouTube', 'tcp', 300_000, 'US', '142.250.191.86'],
  ['www.youtube.com', 443, 'DomainSuffix', 'youtube.com', 'YouTube', 'udp', 200_000, 'IE', '142.250.74.206'],
  ['149.154.167.51', 443, 'IPCIDR', '91.108.4.0/22', 'Telegram', 'tcp', 60_000, 'NL'],
  ['web.telegram.org', 443, 'RuleSet', 'telegram', 'Telegram', 'tcp', 30_000, 'NL', '149.154.167.99'],
  ['github.com', 443, 'DomainSuffix', 'github.com', 'Прокси', 'tcp', 40_000, 'US', '140.82.114.3'],
  ['objects.githubusercontent.com', 443, 'DomainSuffix', 'github.com', 'Прокси', 'tcp', 900_000, 'US', '185.199.108.133'],
  ['ya.ru', 443, 'RuleSet', 'ru-domains', 'Россия', 'tcp', 20_000, 'RU', '77.88.55.242'],
  ['gosuslugi.ru', 443, 'RuleSet', 'ru-domains', 'Россия', 'tcp', 15_000, 'RU', '109.207.1.97'],
  ['vk.com', 443, 'RuleSet', 'ru-domains', 'Россия', 'udp', 50_000, 'RU', '87.240.132.72'],
  ['discord.com', 443, 'Match', '', 'Остальное', 'tcp', 20_000, 'US', '162.159.135.232'],
  ['open.spotify.com', 443, 'Match', '', 'Остальное', 'tcp', 120_000, 'SE', '35.186.224.25'],
  ['ntp.ubuntu.com', 123, 'Match', '', 'Остальное', 'udp', 100, null, '185.125.190.56'],
  ['192.168.1.1', 80, 'IPCIDR', '192.168.0.0/16', 'Россия', 'tcp', 300, null],
]
const processes = ['chrome', 'Telegram', 'firefox', 'git', 'Spotify', '']
let conns = []
let seq = 0
function spawnConn(target = pick(targets)) {
  // Страна и адрес — пример ответа GeoIP для мока, без реального DNS/IP lookup.
  const [host, port, rule, payload, grp, network, bw, country, destinationIP] = target
  const node = resolveNode(grp)
  const chains = [node]
  if (proxies[grp].now !== node) chains.push(proxies[grp].now)
  chains.push(grp)
  conns.push({
    id: `c${++seq}-${Math.random().toString(36).slice(2, 8)}`,
    metadata: {
      network,
      type: 'Tun',
      sourceIP: `192.168.1.${rnd(20, 40)}`,
      sourcePort: String(rnd(40000, 65000)),
      destinationIP: destinationIP ?? (/^\d/.test(host) ? host : `142.250.${rnd(1, 200)}.${rnd(1, 250)}`),
      destinationPort: String(port),
      // Часть соединений ещё не проверена ядром; частные адреса не имеют страны.
      destinationGeoIP: seq % 7 === 0 ? null : country ? [country] : [],
      destinationIPASN: seq % 6 === 0 ? '' : '64512 MOCK-NETWORK',
      host: /^\d/.test(host) ? '' : host,
      process: pick(processes),
    },
    upload: rnd(1000, 50000),
    download: rnd(5000, 2_000_000),
    start: new Date(Date.now() - rnd(1000, 3_600_000)).toISOString(),
    chains,
    rule,
    rulePayload: payload,
    _bw: bw,
    _active: Math.random() < 0.45,
  })
}
// Одна частная цель гарантирует проверяемое состояние «без геоданных».
spawnConn(targets.at(-1))
if (PRIZRAK) spawnConn(['smart.miboard.example.com', 443, 'Match', '', 'Smart', 'tcp', 4000, 'FI', '95.216.0.1'])
for (let i = 1; i < 38; i++) spawnConn()

let upTotal = 312 * 1024 * 1024
let downTotal = 4.2 * 1024 * 1024 * 1024
let lastUp = 0
let lastDown = 0
setInterval(() => {
  lastUp = 0
  lastDown = 0
  for (const c of conns) {
    if (Math.random() < 0.1) c._active = !c._active
    if (!c._active) continue
    const d = Math.floor(c._bw * (0.3 + Math.random()))
    const u = Math.floor(d * (0.02 + Math.random() * 0.05))
    c.download += d
    c.upload += u
    lastDown += d
    lastUp += u
  }
  downTotal += lastDown
  upTotal += lastUp
  if (Math.random() < 0.3 && conns.length > 20) {
    const index = rnd(0, conns.length)
    // Smart fixture stays available until the explicit switch-node action.
    if (!PRIZRAK || !conns[index].chains.includes('Smart')) conns.splice(index, 1)
  }
  if (Math.random() < 0.4 && conns.length < 60) spawnConn()
}, 1000)

const configs = {
  port: 0,
  'socks-port': 0,
  'mixed-port': 7890,
  'allow-lan': true,
  'unified-delay': true,
  mode: 'rule',
  'log-level': 'info',
  tun: { enable: true, stack: 'mixed', device: 'Mihomo', mtu: 9000, 'auto-route': true, 'auto-detect-interface': true, 'dns-hijack': ['any:53'] },
  ipv6: true, sniffing: true, 'find-process-mode': 'strict', 'tcp-concurrent': true,
  'interface-name': '', 'bind-address': '*', 'routing-mark': 0,
  'geox-url': { 'geo-ip': 'https://example.test/geoip.dat', 'geo-site': 'https://example.test/geosite.dat', mmdb: 'https://example.test/country.mmdb', asn: 'https://example.test/asn.mmdb' },
  'geo-auto-update': true, 'geo-update-interval': 24, 'geodata-mode': true, 'geodata-loader': 'memconservative',
  ...(PRIZRAK ? {
    'lgbm-auto-update': true,
    'lgbm-update-interval': 72,
    'lgbm-url': 'https://example.test/Model.bin',
    'smart-collector-size': 100,
  } : {}),
}

// ——— HTTP ———
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true',
}
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...cors })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const readBody = (req) =>
  new Promise((r) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => r(s ? JSON.parse(s) : {}))
  })
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const storage = new Map()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = decodeURIComponent(url.pathname)

  if (p === '/ui' || p.startsWith('/ui/')) {
    let f = path.join(DIST, p.slice(3) || '/')
    if (!f.startsWith(DIST)) return json(res, 403, { message: 'Forbidden' })
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html')
    if (!fs.existsSync(f)) return json(res, 404, { message: 'Not Found' })
    res.writeHead(200, { 'Content-Type': mime[path.extname(f)] ?? 'application/octet-stream' })
    return fs.createReadStream(f).pipe(res)
  }
  if (req.method === 'OPTIONS') return json(res, 204)
  if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { message: 'Unauthorized' })

  const m = (method, re) => req.method === method && p.match(re)
  let r
  if (m('GET', /^\/version$/)) return json(res, 200, { meta: true, version: 'v1.19.15-mock' })
  if ((r = p.match(/^\/storage\/([^/]+)$/))) {
    const key = r[1]
    if (req.method === 'GET') return json(res, 200, storage.get(key) ?? null)
    if (req.method === 'DELETE') { storage.delete(key); return json(res, 204) }
    if (req.method === 'PUT') {
      const value = await readBody(req)
      if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return json(res, 413, { message: 'payload exceeds 1MB limit' })
      storage.set(key, value)
      return json(res, 204)
    }
  }
  if (m('GET', /^\/dns\/query$/)) {
    // Детерминированный DNS API: мок никогда не выполняет реальные DNS-запросы.
    const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '')
    const type = (url.searchParams.get('type') ?? 'A').toUpperCase()
    const types = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2, SOA: 6, PTR: 12, CAA: 257 }
    if (!(type in types)) return json(res, 400, { message: 'invalid query type' })
    const flags = { Question: [{ Name: name + '.', Qtype: types[type], Qclass: 1 }], TC: false, RD: true, RA: true, AD: false, CD: false }
    if (type !== 'A' && type !== 'AAAA') {
      const values = { CNAME: 'edge.example.com.', MX: '10 mail.example.com.', TXT: '"v=spf1 -all"', NS: 'ns1.example.com.', SOA: 'ns1.example.com. admin.example.com. 1 3600 600 86400 60', PTR: 'dns.example.com.', CAA: '0 issue "letsencrypt.org"' }
      const known = name === 'example.com' || (type === 'PTR' && /\.(in-addr|ip6)\.arpa$/.test(name))
      return json(res, 200, { ...flags, Status: known ? 0 : 3,
        ...(known ? { Answer: [{ name: name + '.', type: types[type], TTL: 120, data: values[type] }],
          Authority: [{ name: 'example.com.', type: 2, TTL: 300, data: 'ns1.example.com.' }],
          Additional: [{ name: 'ns1.example.com.', type: 1, TTL: 300, data: '192.0.2.53' }] } : {}),
      })
    }
    const fixtures = {
      'dns-only.miboard.example.com': { A: '8.8.8.8' },
      'fake-ip.miboard.example.com': { A: '8.8.4.4' },
      'ipv6-only.miboard.example.com': { AAAA: '2606:4700:4700::1111' },
      'example.com': { A: '93.184.216.34' },
      'cloudflare.com': { A: '104.16.132.229', AAAA: '2606:4700::6810:84e5' },
      'github.com': { A: '140.82.114.3' },
    }
    const target = targets.find(([host]) => host === name)
    const data = fixtures[name]?.[type] ?? (type === 'A' ? target?.[8] : undefined)
    if (!data) return json(res, 200, { Status: name === 'ipv6-only.miboard.example.com' ? 0 : 3, Answer: [] })
    return json(res, 200, { ...flags, Status: 0, Answer: [{ name: name + '.', type: type === 'AAAA' ? 28 : 1, TTL: 120, data }] })
  }
  if (m('GET', /^\/configs$/)) return json(res, 200, configs)
  if (m('GET', /^\/connections$/)) return json(res, 200, { connections: conns, downloadTotal: downTotal, uploadTotal: upTotal, memory: 42 * 1024 * 1024 })
  if (m('PATCH', /^\/configs$/)) {
    const b = await readBody(req)
    if (b.tun) Object.assign(configs.tun, b.tun)
    Object.assign(configs, { ...b, tun: configs.tun })
    return json(res, 204)
  }
  if (m('PUT', /^\/configs$/)) return json(res, 204)
  if (m('GET', /^\/proxies$/)) return json(res, 200, { proxies })
  if (m('GET', /^\/providers\/proxies$/)) return json(res, 200, { providers: proxyProviders })
  if (req.method === 'PUT' && (r = url.pathname.match(/^\/providers\/proxies\/([^/]+)$/))) {
    const provider = proxyProviders[decodeURIComponent(r[1])]
    if (!provider) return json(res, 404, { message: 'Provider not found' })
    await new Promise(resolve => setTimeout(resolve, 100))
    provider.updatedAt = new Date().toISOString()
    return json(res, 204)
  }
  if (req.method === 'GET' && (r = url.pathname.match(/^\/providers\/proxies\/([^/]+)\/healthcheck$/))) {
    const provider = proxyProviders[decodeURIComponent(r[1])]
    if (!provider) return json(res, 404, { message: 'Provider not found' })
    await new Promise(resolve => setTimeout(resolve, 200))
    for (const proxy of provider.proxies ?? []) measureDelay(proxy.name, provider.testUrl ?? 'https://www.gstatic.com/generate_204')
    return json(res, 204)
  }
  if (m('GET', /^\/group\/weights$/)) return PRIZRAK
    ? json(res, 200, { weights: { Smart: smartWeights }, errors: {} })
    : json(res, 404, { message: 'Not Found' })
  if ((r = m('GET', /^\/group\/(.+)\/weights$/))) {
    if (!PRIZRAK) return json(res, 404, { message: 'Not Found' })
    return proxies[r[1]]?.type === 'Smart'
      ? json(res, 200, { weights: smartWeights })
      : json(res, 400, { error: 'Group is not Smart' })
  }
  if ((r = m('PUT', /^\/proxies\/(.+)$/))) {
    const b = await readBody(req)
    proxies[r[1]].now = b.name
    return json(res, 204)
  }
  if ((r = m('GET', /^\/group\/(.+)\/delay$/))) {
    await new Promise((ok) => setTimeout(ok, 700))
    const out = {}
    for (const n of proxies[r[1]].all) {
      if (!proxies[n] || proxies[n].type === 'Reject') continue
      const d = measureDelay(n, url.searchParams.get('url') ?? '')
      if (d) out[n] = d
    }
    return json(res, 200, out)
  }
  if ((r = m('GET', /^\/proxies\/(.+)\/delay$/))) {
    const delay = measureDelay(r[1], url.searchParams.get('url') ?? '')
    if (delay === undefined) return json(res, 404, { message: 'Proxy not found' })
    return delay > 0 ? json(res, 200, { delay }) : json(res, 504, { message: 'Timeout' })
  }
  if (req.method === 'GET' && (r = url.pathname.match(/^\/providers\/proxies\/([^/]+)\/([^/]+)\/healthcheck$/))) {
    const provider = decodeURIComponent(r[1])
    const node = decodeURIComponent(r[2])
    if (!proxyProviders[provider]?.proxies?.some((proxy) => proxy.name === node)) return json(res, 404, { message: 'Proxy not found' })
    const delay = measureDelay(node, url.searchParams.get('url') ?? '')
    return delay > 0 ? json(res, 200, { delay }) : json(res, 504, { message: 'Timeout' })
  }
  if (m('GET', /^\/rules$/)) return json(res, 200, { rules })
  if (m('PATCH', /^\/rules\/disable$/)) {
    const changes = await readBody(req)
    for (const [index, disabled] of Object.entries(changes)) {
      if (typeof disabled === 'boolean' && rules[Number(index)]) rules[Number(index)].extra.disabled = disabled
    }
    return json(res, 204)
  }
  if (m('GET', /^\/providers\/rules$/)) return json(res, 200, { providers: ruleProviders })
  if (req.method === 'PUT' && (r = url.pathname.match(/^\/providers\/rules\/([^/]+)$/))) {
    const name = decodeURIComponent(r[1])
    const provider = Object.hasOwn(ruleProviders, name) ? ruleProviders[name] : undefined
    if (!provider) return json(res, 404, { message: 'Provider not found' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    provider.updatedAt = new Date().toISOString()
    return json(res, 204)
  }
  if ((r = m('DELETE', /^\/connections\/smart\/(.+)$/))) {
    if (!PRIZRAK) return json(res, 404, { message: 'Not Found' })
    conns = conns.filter((c) => c.id !== r[1])
    return json(res, 204)
  }
  if ((r = m('DELETE', /^\/connections\/(.+)$/))) {
    conns = conns.filter((c) => c.id !== r[1])
    return json(res, 204)
  }
  if (m('DELETE', /^\/connections$/)) {
    conns = []
    return json(res, 204)
  }
  if (m('POST', /^\/cache\/(fakeip|dns)\/flush$/)) return json(res, 204)
  if (m('POST', /^\/cache\/smart\/flush(?:\/.+)?$/)) return json(res, PRIZRAK ? 204 : 404, PRIZRAK ? undefined : { message: 'Not Found' })
  if (m('POST', /^\/upgrade\/lgbm$/)) return PRIZRAK ? json(res, 200, { status: 'ok' }) : json(res, 404, { message: 'Not Found' })
  // Development fixture only: no executable, UI files or geodata are changed.
  if (m('POST', /^\/upgrade(?:\/(ui|geo))?$/)) return json(res, p.endsWith('/geo') ? 204 : 200, p.endsWith('/geo') ? undefined : { status: 'ok' })
  if (m('POST', /^\/restart$/)) return json(res, 200, { status: 'ok' })
  json(res, 404, { message: 'Not Found' })
})

// ——— WebSocket ———
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (SECRET && url.searchParams.get('token') !== SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o))
    let t
    switch (url.pathname) {
      case '/traffic':
        t = setInterval(() => send({ up: lastUp, down: lastDown, upTotal, downTotal }), 1000)
        break
      case '/memory':
        t = setInterval(() => send({ inuse: 88_000_000 + rnd(0, 6_000_000), oslimit: 0 }), 1000)
        break
      case '/connections': {
        const tick = () =>
          send({
            downloadTotal: downTotal,
            uploadTotal: upTotal,
            connections: conns.map(({ _bw, _active, ...c }) => c),
            memory: 0,
          })
        tick()
        t = setInterval(tick, Number(url.searchParams.get('interval') ?? 1000))
        break
      }
      case '/logs': {
        const order = ['debug', 'info', 'warning', 'error']
        const min = order.indexOf(url.searchParams.get('level') ?? 'info')
        t = setInterval(() => {
          const c = pick(conns)
          if (!c) return
          const lvl = Math.random() < 0.08 ? 'warning' : Math.random() < 0.03 ? 'error' : 'info'
          if (order.indexOf(lvl) < min) return
          const dst = `${c.metadata.host || c.metadata.destinationIP}:${c.metadata.destinationPort}`
          const payload =
            lvl === 'info'
              ? `[${c.metadata.network.toUpperCase()}] ${c.metadata.sourceIP}:${c.metadata.sourcePort} --> ${dst} match ${c.rule}(${c.rulePayload}) using ${[...c.chains].reverse().join('[') }`
              : lvl === 'warning'
                ? `[${c.chains[0]}] dial ${dst} timeout, retrying`
                : `[DNS] resolve ${dst.split(':')[0]} failed: i/o timeout`
          send({ type: lvl, payload })
        }, 600)
        break
      }
      default:
        ws.close()
    }
    ws.on('close', () => clearInterval(t))
  })
})

server.listen(PORT, '127.0.0.1', () =>
  console.log(`mock mihomo on http://127.0.0.1:${PORT}  secret=${SECRET}  ui: http://127.0.0.1:${PORT}/ui/`),
)
