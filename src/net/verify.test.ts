/**
 * The wire boundary rejects what it cannot verify (DESIGN.md §5).
 *
 * The rule peer.ts implements on `EVENTS`: an event that does not verify is
 * treated as one we do not have — dropped before the hold-aside buffer, never
 * folded. These tests drive `verifyEvent` over the same wire round-trip the
 * transport uses, so a regression in either the encoding or the check shows up
 * here rather than as a silent acceptance.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPair, hex, verifyEvent, type Event } from '../fold/index.js';
import { fromStored, toStored } from '../app/storage.js';
import { newUuid, Writer } from '../app/writer.js';

/** The exact conversion replication.ts performs in both directions. */
function roundTrip(e: Event): Event {
  return fromStored(JSON.parse(JSON.stringify(toStored(e))));
}

async function signedEvent(): Promise<{ e: Event; w: Writer }> {
  const key = await generateKeyPair();
  const w = await Writer.resume(key, []);
  return { e: await w.setName(newUuid(), 'notes.txt'), w };
}

describe('inbound verification', () => {
  it('a genuine event survives the wire round-trip', async () => {
    const { e } = await signedEvent();
    expect(await verifyEvent(roundTrip(e))).toBe(true);
  });

  it('drops an event whose lamport was inflated in transit (I5)', async () => {
    const { e } = await signedEvent();
    const forged = roundTrip({ ...e, lamport: e.lamport + 9999 });
    expect(await verifyEvent(forged)).toBe(false);
  });

  it('drops an event claiming a writer id it does not hold (I6)', async () => {
    const { e } = await signedEvent();
    const other = await generateKeyPair();
    expect(await verifyEvent(roundTrip({ ...e, writer: other.publicKey }))).toBe(false);
  });

  it('drops an event whose content hash was swapped', async () => {
    const key = await generateKeyPair();
    const w = await Writer.resume(key, []);
    const id = newUuid();
    const e = await w.setContent(id, new Uint8Array(32).fill(1));
    const swapped = roundTrip({ ...e, value: { t: 'hash', v: new Uint8Array(32).fill(2) } });
    expect(await verifyEvent(swapped)).toBe(false);
  });

  it('a link survives the wire round-trip intact', async () => {
    const key = await generateKeyPair();
    const w = await Writer.resume(key, []);
    const target = (await generateKeyPair()).publicKey;
    const inner = newUuid();

    for (const link of [{ space: target }, { space: target, object: inner }]) {
      const e = await w.setLink(newUuid(), link);
      const back = roundTrip(e);
      expect(await verifyEvent(back)).toBe(true);
      expect(back.value.t).toBe('link');
      const v = back.value as { t: 'link'; v: { space: Uint8Array; object?: Uint8Array } };
      expect(hex(v.v.space)).toBe(hex(target));
      expect(v.v.object === undefined ? null : hex(v.v.object)).toBe(
        link.object === undefined ? null : hex(link.object),
      );
    }
  });

  it('drops an event whose link target was swapped in transit', async () => {
    const key = await generateKeyPair();
    const w = await Writer.resume(key, []);
    const e = await w.setLink(newUuid(), { space: (await generateKeyPair()).publicKey });
    const elsewhere = (await generateKeyPair()).publicKey;
    const forged = roundTrip({ ...e, value: { t: 'link', v: { space: elsewhere } } });
    expect(await verifyEvent(forged)).toBe(false);
  });

  it('drops an event with the signature stripped', async () => {
    const { e } = await signedEvent();
    expect(await verifyEvent(roundTrip({ ...e, sig: new Uint8Array(64) }))).toBe(false);
  });
});
