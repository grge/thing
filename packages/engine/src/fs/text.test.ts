/**
 * A text document two people edit at once — §3.8's bet, exercised.
 *
 * The sequence rule was built and pinned before anything used it. These are the
 * first tests that put it under an *editor* rather than a synthetic operation
 * list, and the property that matters is the one the whole design rests on:
 * **two writers editing concurrently converge**, without either knowing about
 * the other's edit when it was made.
 */
import { describe, expect, it } from 'vitest';

import { generateKeyPair, hex, type KeyPair, keyPairFromSeed, ROOT, SEED_LEN } from '../core/index.js';
import { MemoryStore } from '../store/index.js';
import { Space } from '../space.js';
import { edit, makeText, readText, runs, writeText } from './text.js';

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

async function openSpace(store: MemoryStore, key: KeyPair, writer: KeyPair = key): Promise<Space> {
  let tick = 0;
  const s = await store.open(hex(key.publicKey), key.publicKey);
  return Space.open(s, { key: key.publicKey, writer, now: () => (tick += 1) });
}

describe('a text document', () => {
  it('starts empty and takes text', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await openSpace(new MemoryStore(), key);
    const doc = await makeText(space, 'notes.txt');

    expect(readText(space.state, doc)).toBe('');
    await writeText(space, doc, 'hello');
    expect(readText(space.state, doc)).toBe('hello');
  });

  it('appends without rewriting what is there', async () => {
    // The reason to diff against runs: typing at the end must not replace the
    // paragraph before it, or every keystroke rewrites the document.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await openSpace(new MemoryStore(), key);
    const doc = await makeText(space, 'notes.txt');

    await writeText(space, doc, 'hello');
    const before = runs(space.state, doc);
    await writeText(space, doc, 'hello world');

    expect(readText(space.state, doc)).toBe('hello world');
    // The original run survives, with the new text as its own element.
    expect(runs(space.state, doc)[0]!.id).toBe(before[0]!.id);
  });

  it('writes nothing when the text is unchanged', async () => {
    // So a caller may run this on every keystroke.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await openSpace(new MemoryStore(), key);
    const doc = await makeText(space, 'notes.txt');
    await writeText(space, doc, 'stable');

    expect(await writeText(space, doc, 'stable')).toBe(0);
  });

  it('deletes', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await openSpace(new MemoryStore(), key);
    const doc = await makeText(space, 'notes.txt');
    await writeText(space, doc, 'hello world');
    await writeText(space, doc, '');
    expect(readText(space.state, doc)).toBe('');
  });

  it('edits in the middle', async () => {
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const space = await openSpace(new MemoryStore(), key);
    const doc = await makeText(space, 'notes.txt');
    await writeText(space, doc, 'the quick fox');
    await writeText(space, doc, 'the quick brown fox');
    expect(readText(space.state, doc)).toBe('the quick brown fox');
  });

  it('proposes nothing for an unchanged document', () => {
    // `edit` is pure, so this is checkable without a space.
    const empty = { objects: new Map() } as never;
    expect(edit(empty, new Uint8Array(16), '')).toEqual([]);
  });
});

describe('two writers editing at once (§3.8)', () => {
  it('converge on concurrent inserts at different points', async () => {
    // **The claim the whole design rests on.** Neither writer saw the other's
    // edit when making their own; both must end at the same text.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await generateKeyPair();

    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    const a = await openSpace(storeA, key);
    // The space key admits the second writer (§7.2.1).
    await a.write(ROOT, ':writers', new TextEncoder().encode(
      `${hex(key.publicKey)},${hex(other.publicKey)}`,
    ));
    const doc = await makeText(a, 'shared.txt');
    await writeText(a, doc, 'hello world');

    // B starts from A's state, then both edit without seeing each other.
    const bStore = await storeB.open(hex(key.publicKey), key.publicKey);
    const b = await Space.open(bStore, { key: key.publicKey, writer: other, now: () => 100 });
    const fromA = await drain(storeA, key);
    await b.receive(fromA);

    await writeText(a, doc, 'hello brave world');
    await writeText(b, doc, 'hello world!');

    // Exchange.
    await b.receive(await drain(storeA, key));
    await a.receive(await drain(storeB, key));

    const textA = readText(a.state, doc);
    const textB = readText(b.state, doc);
    expect(textA).toBe(textB);
    // And neither edit was lost.
    expect(textA).toContain('brave');
    expect(textA).toContain('!');
  });

  it('converge when both replace the same run', async () => {
    // The stated limitation: two edits *inside one run* do not merge character
    // by character. They must still converge — one order, both peers.
    const key = await keyPairFromSeed(labelled('space', SEED_LEN));
    const other = await generateKeyPair();
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();

    const a = await openSpace(storeA, key);
    await a.write(ROOT, ':writers', new TextEncoder().encode(
      `${hex(key.publicKey)},${hex(other.publicKey)}`,
    ));
    const doc = await makeText(a, 'shared.txt');
    await writeText(a, doc, 'original');

    const bStore = await storeB.open(hex(key.publicKey), key.publicKey);
    const b = await Space.open(bStore, { key: key.publicKey, writer: other, now: () => 100 });
    await b.receive(await drain(storeA, key));

    await writeText(a, doc, 'from A');
    await writeText(b, doc, 'from B');

    await b.receive(await drain(storeA, key));
    await a.receive(await drain(storeB, key));

    expect(readText(a.state, doc)).toBe(readText(b.state, doc));
  });
});

/** Every event a store holds, for shipping to the other peer. */
async function drain(store: MemoryStore, key: KeyPair): Promise<never[]> {
  const out: never[] = [];
  const s = await store.open(hex(key.publicKey), key.publicKey);
  for await (const e of s.readAll()) out.push(e as never);
  return out;
}
