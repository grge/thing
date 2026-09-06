/**
 * The fakes themselves, because a wrong fake produces wrong tests.
 *
 * This file exists for one reason: a fake transport that delivered frames
 * concurrently made a `Session` report the same event three times, and several
 * hours went into looking for that bug in the client. The rules in
 * `testwire.ts` are the fix; these are what keep them true.
 */
import { describe, expect, it } from 'vitest';

import { generateKeyPair, hex, ROOT, Writer } from '../core/index.js';
import { MemoryStore } from '../store/index.js';
import { Session } from './session.js';
import { connectionPair } from './testwire.js';

const UTF8 = new TextEncoder();

describe('connectionPair', () => {
  it('never delivers inside send', () => {
    // Rule 1. A real transport always yields first; a Session that saw its own
    // frames arrive re-entrantly would meet conditions it never meets live.
    const [a, b] = connectionPair();
    const seen: string[] = [];
    b.onFrame(() => seen.push('delivered'));

    a.channel.send(Uint8Array.of(1));
    expect(seen).toEqual([]); // still nothing, synchronously
  });

  it('delivers one frame at a time even when a handler is slow', async () => {
    // Rule 2, and the one that actually bit. Handlers are async; if a second
    // frame can start before the first finishes, anything that reads state
    // before writing it sees a stale view — which is exactly what
    // `Session.receive` does.
    const [a, b] = connectionPair();
    let inFlight = 0;
    let overlapped = false;

    b.onFrame(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise<void>((r) => setTimeout(() => r(), 1));
      inFlight -= 1;
    });

    for (let i = 0; i < 5; i++) a.channel.send(Uint8Array.of(i));
    await new Promise<void>((r) => setTimeout(() => r(), 50));

    expect(overlapped).toBe(false);
  });

  it('copies the frame, so a reused buffer cannot corrupt delivery', async () => {
    // Rule 3. `send` may hand over a buffer its caller intends to reuse.
    const [a, b] = connectionPair();
    const received: number[] = [];
    b.onFrame((d) => received.push(d[0]!));

    const buffer = Uint8Array.of(7);
    a.channel.send(buffer);
    buffer[0] = 99; // the caller reuses it immediately
    await new Promise<void>((r) => setTimeout(() => r(), 10));

    expect(received).toEqual([7]);
  });

  it('does not make a Session report one event more than once', async () => {
    // The original symptom, pinned end to end. A peer legitimately sends the
    // same range more than once (reconciliation on HELLO, then answering a
    // WANT) and the store deduplicates — so `onEvents` must fire only for what
    // actually entered the log. Concurrent delivery breaks that, silently.
    const key = await generateKeyPair();
    const id = hex(key.publicKey);

    const storeA = await new MemoryStore().open(id, key.publicKey);
    const storeB = await new MemoryStore().open(id, key.publicKey);
    const writer = new Writer(key.publicKey, key);
    await storeA.append([await writer.write(ROOT, ':name', UTF8.encode('once'), 1)]);

    const [wireA, wireB] = connectionPair();
    const delivered: string[] = [];

    const a = new Session(storeA, wireA.channel, { peer: 'b' });
    const b = new Session(storeB, wireB.channel, {
      peer: 'a',
      onEvents: (events) => {
        for (const e of events) delivered.push(`${hex(e.writer)}/${e.seq}`);
      },
    });
    // **Returning the promise is what makes rule 2 work.** `onFrame`'s type is
    // `void`, so a handler that drops it — `void a.receive(d)`, which is what
    // the real client does — leaves the transport nothing to await, and frames
    // overlap however carefully the queue was written. That is the whole
    // subtlety, and it is why this is tested rather than only documented.
    wireA.onFrame((d) => a.receive(d) as unknown as void);
    wireB.onFrame((d) => b.receive(d) as unknown as void);

    await a.start();
    await b.start();
    await new Promise<void>((r) => setTimeout(() => r(), 100));

    expect(delivered.length).toBeGreaterThan(0);
    expect(new Set(delivered).size).toBe(delivered.length);
  });
});
