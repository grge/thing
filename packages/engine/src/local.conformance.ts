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
import type { Locator } from './net/locator.js';
import { DROP_AFTER, KEEP_PER_SPACE } from './locators.js';

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

    it('mints a writing key for a space it does not own', async () => {
      // The join case (§5.1). The key must be findable under the *space's* id
      // while being a different key from the space itself — that split is what
      // `Space.open`'s `key`/`writer` pair has always expected.
      const keys = await make.keys();
      const someone = '11'.repeat(32);

      const writer = await keys.mintFor(someone);
      expect(hex(writer.publicKey)).not.toBe(someone);

      const found = await keys.keyFor(someone);
      expect(found).not.toBeNull();
      expect(hex(found!.publicKey)).toBe(hex(writer.publicKey));
      await after();
    });

    it('mintFor is idempotent: a second call keeps the first identity', async () => {
      // A second key would be a second writer wearing the same person's name,
      // and would orphan everything the first one signed.
      const keys = await make.keys();
      const someone = '22'.repeat(32);

      const first = await keys.mintFor(someone);
      const second = await keys.mintFor(someone);
      expect(hex(second.publicKey)).toBe(hex(first.publicKey));
      await after();
    });

    it('mints a different identity per space', async () => {
      // §5.1: identity is per-space, not global.
      const keys = await make.keys();
      const a = await keys.mintFor('33'.repeat(32));
      const b = await keys.mintFor('44'.repeat(32));
      expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));
      await after();
    });

    it('mintFor does not disturb a key the client already owns', async () => {
      // Calling it on your *own* space must not replace the key that is that
      // space's identity — that would be §5.1.1's unrecoverable loss.
      const keys = await make.keys();
      const own = await keys.mint();
      const id = hex(own.publicKey);

      const same = await keys.mintFor(id);
      expect(hex(same.publicKey)).toBe(id);
      expect(hex((await keys.keyFor(id))!.privateKey)).toBe(hex(own.privateKey));
      await after();
    });

    it('imports a key that really is the space it claims', async () => {
      // The other half of `exportKey`. §5.1.1 lists "an explicit export the
      // user is prompted to keep" among its answers to key loss, and an export
      // nobody can restore is half a mechanism.
      const source = await make.keys();
      const minted = await source.mint();
      const id = hex(minted.publicKey);
      const seed = hex(minted.privateKey);

      const target = await make.keys();
      expect(await target.importFor(id, seed)).toBe(true);
      expect(hex((await target.keyFor(id))!.publicKey)).toBe(id);
      await after();
    });

    it('refuses a seed for a different space', async () => {
      // **A space *is* its public key** (§5.1), so accepting this would install
      // one space's identity under another's name — the failure the read-only
      // fallback exists to prevent, arrived at from the other direction.
      const keys = await make.keys();
      const a = await keys.mint();
      const b = await keys.mint();

      expect(await keys.importFor(hex(a.publicKey), hex(b.privateKey))).toBe(false);
      await after();
    });

    it('refuses junk rather than throwing', async () => {
      // A pasted seed is ordinary input, and being wrong is an ordinary
      // outcome.
      const keys = await make.keys();
      const id = hex((await keys.mint()).publicKey);
      for (const junk of ['', 'nonsense', 'zz'.repeat(32), 'aa', ' ']) {
        expect(await keys.importFor(id, junk)).toBe(false);
      }
      await after();
    });

    it('accepts a seed with surrounding whitespace, which pasting carries', async () => {
      const source = await make.keys();
      const minted = await source.mint();
      const id = hex(minted.publicKey);

      const target = await make.keys();
      expect(await target.importFor(id, `  ${hex(minted.privateKey)}\n`)).toBe(true);
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

  /**
   * Reading keys (§6), which every backend must hold **beside** its writing
   * keys rather than among them. `ENCRYPTION-PLAN.md` puts "a peer without the
   * key can do X" here deliberately: the claim is about all three backends, so
   * one set of expectations is the only way to be sure they agree.
   */
  describe(`${name}: reading keys`, () => {
    const reading = new Uint8Array(32).fill(9);

    it('keeps a reading key and finds it again', async () => {
      const keys = await make.keys();
      await keys.setReading('aa', reading);
      const found = await keys.readingFor('aa');
      expect(found).not.toBeNull();
      expect(hex(found!)).toBe(hex(reading));
      await after();
    });

    it('returns null for a space it can replicate but not read', async () => {
      // The ordinary case, not a degraded one (§6.1).
      const keys = await make.keys();
      expect(await keys.readingFor('00'.repeat(32))).toBeNull();
      await after();
    });

    it('holds a reading key for a space it cannot write', async () => {
      // The capabilities are separate (`docs/design/CAPABILITIES.md`): reading
      // and writing are held independently, and either without the other is a
      // state a client must be able to be in.
      const keys = await make.keys();
      await keys.setReading('bb', reading);
      expect(await keys.keyFor('bb')).toBeNull();
      expect(await keys.readingFor('bb')).not.toBeNull();
      await after();
    });

    it('holds a writing key for a space it cannot read', async () => {
      const keys = await make.keys();
      const minted = await keys.mint();
      const id = hex(minted.publicKey);
      expect(await keys.keyFor(id)).not.toBeNull();
      expect(await keys.readingFor(id)).toBeNull();
      await after();
    });

    it('replaces a reading key rather than keeping both', async () => {
      const keys = await make.keys();
      await keys.setReading('cc', reading);
      const other = new Uint8Array(32).fill(4);
      await keys.setReading('cc', other);
      expect(hex((await keys.readingFor('cc'))!)).toBe(hex(other));
      await after();
    });

    it('forgets a reading key along with the space', async () => {
      const keys = await make.keys();
      await keys.setReading('dd', reading);
      await keys.forget('dd');
      expect(await keys.readingFor('dd')).toBeNull();
      await after();
    });

    it('refuses a key of the wrong length', async () => {
      // A truncated key is not a weaker key, it is a different one — and it
      // would fail as an authentication error at every read, which looks like
      // corruption rather than like a mistake made here.
      const keys = await make.keys();
      await expect(keys.setReading('ee', new Uint8Array(16))).rejects.toThrow();
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
    const ws = (url: string): Locator => ({ kind: 'ws', url });

    it('remembers where a space was reached', async () => {
      const l = await make.locators();
      l.remember('aa', ws('ws://example:9944'));
      expect(l.get('aa')).toEqual([ws('ws://example:9944')]);
      await after();
    });

    it('a miss is empty, not an error (§5.3)', async () => {
      // Stale by default, and must never be the reason a space is reported
      // gone. Callers treat absence as ordinary.
      expect((await make.locators()).get('nothing')).toEqual([]);
      await after();
    });

    it('keeps several candidates for one space', async () => {
      // The reason this is a list: a space may be reachable at a LAN address
      // *and* through a hub, and which one works is a per-client fact.
      const l = await make.locators();
      l.remember('aa', ws('ws://lan:1'));
      l.remember('aa', ws('ws://hub:2'));
      expect(l.get('aa')).toHaveLength(2);
      await after();
    });

    it('what worked sorts first', async () => {
      const l = await make.locators();
      l.remember('aa', ws('ws://first:1'));
      l.remember('aa', ws('ws://second:2'));
      l.succeeded('aa', ws('ws://second:2'));
      expect(l.get('aa')[0]).toEqual(ws('ws://second:2'));
      await after();
    });

    it('hearing about a known locator again does not clear its history', async () => {
      // Being told about it is not evidence that it works, and overwriting
      // would discard the failures that had sunk it.
      const l = await make.locators();
      l.remember('aa', ws('ws://a:1'));
      l.remember('aa', ws('ws://b:2'));
      l.succeeded('aa', ws('ws://b:2'));
      l.remember('aa', ws('ws://b:2'));
      expect(l.get('aa')[0]).toEqual(ws('ws://b:2'));
      await after();
    });

    it('drops a locator that has only ever failed', async () => {
      const l = await make.locators();
      l.remember('aa', ws('ws://wrong:1'));
      for (let i = 0; i < DROP_AFTER; i++) l.failed('aa', ws('ws://wrong:1'));
      expect(l.get('aa')).toEqual([]);
      await after();
    });

    it('keeps one that worked before, however much it fails now', async () => {
      // "This address is wrong" and "nobody is home right now" are different,
      // and only the first is worth forgetting.
      const l = await make.locators();
      l.remember('aa', ws('ws://real:1'));
      l.succeeded('aa', ws('ws://real:1'));
      for (let i = 0; i < DROP_AFTER + 2; i++) l.failed('aa', ws('ws://real:1'));
      expect(l.get('aa')).toEqual([ws('ws://real:1')]);
      await after();
    });

    it('bounds how many it keeps', async () => {
      const l = await make.locators();
      for (let i = 0; i < KEEP_PER_SPACE + 5; i++) l.remember('aa', ws(`ws://h${i}:1`));
      expect(l.get('aa').length).toBeLessThanOrEqual(KEEP_PER_SPACE);
      await after();
    });

    it('holds a via locator, which is how a browser is reached', async () => {
      const l = await make.locators();
      const via: Locator = { kind: 'via', url: 'wss://signal:1', peer: 'sess-7' };
      l.remember('aa', via);
      expect(l.get('aa')).toEqual([via]);
      await after();
    });

    it('reads a cache an older version wrote', async () => {
      // This is persisted by the client, and an earlier version stored one URL
      // string per space. A client that upgrades finds those still there —
      // reading one as a candidate that has never been tried beats crashing,
      // which is what a bare `.map` over a string did.
      const l = await make.locators();
      (l as unknown as { state: Record<string, unknown> }).state = {
        old: 'ws://typed-in:9944',
      };
      expect(l.get('old')).toEqual([ws('ws://typed-in:9944')]);
      // And it still ranks: remembering another does not lose the first.
      l.remember('old', ws('ws://learned:2'));
      expect(l.get('old')).toHaveLength(2);
      await after();
    });

    it('forgets', async () => {
      const l = await make.locators();
      l.remember('aa', ws('ws://x:1'));
      l.forget('aa');
      expect(l.get('aa')).toEqual([]);
      await after();
    });
  });
}
