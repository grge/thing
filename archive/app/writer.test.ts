import { describe, expect, it } from 'vitest';
import { checkWriterLamports, generateKeyPair, hex, verifyEvent } from '../fold/index.js';
import { newUuid, Writer } from './writer.js';

describe('Writer signs what it emits (DESIGN.md §5)', () => {
  it('every emitted event verifies under the writer key', async () => {
    const key = await generateKeyPair();
    const w = await Writer.resume(key, []);
    const id = newUuid();

    const events = [
      await w.setKind(id, 'file'),
      await w.setName(id, 'notes.txt'),
      await w.setDeleted(id, false),
    ];

    for (const e of events) expect(await verifyEvent(e)).toBe(true);
  });

  it('the writer id is the public key, not a separate identity', async () => {
    const key = await generateKeyPair();
    const w = await Writer.resume(key, []);
    expect(hex(w.id)).toBe(hex(key.publicKey));

    const e = await w.setName(newUuid(), 'x');
    expect(hex(e.writer)).toBe(hex(key.publicKey));
  });

  it('resuming a log keeps the chain verifiable', async () => {
    const key = await generateKeyPair();
    const first = await Writer.resume(key, []);
    const id = newUuid();
    const e0 = await first.setName(id, 'one');

    // A fresh Writer over the existing log continues the same chain.
    const second = await Writer.resume(key, [e0]);
    const e1 = await second.setName(id, 'two');

    expect(e1.seq).toBe(1);
    expect(e1.prev).not.toBeNull();
    expect(await verifyEvent(e1)).toBe(true);
  });

  it('two spaces get different identities', async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    expect(hex(a.publicKey)).not.toBe(hex(b.publicKey));

    // An event from one does not verify as the other, which is what makes a
    // fork honestly distinct rather than a collision (DESIGN.md §4.1).
    const w = await Writer.resume(a, []);
    const e = await w.setName(newUuid(), 'x');
    expect(await verifyEvent({ ...e, writer: b.publicKey })).toBe(false);
  });
});

describe('why one writer per space is enforced elsewhere (I23)', () => {
  // These pin the *hazard*, not a bug: they show what two concurrent writers on
  // one key would do, which is why Space takes an exclusive write lock
  // (writelock.ts). Nothing above the Writer prevents this, so if the lock is
  // ever removed or bypassed, this is what comes back.
  it('two Writers on one key produce a fork, and nothing here stops them', async () => {
    // The Writer is deliberately not the layer that prevents this: it has no
    // idea whether another one exists. Coordination is Space's job.
    const key = await generateKeyPair();
    const seed = await (await Writer.resume(key, [])).setName(newUuid(), 'shared');

    const tabA = await Writer.resume(key, [seed]);
    const tabB = await Writer.resume(key, [seed]);
    const a = await tabA.setName(newUuid(), 'from tab A');
    const b = await tabB.setName(newUuid(), 'from tab B');

    expect(a.seq).toBe(b.seq);
    expect(hex(a.prev!)).toBe(hex(b.prev!));
    expect(hex(a.sig)).not.toBe(hex(b.sig));

    // Signing cannot catch this: the writer really did sign both. I5 and I6
    // were about a hostile peer; this is an honest writer contradicting itself.
    expect(await verifyEvent(a)).toBe(true);
    expect(await verifyEvent(b)).toBe(true);
  });

  it('and validation would not catch it either', async () => {
    // checkWriterLamports looks for one lamport reused across *different* seqs.
    // A fork is the same lamport at the same seq, which slips through — which
    // is why the fix has to be prevention rather than detection.
    const key = await generateKeyPair();
    const seed = await (await Writer.resume(key, [])).setName(newUuid(), 'shared');
    const a = await (await Writer.resume(key, [seed])).setName(newUuid(), 'A');
    const b = await (await Writer.resume(key, [seed])).setName(newUuid(), 'B');

    expect(() => checkWriterLamports([seed, a, b])).not.toThrow();
  });
});
