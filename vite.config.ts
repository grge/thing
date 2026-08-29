import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'src/ui',
  // GitHub Pages serves the project at /<repo>/, so assets need that prefix.
  // Locally the base stays '/' — set BASE_PATH only in CI.
  base: process.env['BASE_PATH'] ?? '/',
  // The Svelte config lives at the repo root, not under `root`.
  plugins: [svelte({ configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)) })],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // The app, and the stage 4 transport harness alongside it.
        main: fileURLToPath(new URL('./src/ui/index.html', import.meta.url)),
        transport: fileURLToPath(new URL('./src/ui/transport.html', import.meta.url)),
      },
    },
  },
});
