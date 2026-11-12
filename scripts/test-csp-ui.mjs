import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { WebSocketServer } from 'ws'

const dist = path.resolve(fileURLToPath(new URL(`../${process.argv[2] || 'dist'}/`, import.meta.url)))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const prefix = '/nested/ui/'
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === prefix + 'csp-probe.js') {
    // Run as an ordinary allowed script: DevTools evaluation can bypass eval CSP.
    return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end("try { new Function('globalThis.__evalRan = true')() } catch (error) { globalThis.__evalBlocked = error.name === 'EvalError' }")
  }
  const file = path.resolve(dist, pathname.slice(prefix.length) || 'index.html')
  if (!pathname.startsWith(prefix) || !file.startsWith(dist + path.sep)) return res.writeHead(404).end()
  try { res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(await readFile(file)) }
  catch { res.writeHead(404).end() }
})
let remoteScriptRequests = 0
const controller = http.createServer((req, res) => {
  if (req.url === '/evil.js') { remoteScriptRequests++; return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end('globalThis.__remoteRan = true') }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end('{"ok":true}')
})
const sockets = new WebSocketServer({ server: controller })
sockets.on('connection', socket => socket.send('controller-connected'))
let browser
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const remote = `http://127.0.0.1:${controller.address().port}`
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { browser = await chromium.launch({ headless: true, ...options }); break } catch {}
  }
  assert(browser, 'A Chromium browser is available')
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.addInitScript(() => {
    localStorage.setItem('miboard.locale', 'en')
    localStorage.setItem('miboard.theme', 'dark')
    globalThis.__cspViolations = []
    document.addEventListener('securitypolicyviolation', event => globalThis.__cspViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI }))
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + prefix + '#/setup')
  await page.locator('#backend-url').waitFor()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Hashed theme bootstrap executes')
  assert.deepEqual(await page.evaluate(() => globalThis.__cspViolations), [], 'App, styles and dynamic locale loads satisfy CSP')
  assert.deepEqual(await page.evaluate(async remote => {
    const response = await fetch(remote + '/configs')
    const data = await response.json()
    const message = await new Promise((resolve, reject) => {
      const socket = new WebSocket(remote.replace('http:', 'ws:') + '/connections')
      const timeout = setTimeout(() => { socket.close(); reject(new Error('WebSocket timed out')) }, 5000)
      socket.onmessage = event => { clearTimeout(timeout); resolve(event.data); socket.close() }
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket blocked')) }
    })
    return [data.ok, message]
  }, remote), [true, 'controller-connected'], 'HTTP and WebSocket controllers on a different origin remain accessible')
  await page.evaluate(remote => {
    const inline = document.createElement('script'); inline.textContent = 'globalThis.__inlineRan = true'; document.head.append(inline)
    const external = document.createElement('script'); external.src = remote + '/evil.js'; document.head.append(external)
    const button = document.createElement('button'); button.setAttribute('onclick', 'globalThis.__handlerRan = true'); document.body.append(button); button.click()
    const probe = document.createElement('script'); probe.src = './csp-probe.js'; document.head.append(probe)
  }, remote)
  await page.waitForFunction(() => globalThis.__cspViolations.length >= 4)
  assert.deepEqual(await page.evaluate(() => [!!globalThis.__inlineRan, !!globalThis.__remoteRan, !!globalThis.__handlerRan, !!globalThis.__evalRan, globalThis.__evalBlocked]), [false, false, false, false, true])
  assert.equal(remoteScriptRequests, 0, 'External scripts are blocked before a network request')
  assert.deepEqual(errors, [])
  console.log('PASS: CSP blocks injected scripts, handlers and eval; theme, nested hosting, lazy modules and remote HTTP/WebSocket controllers work')
} finally {
  await browser?.close()
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  server.close(); controller.close()
}
