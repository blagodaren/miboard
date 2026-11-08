// Run the dashboard checks against a built release, without a Vite dev server.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = path.join(root, 'dist')
const secret = 'dashboard-ui-check'
const steps = [
  ['scripts/test-overview.mjs', 'MIBOARD_OVERVIEW_URL'],
  ['scripts/test-devices-ui.mjs', 'MIBOARD_DEVICES_URL'],
  ['scripts/check-geography.mjs', 'MIBOARD_TEST_URL'],
  ['scripts/check-theme.mjs', 'MIBOARD_THEME_URL'],
]
let frontend
let activeStep

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function launch(script, env, capture = false) {
  const child = spawn(process.execPath, [path.join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  })
  const state = { child, output: '', error: null, stopped: false, closed: null }
  if (capture) {
    const append = chunk => { state.output = `${state.output}${chunk}`.slice(-16_384) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
  }
  state.closed = new Promise(resolve => {
    child.on('error', error => {
      state.error = error
      state.stopped = true
      resolve({ error })
    })
    child.on('close', (code, signal) => {
      state.stopped = true
      resolve({ code, signal })
    })
  })
  return state
}

async function ready(state, origin, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (state.error) throw state.error
    if (state.stopped) throw new Error(`Dashboard frontend stopped during startup:\n${state.output}`)
    try {
      const version = await fetch(`${origin}/version`, {
        headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(1000),
      })
      if (version.ok) {
        const index = await fetch(`${origin}/ui/`, { signal: AbortSignal.timeout(1000) })
        if (index.ok && (await index.text()).includes('<html')) return
      }
    } catch { /* The child can be listening before it can answer the first request. */ }
    await delay(50)
  }
  throw new Error(`Timed out starting the dashboard frontend at ${origin}:\n${state.output}`)
}

async function waitForClose(state, timeout) {
  let timer
  try {
    return await Promise.race([
      state.closed,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stop(state) {
  if (!state || state.stopped) return
  state.child.kill('SIGTERM')
  if (await waitForClose(state, 5000)) return
  state.child.kill('SIGKILL')
  if (!await waitForClose(state, 5000)) throw new Error(`Could not stop dashboard check process ${state.child.pid}`)
}

try {
  await access(path.join(dist, 'index.html')).catch(() => {
    throw new Error('Missing dist/index.html. Run npm run build before the dashboard UI checks.')
  })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const base = `${origin}/ui/`
  frontend = launch('mock/server.js', {
    PORT: String(port), SECRET: secret, MIBOARD_UI_DIR: dist,
  }, true)
  await ready(frontend, origin)
  console.log(`Dashboard UI checks: ${base}`)

  for (const [script, variable] of steps) {
    console.log(`\nRunning ${script}`)
    activeStep = launch(script, { [variable]: base })
    const result = await activeStep.closed
    activeStep = null
    if (result.error) throw result.error
    if (result.code !== 0) {
      process.exitCode = Number.isInteger(result.code) && result.code > 0 ? result.code : 1
      throw new Error(`${script} failed (${result.signal ?? `exit ${result.code}`})`)
    }
    if (frontend.stopped) throw new Error(`Dashboard frontend stopped:\n${frontend.output}`)
  }
  console.log('\nPASS: overview, devices, geography and ten-screen theme checks against dist/')
} catch (error) {
  process.exitCode ||= 1
  console.error(error.stack ?? error.message ?? error)
} finally {
  try {
    await stop(activeStep)
    await stop(frontend)
  } catch (error) {
    process.exitCode ||= 1
    console.error(error.stack ?? error.message ?? error)
  }
}
