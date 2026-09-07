/**
 * The ephemeral channel: expiry, and what it does not do.
 *
 * The load-bearing test here is the last one — that nothing on this channel can
 * reach storage. That is a structural property (§10), not a check, and it is
 * worth asserting because it is what makes the channel safe to leave unsigned.
 */
import { describe, expect, it } from 'vitest';
import { announceMessage, DEFAULT_TTL, EphemeralState, MAX_LOCATORS_PER_PEER, MAX_SPACES_PER_PEER, haveMessage, presenceMessage } from './ephemeral.js';

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

describe('announcements (§5.3)', () => {
  it('records who serves a space, with how to reach them', () => {
    const state = new EphemeralState(() => 0);
    state.receive('peer-a', announceMessage(['aa'], [{ kind: 'ws', url: 'ws://a:1' }]));
    expect(state.whoServes('aa')).toEqual([{ peer: 'peer-a', at: ['ws://a:1'] }]);
  });

  it('expires like everything else on this channel', () => {
    let now = 0;
    const state = new EphemeralState(() => now);
    state.receive('peer-a', announceMessage(['aa'], [], 1000));
    expect(state.whoServes('aa')).toHaveLength(1);
    now = 1001;
    expect(state.whoServes('aa')).toEqual([]);
  });

  it('caps how many spaces one peer may claim (§5.3)', () => {
    // The cap §5.3 singles out as important: it is what stops one peer
    // crowding the real entry out of a list.
    const state = new EphemeralState(() => 0);
    const many = Array.from({ length: MAX_SPACES_PER_PEER + 50 }, (_, i) => `s${i}`);
    state.receive('flood', announceMessage(many));
    const claimed = many.filter((s) => state.whoServes(s).length > 0);
    expect(claimed).toHaveLength(MAX_SPACES_PER_PEER);
  });

  it('caps how many locators one peer may offer', () => {
    const state = new EphemeralState(() => 0);
    const at = Array.from({ length: MAX_LOCATORS_PER_PEER + 5 }, (_, i) => ({
      kind: 'ws' as const,
      url: `ws://h${i}:1`,
    }));
    state.receive('peer-a', announceMessage(['aa'], at));
    expect(state.whoServes('aa')[0]!.at).toHaveLength(MAX_LOCATORS_PER_PEER);
  });

  it('one peer cannot crowd out another', () => {
    // The point of a per-peer cap rather than a global one.
    const state = new EphemeralState(() => 0);
    state.receive('flood', announceMessage(
      Array.from({ length: MAX_SPACES_PER_PEER + 50 }, (_, i) => `s${i}`),
    ));
    state.receive('honest', announceMessage(['wanted'], [{ kind: 'ws', url: 'ws://real:1' }]));
    expect(state.whoServes('wanted')).toEqual([{ peer: 'honest', at: ['ws://real:1'] }]);
  });

  it('remembers that a space was once served after the peer goes', () => {
    // What makes "nobody is serving, last seen at T" a different answer from
    // "I have never heard of this" (§5.3's three-way empty answer).
    const state = new EphemeralState(() => 5000);
    state.receive('peer-a', announceMessage(['aa']));
    state.forget('peer-a');

    expect(state.whoServes('aa')).toEqual([]);
    expect(state.knows('aa')).toBe(true);
    expect(state.seenAt('aa')).toBe(5000);
    expect(state.knows('never-mentioned')).toBe(false);
  });

  it('a query and its answer leave no state behind', () => {
    // They are conversation, not availability: the session routes them to
    // whoever asked, and nothing here remembers them.
    const state = new EphemeralState(() => 0);
    state.receive('peer-a', { type: 'RESOLVE', id: 1, space: 'aa' });
    state.receive('peer-a', { type: 'RESOLVED', id: 1, space: 'aa', known: true, at: ['ws://x:1'] });
    expect(state.whoServes('aa')).toEqual([]);
    expect(state.knows('aa')).toBe(false);
  });
});
