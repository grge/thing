import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: process.env['BASE_PATH'] ?? '/',
  plugins: [
    svelte({ configFile: fileURLToPath(new URL('../../svelte.config.js', import.meta.url)) }),
  ],
  // Bundle the engine from source rather than dist, so a dev server reflects
  // an edit without a separate build step.
  resolve: { conditions: ['development'] },
  build: { outDir: 'dist-app', emptyOutDir: true },
});
