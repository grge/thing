/**
 * The platform boundary, asserted rather than assumed.
 *
 * `@thing/engine` must compile without DOM or Node types, or it cannot be the
 * one implementation both a browser tab and a headless server run
 * (ARCHITECTURE.md §5.6). That is enforced by `"types": []` and an ES2022-only
 * `lib`, so a stray `localStorage` is a compile error rather than a run-time
 * surprise in a server.
 *
 * This test guards the *configuration*: it is easy to add `"types": ["node"]`
 * to fix one import and silently lose the property. It also guards the
 * *dependency direction* — the engine must never import from the packages that
 * embed it, which would make it platform-bound by a different route.
 *
 * It lives in `node` because it reads files, which the package it checks
 * cannot do — the boundary applies to its own test as much as to anything else.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);

function tsconfigOf(pkg: string): {
  compilerOptions?: { types?: string[]; lib?: string[] };
} {
  return JSON.parse(readFileSync(new URL(`packages/${pkg}/tsconfig.json`, ROOT), 'utf8'));
}

/** Every source file in a package, recursively. */
function sourcesOf(pkg: string): string[] {
  const base = fileURLToPath(new URL(`packages/${pkg}/src`, ROOT));
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') || name.endsWith('.svelte')) out.push(path);
    }
  };
  walk(base);
  return out;
}

describe('platform boundary', () => {
  it('the engine declares no ambient types', () => {
    expect(tsconfigOf('engine').compilerOptions?.types).toEqual([]);
  });

  it('the engine inherits an ES2022-only lib', () => {
    // Absent means inherited from tsconfig.base.json, which is ES2022 with no
    // DOM. Present would mean someone widened it.
    expect(tsconfigOf('engine').compilerOptions?.lib).toBeUndefined();
  });

  it('web opts into DOM explicitly, and only DOM', () => {
    const opts = tsconfigOf('web').compilerOptions;
    expect(opts?.lib).toContain('DOM');
    expect(opts?.types).toEqual([]);
  });

  it('node opts into Node types explicitly', () => {
    expect(tsconfigOf('node').compilerOptions?.types).toEqual(['node']);
  });

  it('the engine depends on nothing that embeds it', () => {
    // The dependency runs one way: node and web import the engine, never the
    // reverse. An engine that reached back into either would be platform-bound
    // without ever mentioning a DOM type.
    const offenders = sourcesOf('engine').filter((f) =>
      /from '@thing\/(node|web)'/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the engine imports no Node builtins', () => {
    // `node:fs` and friends compile happily under `"types": []` if a package
    // ships its own declarations, so the config check alone is not enough.
    const offenders = sourcesOf('engine').filter((f) =>
      /from '(node:|fs|path|crypto|net|http)'/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
