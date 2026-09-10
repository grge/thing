/**
 * Chain state: what a store will admit, and what it rebuilds on open.
 *
 * **The load path had no test, and that is where the bug was.** `append`
 * deduplicates, so within one process a log holds each event once — but a log
 * is a file, and anything that wrote around a live store, or a crash between
 * the write and the state update, leaves copies. Reopening then has to cope.
 */
import { describe, expect, it } from 'vitest';

import { chainOf, type Event, keyPairFromSeed, ROOT, SEED_LEN, Writer } from '../core/index.js';
import { ChainSet } from './chainstate.js';

const UTF8 = new TextEncoder();

function labelled(label: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) out[i] = label.charCodeAt(i);
  return out;
}

/** A chain of `n` events from one writer, as `makeFile` would produce. */
async function chain(n: number): Promise<{ key: Uint8Array; events: Event[] }> {
  const key = await keyPairFromSeed(labelled('space', SEED_LEN));
  const w = new Writer(key.publicKey, key);
  const events: Event[] = [];
  for (let i = 0; i < n; i++) {
    events.push(await w.write(ROOT, `:a${i}`, UTF8.encode(`v${i}`), i));
  }
  return { key: key.publicKey, events };
}

describe('rebuilding chain state from a log', () => {
  it('reaches the last event', async () => {
    const { key, events } = await chain(5);
    const chains = new ChainSet(key);
    await chains.load(events);
    expect(chains.chain(chainOf(events[0]!)).frontier).toBe(4);
  });

  it('survives a log holding every event more than once', async () => {
    // **The bug.** Sorting by seq puts duplicates adjacent — `0, 0, 0, 1, …` —
    // so a strict `frontier + 1` check stopped at the second copy of seq 0 and
    // pinned the chain there forever. Every later event became a permanent
    // gap: the space showed a file with a name, no `:kind`, no `:body`, and a
    // folder icon, because only the first two events had ever been folded.
    const { key, events } = await chain(5);
    const trebled = [...events, ...events, ...events];

    const chains = new ChainSet(key);
    await chains.load(trebled);
    expect(chains.chain(chainOf(events[0]!)).frontier).toBe(4);
  });

  it('still stops at a genuine gap', async () => {
    // Duplicates are skipped; a hole is not. The frontier is by definition the
    // highest *contiguous* sequence number (§2.3), and events after a gap are
    // held aside rather than applied (§2.5).
    const { key, events } = await chain(5);
    const holed = [events[0]!, events[1]!, events[3]!, events[4]!];

    const chains = new ChainSet(key);
    await chains.load(holed);
    expect(chains.chain(chainOf(events[0]!)).frontier).toBe(1);
  });

  it('rebuilds from a log in any order', async () => {
    const { key, events } = await chain(5);
    const chains = new ChainSet(key);
    await chains.load([...events].reverse());
    expect(chains.chain(chainOf(events[0]!)).frontier).toBe(4);
  });

  it('refuses a duplicate once loaded', async () => {
    const { key, events } = await chain(3);
    const chains = new ChainSet(key);
    await chains.load(events);
    expect((await chains.admit(events[1]!))?.kind).toBe('duplicate');
  });
});
