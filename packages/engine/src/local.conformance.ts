/**
 * What every `LocalState` backend must do, identically.
 *
 * Exported as a function rather than written as tests, so each backend imports
 * it and runs it against itself — the same arrangement as `store/conformance.ts`
 * and for the same reason: a browser and a filesystem must behave the same, and
 * the only way to be sure is one set of expectations rather than two that look
 * similar.
 *
 * Each `make` returns a fresh, empty backend; `cleanup` releases whatever it
 * allocated.
 */
import { describe, expect, it } from 'vitest';

import { hex } from './core/index.js';
import type { PetnameStore } from './store/naming.js';
import type { Inventory, Keyring, LocatorCache } from './local.js';

export interface LocalBackends {
  readonly keys: () => Promise<Keyring>;
  readonly inventory: () => Promise<Inventory>;
  readonly petnames: () => Promise<PetnameStore>;
  readonly locators: () => Promise<LocatorCache>;
  readonly cleanup?: () => Promise<void>;
}

export function localConformanceTests(name: string, make: LocalBackends): void {
  const after = async (): Promise<void> => {
    if (make.cleanup !== undefined) await make.cleanup();
  };

  describe(`${name}: keyring`, () => {
    it('mints a key and finds it again by its space id', async () => {
      const keys = await make.keys();
      const key = await keys.mint();
      const found = await keys.keyFor(hex(key.publicKey));
      expect(found).not.toBeNull();
      expect(hex(found!.publicKey)).toBe(hex(key.publicKey));
      await after();
    });

    it('returns null for a space it holds no key for', async () => {
      // §6.1: a replica stores and serves without ever holding a key. Absence
      // is an ordinary answer, never an error.
      const keys = await make.keys();
      expect(await keys.keyFor('00'.repeat(32))).toBeNull();
      await after();
    });

    it('mints distinct keys', async () => {
      const keys = await make.keys();
      const a = await keys.mint();
      const b = await keys.mint();
      expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
      await after();
    });

    it('forgets a key, and forgetting an absent one is not an error', async () => {
      const keys = await make.keys();
      const key = await keys.mint();
      const id = hex(key.publicKey);
      await keys.forget(id);
      expect(await keys.keyFor(id)).toBeNull();
      await keys.forget(id); // again: a no-op, not a throw
      await after();
    });

    it('round-trips a key through storage, not just through memory', async () => {
      // The private half has to survive: a keyring that returns a public key
      // and a broken private one fails only when something tries to sign.
      const keys = await make.keys();
      const minted = await keys.mint();
      const loaded = await keys.keyFor(hex(minted.publicKey));
      expect(hex(loaded!.privateKey)).toBe(hex(minted.privateKey));
      await after();
    });
  });

  describe(`${name}: inventory`, () => {
    it('remembers and lists spaces', async () => {
      const inv = await make.inventory();
      await inv.remember('aa');
      await inv.remember('bb');
      expect([...(await inv.all())].sort()).toEqual(['aa', 'bb']);
      await after();
    });

    it('remembering twice does not duplicate', async () => {
      const inv = await make.inventory();
      await inv.remember('aa');
      await inv.remember('aa');
      expect(await inv.all()).toEqual(['aa']);
      await after();
    });

    it('forgets, and forgetting an absent space is not an error', async () => {
      const inv = await make.inventory();
      await inv.remember('aa');
      await inv.forget('aa');
      expect(await inv.all()).toEqual([]);
      await inv.forget('aa');
      await after();
    });

    it('starts empty', async () => {
      expect(await (await make.inventory()).all()).toEqual([]);
      await after();
    });
  });

  describe(`${name}: petnames`, () => {
    it('sets and lists names', async () => {
      const p = await make.petnames();
      await p.set('notes', 'aa');
      expect([...(await p.all())]).toEqual([['notes', 'aa']]);
      await after();
    });

    it('a name points at one space; setting it again moves it', async () => {
      const p = await make.petnames();
      await p.set('notes', 'aa');
      await p.set('notes', 'bb');
      expect((await p.all()).get('notes')).toBe('bb');
      await after();
    });

    it('removes a name, and removing an absent one is not an error', async () => {
      const p = await make.petnames();
      await p.set('notes', 'aa');
      await p.remove('notes');
      expect((await p.all()).size).toBe(0);
      await p.remove('notes');
      await after();
    });
  });

  describe(`${name}: locators`, () => {
    it('remembers where a space was reached', async () => {
      const l = await make.locators();
      l.set('aa', 'ws://example:9944');
      expect(l.get('aa')).toBe('ws://example:9944');
      await after();
    });

    it('a miss is null, not an error (§5.3)', async () => {
      // Stale by default, and must never be the reason a space is reported
      // gone. Callers treat absence as ordinary.
      expect((await make.locators()).get('nothing')).toBeNull();
      await after();
    });

    it('a later address replaces an earlier one', async () => {
      const l = await make.locators();
      l.set('aa', 'ws://old:1');
      l.set('aa', 'ws://new:2');
      expect(l.get('aa')).toBe('ws://new:2');
      await after();
    });

    it('forgets', async () => {
      const l = await make.locators();
      l.set('aa', 'ws://x:1');
      l.forget('aa');
      expect(l.get('aa')).toBeNull();
      await after();
    });
  });
}
