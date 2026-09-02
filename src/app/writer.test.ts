import { describe, expect, it } from 'vitest';
import { generateKeyPair, hex, verifyEvent } from '../fold/index.js';
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
