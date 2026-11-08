import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { FONT_SOURCES } from './scripts/font-sources.mjs'

// base './' — дешборд работает из /ui/ и /ui/<external-ui-name>/ без пересборки
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    {
      name: 'cdn-font-sources',
      apply: 'build',
      enforce: 'pre',
      transform(source, id) {
        if (mode !== 'cdn-fonts' || !id.split('?')[0].replaceAll('\\', '/').endsWith('/src/app.css')) return
        for (const font of FONT_SOURCES) {
          if (source.split(font.local).length !== 2) throw new Error(`Expected one font reference: ${font.local}`)
          source = source.replace(font.local, font.cdn)
        }
        return source
      },
    },
    svelte(),
    tailwindcss(),
  ],
  build: {
    outDir: mode === 'cdn-fonts' ? 'dist-cdn-fonts' : 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
}))
