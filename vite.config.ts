import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// base './' — дешборд работает из /ui/ и /ui/<external-ui-name>/ без пересборки
export default defineConfig({
  base: './',
  plugins: [svelte(), tailwindcss()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    reportCompressedSize: true,
  },
})
