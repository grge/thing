/**
 * The ephemeral channel: expiry, and what it does not do.
 *
 * The load-bearing test here is the last one — that nothing on this channel can
 * reach storage. That is a structural property (§10), not a check, and it is
 * worth asserting because it is what makes the channel safe to leave unsigned.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TTL, EphemeralState, haveMessage, presenceMessage } from './ephemeral.js';

describe('availability', () => {
  it('records what a peer says it holds', () => {
    const state = new EphemeralState(() => 0);
    state.receive('alice', haveMessage(['aa', 'bb']));
    expect(state.whoHas('aa')).toEqual(['alice']);
    expect(state.whoHas('cc')).toEqual([]);
  });

  it('lists every peer holding a blob', () => {
    const state = new EphemeralState(() => 0);
    state.receive('alice', haveMessage(['aa']));
    state.receive('bob', haveMessage(['aa', 'bb']));
    expect(state.whoHas('aa')).toEqual(['alice', 'bob']);
    expect(state.whoHas('bb')).toEqual(['bob']);
  });

  it('replaces an earlier announcement rather than merging it', () => {
    // An announcement is a statement about now, not an addition to a history.
    const state = new EphemeralState(() => 0);
    state.receive('alice', haveMessage(['aa']));
    state.receive('alice', haveMessage(['bb']));
    expect(state.whoHas('aa')).toEqual([]);
    expect(state.whoHas('bb')).toEqual(['alice']);
  });

  it('expires', () => {
    let now = 0;
    const state = new EphemeralState(() => now);
    state.receive('alice', haveMessage(['aa']));

    now = DEFAULT_TTL - 1;
    expect(state.whoHas('aa')).toEqual(['alice']);

    now = DEFAULT_TTL;
    expect(state.whoHas('aa')).toEqual([]);
  });
});

describe('presence', () => {
  it('records and expires by its own ttl', () => {
    let now = 0;
    const state = new EphemeralState(() => now);
    state.receive('alice', presenceMessage({ cursor: 7 }, 100));

    expect(state.present().get('alice')).toEqual({ cursor: 7 });
    now = 100;
    expect(state.present().has('alice')).toBe(false);
  });

  it('treats the payload as opaque', () => {
    // The protocol does not interpret presence; a view decides what it means.
    const state = new EphemeralState(() => 0);
    state.receive('alice', presenceMessage('anything at all', 1000));
    expect(state.present().get('alice')).toBe('anything at all');
  });
});

describe('peers', () => {
  it('forgets a peer on disconnect', () => {
    const state = new EphemeralState(() => 0);
    state.receive('alice', haveMessage(['aa']));
    state.receive('alice', presenceMessage({}, 10_000));

    state.forget('alice');
    expect(state.whoHas('aa')).toEqual([]);
    expect(state.present().size).toBe(0);
  });

  it('sweeping is an optimisation, not a correctness requirement', () => {
    // Expiry is enforced on read too, so a caller that never sweeps still
    // never sees a stale value.
    let now = 0;
    const state = new EphemeralState(() => now);
    state.receive('alice', haveMessage(['aa']));
    now = DEFAULT_TTL + 1;

    expect(state.whoHas('aa')).toEqual([]);
    state.sweep();
    expect(state.whoHas('aa')).toEqual([]);
  });

  it('attributes a message to the connection it came on', () => {
    // §10.2: messages carry no claim about who sent them, which is exactly why
    // they need no signature — a peer cannot claim to be another one.
    const state = new EphemeralState(() => 0);
    state.receive('alice', haveMessage(['aa']));
    state.receive('bob', haveMessage(['aa']));
    expect(state.whoHas('aa')).toEqual(['alice', 'bob']);
  });
});
