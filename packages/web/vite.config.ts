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
  //
  // **`browser` must be listed explicitly.** `resolve.conditions` *replaces*
  // Vite's defaults rather than adding to them, so naming only `development`
  // drops `browser` — and Svelte then resolves to its `default` export, which
  // is the *server* build. `mount()` throws `lifecycle_function_unavailable`
  // the moment the app starts, with nothing in the build output to suggest why.
  resolve: { conditions: ['development', 'browser', 'module', 'import'] },
  build: { outDir: 'dist-app', emptyOutDir: true },
});
