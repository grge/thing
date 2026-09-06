/**
 * The dev server's resolve conditions.
 *
 * A configuration test, for a failure with no other signal: `resolve.conditions`
 * **replaces** Vite's defaults rather than adding to them. Naming only
 * `development` — which the engine's conditional exports want — silently drops
 * `browser`, and Svelte then resolves to its `default` export, which is the
 * *server* build. Everything compiles, `svelte-check` passes, `vite build`
 * succeeds, and the app throws `lifecycle_function_unavailable` from `mount()`
 * the moment it loads.
 *
 * The same shape as `boundary.test.ts`, and it lives beside it for the same
 * reason: guarding a configuration whose breakage is invisible until run time,
 * from the one package allowed to read files. `web` cannot host this test — it
 * is browser-typed and `node:fs` is a compile error there, which is the
 * platform boundary doing its job.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const config = readFileSync(
  fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
  'utf8',
);

describe('vite resolve conditions', () => {
  it('keeps `browser`, so Svelte resolves to its client build', () => {
    const conditions = /resolve:\s*\{\s*conditions:\s*\[([^\]]*)\]/.exec(config);
    expect(conditions, 'resolve.conditions should be set').not.toBeNull();
    expect(conditions![1]).toContain('browser');
  });

  it('keeps `development`, so the engine is bundled from source', () => {
    // The reason the conditions were overridden in the first place: without
    // this a dev server serves the engine's built output and an edit needs a
    // separate build step.
    const conditions = /resolve:\s*\{\s*conditions:\s*\[([^\]]*)\]/.exec(config);
    expect(conditions![1]).toContain('development');
  });

  it('svelte resolves `default` to its server build, which is why this matters', () => {
    // Asserting the *reason*, so this test explains itself if Svelte ever
    // changes and the guard becomes unnecessary.
    const svelte = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../node_modules/svelte/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { exports: Record<string, Record<string, string>> };

    expect(svelte.exports['.']!['default']).toContain('server');
    expect(svelte.exports['.']!['browser']).toContain('client');
  });
});
