/**
 * `:link` — an attribute any object may carry (DESIGN.md §2.1).
 *
 * The shape was chosen over a dedicated link object type and over a sidecar
 * list. These tests pin the consequences of that choice: a link inherits
 * naming, parenting, tombstones and LWW for free, and an object may carry both
 * a link and content.
 */
import { describe, expect, it } from 'vitest';
import { encodeEvent } from './encode.js';
import { fold } from './fold.js';
import { eventId, hex } from './hash.js';
import { contentHash, TestWriter, uuid, writer } from './testkit.js';
import { InvalidEvent, validateEvent } from './validate.js';
import type { Event } from './types.js';
import { ROOT, UUID_LEN, WRITER_LEN } from './types.js';

const TARGET = writer('target-space');
const OTHER = writer('other-space');

function get(events: Event[], u: Uint8Array) {
  const o = fold(events).objects.get(hex(u));
  if (o === undefined) throw new Error('no object');
  return o;
}

describe('what a link is', () => {
  it('an object with a link and no content is a portal', () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const o = get([a.name(p, 'the other place'), a.link(p, { space: TARGET })], p);
    expect(o.content).toBeNull();
    expect(hex(o.link!.space)).toBe(hex(TARGET));
    expect(o.link!.object).toBeUndefined();
  });

  it('an object with both is a card — a thumbnail that goes somewhere', () => {
    const a = new TestWriter(writer('alice'));
    const c = uuid('card');
    const o = get(
      [a.name(c, 'holiday'), a.content(c, contentHash('thumb')), a.link(c, { space: TARGET })],
      c,
    );
    expect(o.content).not.toBeNull();
    expect(o.link).not.toBeNull();
  });

  it('carries a deep target when one is given', () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const inner = uuid('inner');
    const o = get([a.link(p, { space: TARGET, object: inner })], p);
    expect(hex(o.link!.object!)).toBe(hex(inner));
  });

  it('is null on an object nobody linked', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('f');
    expect(get([a.name(f, 'plain.txt')], f).link).toBeNull();
  });
});

describe('a link is an ordinary attribute', () => {
  it('resolves by LWW like any other slot', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const p = uuid('portal');
    // Bob writes later, so Bob wins.
    const events = [a.link(p, { space: TARGET }, 1), b.link(p, { space: OTHER }, 2)];
    expect(hex(get(events, p).link!.space)).toBe(hex(OTHER));
  });

  it('inherits naming and parenting for free', () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const d = uuid('dir');
    const o = get(
      [a.parent(d, ROOT), a.name(d, 'links'), a.parent(p, d), a.name(p, 'a friend'), a.link(p, { space: TARGET })],
      p,
    );
    // The linker's own petname for the target — the right person to be labelling
    // it (DESIGN.md §2.1).
    expect(o.name).toBe('a friend');
    expect(hex(o.parent)).toBe(hex(d));
  });

  it('inherits tombstones for free', () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const events = [a.link(p, { space: TARGET }, 1), a.deleted(p, true, 2)];
    expect(get(events, p).deleted).toBe(true);
  });

  it('setting a link revives a tombstoned object, as authoring does', () => {
    // Unlike `:kind` and `:type`, a link is what the object is *for*. The §4.5
    // rationale applies: a resurrected object is recoverable by re-deleting,
    // whereas an authored link vanishing behind a tombstone looks like loss.
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const events = [a.deleted(p, true, 1), a.link(p, { space: TARGET }, 2)];
    expect(get(events, p).deleted).toBe(false);
  });
});

describe('encoding', () => {
  it('a link is part of the signed preimage, so tampering changes the id', async () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const e = a.link(p, { space: TARGET });
    const tampered: Event = { ...e, value: { t: 'link', v: { space: OTHER } } };
    expect(hex(await eventId(e))).not.toBe(hex(await eventId(tampered)));
  });

  it('a space link and a deep link to the same space encode differently', async () => {
    const a = new TestWriter(writer('alice'));
    const p = uuid('portal');
    const shallow = a.link(p, { space: TARGET });
    const deep: Event = {
      ...shallow,
      value: { t: 'link', v: { space: TARGET, object: new Uint8Array(UUID_LEN) } },
    };
    // An all-zero object uuid must not encode the same as no object at all —
    // that is what the presence byte is for.
    expect(hex(encodeEvent(shallow))).not.toBe(hex(encodeEvent(deep)));
  });

  it('refuses to encode a mis-sized target rather than hashing it', () => {
    const a = new TestWriter(writer('alice'));
    const bad: Event = {
      ...a.link(uuid('p'), { space: TARGET }),
      value: { t: 'link', v: { space: new Uint8Array(8) } },
    };
    expect(() => encodeEvent(bad)).toThrow(/link space must be/);
  });
});

describe('validation', () => {
  it('accepts a well-formed link, with and without a deep target', () => {
    // TestWriter stubs `prev`, so only seq 0 satisfies the chain rule; each
    // shape gets a fresh writer rather than weakening the check.
    const shallow = new TestWriter(writer('alice')).link(uuid('p'), { space: TARGET });
    const deep = new TestWriter(writer('bob')).link(uuid('p'), {
      space: TARGET,
      object: uuid('x'),
    });
    expect(() => validateEvent(shallow)).not.toThrow();
    expect(() => validateEvent(deep)).not.toThrow();
  });

  it('rejects a target space that is not a full public key', () => {
    // A link names an identity. A short code reaching this point would be a
    // locator that has leaked into the identity layer (DESIGN.md §4).
    const bad: Event = {
      ...new TestWriter(writer('alice')).link(uuid('p'), { space: TARGET }),
      value: { t: 'link', v: { space: new Uint8Array(WRITER_LEN - 1) } },
    };
    expect(() => validateEvent(bad)).toThrow(InvalidEvent);
  });

  it('rejects a mis-sized deep target', () => {
    const bad: Event = {
      ...new TestWriter(writer('alice')).link(uuid('p'), { space: TARGET }),
      value: { t: 'link', v: { space: TARGET, object: new Uint8Array(4) } },
    };
    expect(() => validateEvent(bad)).toThrow(InvalidEvent);
  });

  it('rejects a non-link value in the slot', () => {
    const bad: Event = {
      ...new TestWriter(writer('alice')).link(uuid('p'), { space: TARGET }),
      value: { t: 'string', v: 'x' },
    };
    expect(() => validateEvent(bad)).toThrow(/:link takes a link/);
  });
});
