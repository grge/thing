import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Run against source, not build output: a test that passes only after `tsc`
  // is a test that lies about which change broke it.
  resolve: { conditions: ['development'] },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // archive/ is the previous design, kept readable but not built or tested.
    exclude: ['**/node_modules/**', 'archive/**'],
  },
});
