import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the build works from any static host sub-path (e.g. GitHub/Cloudflare Pages).
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  // transformers.js ships its own ONNX runtime WASM; pre-bundling breaks its asset loading.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
})
