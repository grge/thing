/**
 * The platform boundary, asserted rather than assumed.
 *
 * `core`, `net`, `store` and `peer` must compile without DOM or Node types, or
 * the headless peer cannot exist (ARCHITECTURE.md §5.6 — a peer with a stable
 * address is not a different kind of participant). That is enforced by
 * `"types": []` and an ES2022-only `lib` in each package's tsconfig, so a stray
 * `localStorage` is a compile error rather than a run-time surprise in Node.
 *
 * This test guards the *configuration*: it is easy to add `"types": ["node"]`
 * to fix one import and silently lose the property everywhere.
 *
 * It lives in `node` because it reads files, which the packages it checks
 * cannot do — the boundary applies to its own test as much as to anything else.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

function tsconfigOf(pkg: string): {
  compilerOptions?: { types?: string[]; lib?: string[] };
} {
  return JSON.parse(readFileSync(new URL(`packages/${pkg}/tsconfig.json`, ROOT), 'utf8'));
}

/** The packages that must run identically in a browser and in Node. */
const PLATFORM_FREE = ['core', 'net', 'store', 'peer'];

describe('platform boundary', () => {
  it.each(PLATFORM_FREE)('%s declares no ambient types', (pkg) => {
    expect(tsconfigOf(pkg).compilerOptions?.types).toEqual([]);
  });

  it.each(PLATFORM_FREE)('%s inherits an ES2022-only lib', (pkg) => {
    // Absent means inherited from tsconfig.base.json, which is ES2022 with no
    // DOM. Present would mean someone widened it for this package.
    expect(tsconfigOf(pkg).compilerOptions?.lib).toBeUndefined();
  });

  it('web opts into DOM explicitly, and only DOM', () => {
    const opts = tsconfigOf('web').compilerOptions;
    expect(opts?.lib).toContain('DOM');
    expect(opts?.types).toEqual([]);
  });

  it('node opts into Node types explicitly', () => {
    expect(tsconfigOf('node').compilerOptions?.types).toEqual(['node']);
  });
});
