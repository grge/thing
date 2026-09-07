/**
 * Locators: the two shapes, and the round trip through their compact form.
 *
 * The parsing matters more than it looks. A locator arrives from strangers — on
 * the ephemeral channel, in a pasted share link — so anything unparseable has
 * to be an ordinary thing to drop rather than an error to handle.
 */
import { describe, expect, it } from 'vitest';

import { formatLocator, type Locator, locatorKey, parseLocator } from './locator.js';

describe('locators', () => {
  it('round-trips a direct address', () => {
    const l: Locator = { kind: 'ws', url: 'ws://host:9944' };
    expect(parseLocator(formatLocator(l))).toEqual(l);
  });

  it('round-trips a session, which is how a browser is reached', () => {
    const l: Locator = { kind: 'via', url: 'wss://signal.example', peer: 'sess-7' };
    expect(parseLocator(formatLocator(l))).toEqual(l);
  });

  it('takes a signalling URL containing a colon or path', () => {
    // The peer id is split on the *last* `#`, so a URL with structure in it
    // survives — this is what a naive split on the first separator gets wrong.
    const l: Locator = { kind: 'via', url: 'wss://sig.example:8443/rtc', peer: 'abc' };
    expect(parseLocator(formatLocator(l))).toEqual(l);
  });

  it('accepts both websocket schemes and nothing else', () => {
    expect(parseLocator('ws://a:1')?.kind).toBe('ws');
    expect(parseLocator('wss://a:1')?.kind).toBe('ws');
    expect(parseLocator('http://a:1')).toBeNull();
    expect(parseLocator('a:1')).toBeNull();
  });

  it('returns null for junk rather than throwing', () => {
    // It arrives from strangers; dropping one is ordinary.
    for (const junk of ['', '   ', 'via:', 'via:#', 'via:x#', 'via:#y', 'nonsense']) {
      expect(parseLocator(junk)).toBeNull();
    }
  });

  it('ignores surrounding whitespace, which pasted text carries', () => {
    expect(parseLocator('  ws://a:1  ')).toEqual({ kind: 'ws', url: 'ws://a:1' });
  });

  it('gives one key per endpoint, so a merge deduplicates', () => {
    // Two peers describing the same endpoint must collapse, or a merged list
    // holds it twice and one entry's failures never inform the other's.
    expect(locatorKey({ kind: 'ws', url: 'ws://a:1' })).toBe(
      locatorKey({ kind: 'ws', url: 'ws://a:1' }),
    );
    expect(locatorKey({ kind: 'via', url: 'wss://s', peer: 'p' })).toBe(
      locatorKey({ kind: 'via', url: 'wss://s', peer: 'p' }),
    );
  });

  it('distinguishes the two shapes and the sessions within one', () => {
    expect(locatorKey({ kind: 'ws', url: 'wss://s' })).not.toBe(
      locatorKey({ kind: 'via', url: 'wss://s', peer: 'p' }),
    );
    expect(locatorKey({ kind: 'via', url: 'wss://s', peer: 'a' })).not.toBe(
      locatorKey({ kind: 'via', url: 'wss://s', peer: 'b' }),
    );
  });
});
