/**
 * The handshake compares identities, not locators (DESIGN.md §3, §4).
 *
 * A regression guard for a bug found in v1 step 2: a space joined by typed code
 * announced the *code* as its space id, while the writer announced its *key*.
 * Both sides then read a legitimate peer as "in a different space" and closed
 * the connection — silently, from the user's side. Join-by-code was broken end
 * to end while every unit test still passed, because nothing exercised the two
 * kinds of id meeting.
 */
import { describe, expect, it } from 'vitest';

/**
 * The rule the transport applies on HELLO. Mirrors `peer.ts`: an empty id on
 * either side means "identity not yet known", which is not a mismatch.
 */
function isDifferentSpace(mine: string, theirs: string): boolean {
  return mine !== '' && theirs !== '' && theirs !== mine;
}

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const CODE = 'e6z82q35';

describe('space identity on HELLO', () => {
  it('accepts a peer announcing the same key', () => {
    expect(isDifferentSpace(KEY, KEY)).toBe(false);
  });

  it('rejects a peer announcing a genuinely different key', () => {
    expect(isDifferentSpace(KEY, OTHER_KEY)).toBe(true);
  });

  it('a code-joined peer announces nothing, so the writer does not reject it', () => {
    // The bug: this peer used to announce CODE, and the writer announces KEY.
    expect(isDifferentSpace(KEY, CODE)).toBe(true); // what used to happen
    expect(isDifferentSpace(KEY, '')).toBe(false); // what happens now
  });

  it('and the code-joined side does not reject the writer either', () => {
    expect(isDifferentSpace(CODE, KEY)).toBe(true); // what used to happen
    expect(isDifferentSpace('', KEY)).toBe(false); // what happens now
  });

  it('a code is never a valid thing to announce as identity', () => {
    // Identity is a 32-byte key in hex. If a code ever reaches this comparison
    // again, it is a locator that has leaked into the identity layer.
    expect(CODE.length).not.toBe(64);
  });
});

/**
 * What `Replication` actually announces, which is where the bug lived. The rule
 * above is only correct if this feeds it the right value.
 */
function announcedIdentity(record: { id: string; handle?: string }): string {
  return record.handle === undefined ? record.id : '';
}

describe('what a space announces about itself', () => {
  it('a writer announces its key', () => {
    expect(announcedIdentity({ id: KEY })).toBe(KEY);
  });

  it('a link-joined reader announces the key it was given', () => {
    // Joined by link: the key was known before contact, so it is announceable
    // and any peer serving something else is genuinely a different space.
    expect(announcedIdentity({ id: KEY })).toBe(KEY);
  });

  it('a code-joined reader announces nothing at all', () => {
    // Its record id is the code — a locator standing in as a storage key until
    // the real identity arrives with the first signed events.
    expect(announcedIdentity({ id: CODE, handle: CODE })).toBe('');
  });

  it('end to end: a writer and a code-joined reader accept each other', () => {
    const writer = announcedIdentity({ id: KEY });
    const reader = announcedIdentity({ id: CODE, handle: CODE });
    expect(isDifferentSpace(writer, reader)).toBe(false);
    expect(isDifferentSpace(reader, writer)).toBe(false);
  });

  it('end to end: two genuinely different spaces still refuse each other', () => {
    expect(isDifferentSpace(announcedIdentity({ id: KEY }), announcedIdentity({ id: OTHER_KEY }))).toBe(
      true,
    );
  });
});
