import { defineConfig } from 'vite'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueJsxInspector from '../src/index.ts'

export default defineConfig({
  plugins: [
    vueJsx(),
    vueJsxInspector(),
  ],
})
