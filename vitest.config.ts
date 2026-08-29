import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Renderer tests import .svelte components through the registry, so the
  // plugin has to be present even though nothing is mounted.
  plugins: [svelte({ configFile: fileURLToPath(new URL('./svelte.config.js', import.meta.url)) })],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
