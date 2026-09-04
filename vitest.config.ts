import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // archive/ is the previous design, kept readable but not built or tested.
    exclude: ['**/node_modules/**', 'archive/**'],
  },
});
