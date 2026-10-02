import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

// Relative base so the build works from any GitHub Pages project path.
export default defineConfig({
  base: './',
  plugins: [svelte()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // OpenCV.js is a single ~13 MB module loaded only by the tracking worker.
    chunkSizeWarningLimit: 16000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
})
