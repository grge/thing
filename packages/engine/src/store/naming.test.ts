/**
 * Naming spaces (§5.5).
 *
 * The property worth testing is that an ambiguous name is an **error**, not a
 * guess: silently opening one of two spaces because they share a name is the
 * kind of mistake found much later.
 */
import { codeFor, keyPairFromSeed, SEED_LEN } from '../core/index.js';
import { describe, expect, it } from 'vitest';
import { namesFor, resolveName, type SpaceNames } from './naming.js';

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function space(seed: string, opts: { petname?: string; suggested?: string } = {}) {
  const key = await keyPairFromSeed(labelled(seed, SEED_LEN));
  return {
    names: namesFor(key.publicKey, {
      petname: opts.petname ?? null,
      suggested: opts.suggested ?? null,
    }),
    key,
  };
}

describe('what a space is called', () => {
  it('prefers a petname, then the suggested name, then the code', async () => {
    const bare = await space('a');
    expect(bare.names.display).toBe(bare.names.code);

    const named = await space('a', { suggested: 'shared docs' });
    expect(named.names.display).toBe('shared docs');

    const mine = await space('a', { suggested: 'shared docs', petname: 'work' });
    expect(mine.names.display).toBe('work');
  });

  it('never displays a bare key', async () => {
    // 64 hex characters is unreadable and untypeable, which is what the code
    // exists for (§5.4).
    const s = await space('a');
    expect(s.names.display).not.toBe(s.names.id);
    expect(s.names.display).toHaveLength(8);
  });
});

describe('resolving a name', () => {
  it('finds a space by each of its names', async () => {
    const s = await space('a', { suggested: 'docs', petname: 'work' });
    const all: SpaceNames[] = [s.names];

    for (const query of ['work', 'docs', s.names.code, s.names.id, s.names.id.slice(0, 8)]) {
      const found = resolveName(query, all);
      expect(found.ok, query).toBe(true);
      if (found.ok) expect(found.id).toBe(s.names.id);
    }
  });

  it('a full key resolves even for a space this client does not hold', async () => {
    // Joining is how a space arrives, so there is nothing local to match.
    const s = await space('a');
    const found = resolveName(s.names.id, []);
    expect(found.ok).toBe(true);
  });

  it('prefers a petname over another space’s suggested name', async () => {
    // The point of §4.6's ordering: what *this* client calls a thing wins.
    const mine = await space('a', { petname: 'notes' });
    const theirs = await space('b', { suggested: 'notes' });

    const found = resolveName('notes', [mine.names, theirs.names]);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.id).toBe(mine.names.id);
  });

  it('refuses an ambiguous name rather than guessing', async () => {
    const one = await space('a', { suggested: 'notes' });
    const two = await space('b', { suggested: 'notes' });

    const found = resolveName('notes', [one.names, two.names]);
    expect(found.ok).toBe(false);
    if (!found.ok) {
      expect(found.why.kind).toBe('ambiguous');
      if (found.why.kind === 'ambiguous') expect(found.why.matches).toHaveLength(2);
    }
  });

  it('says when it knows nothing by that name', async () => {
    const found = resolveName('nothing', []);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.why.kind).toBe('unknown');
  });

  it('is case-insensitive', async () => {
    const s = await space('a', { suggested: 'Docs' });
    expect(resolveName('docs', [s.names]).ok).toBe(true);
  });

  it('two spaces may share a name without conflict, until one is asked for', async () => {
    // §5.5: two different spaces can share a name. That is legal; it only
    // becomes a problem when someone types it.
    const one = await space('a', { suggested: 'notes' });
    const two = await space('b', { suggested: 'notes' });
    expect(one.names.id).not.toBe(two.names.id);
    expect(codeFor(one.key.publicKey)).not.toBe(codeFor(two.key.publicKey));
  });
});
