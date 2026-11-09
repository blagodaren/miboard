// Rasterize the existing brand mark; no separate icon design or font dependency.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const mark = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
let browser
for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
  try { browser = await chromium.launch({ headless: true, ...options }); break } catch { /* Use an installed browser. */ }
}
if (!browser) throw new Error('No Chromium browser available for icon generation')
try {
  const page = await browser.newPage()
  await mkdir(new URL('../public/icons/', import.meta.url), { recursive: true })
  for (const [file, size, maskable] of [
    ['icons/pwa-192.png', 192, false], ['icons/pwa-512.png', 512, false],
    ['icons/pwa-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, false],
  ]) {
    const png = await page.evaluate(async ({ mark, size, maskable }) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      context.fillStyle = '#0f0f10'
      context.fillRect(0, 0, size, size)
      const icon = new Image()
      icon.src = `data:image/svg+xml,${encodeURIComponent(mark)}`
      await icon.decode()
      const inset = size * (maskable ? 0.2 : 0.1)
      context.drawImage(icon, inset, inset, size - 2 * inset, size - 2 * inset)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { mark, size, maskable })
    await writeFile(new URL(`../public/${file}`, import.meta.url), Buffer.from(png, 'base64'))
  }
} finally { await browser.close() }
