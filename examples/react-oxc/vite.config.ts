import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { minchoVitePlugin } from '@mincho-js/vite'
import type { PluginOption } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    minchoVitePlugin() as unknown as PluginOption,
    react(),
  ],
})
