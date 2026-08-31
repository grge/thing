import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasRelay, iceServers, parseIceResponse, resetIceServersCache, stunOnly } from './iceservers.js';

describe('parseIceResponse', () => {
  it('accepts a bare array, as a managed provider returns', () => {
    expect(parseIceResponse([{ urls: 'turn:host:3478', username: 'u', credential: 'c' }])).toEqual([
      { urls: 'turn:host:3478', username: 'u', credential: 'c' },
    ]);
  });

  it('accepts { iceServers } too, as turn/auth returns', () => {
    expect(parseIceResponse({ iceServers: [{ urls: ['turn:host:3478'] }], ttl: 3600 })).toEqual([
      { urls: ['turn:host:3478'] },
    ]);
  });

  it('drops entries with no urls rather than handing them to the browser', () => {
    expect(parseIceResponse([{ username: 'u' }, { urls: 'turn:host:3478' }])).toEqual([
      { urls: 'turn:host:3478' },
    ]);
  });

  it('returns null for shapes it cannot use', () => {
    for (const bad of [null, [], [{ username: 'u' }], { nope: true }]) {
      expect(parseIceResponse(bad)).toBeNull();
    }
  });
});

describe('hasRelay', () => {
  it('distinguishes a real relay from more STUN — the whole point of the exercise', () => {
    expect(hasRelay(stunOnly())).toBe(false);
    expect(hasRelay([{ urls: 'turn:host:3478' }])).toBe(true);
    expect(hasRelay([{ urls: ['stun:a:1', 'turns:b:443'] }])).toBe(true);
  });
});

describe('iceServers', () => {
  beforeEach(() => resetIceServersCache());

  it('returns STUN only when no endpoint is configured', async () => {
    const got = await iceServers(null);
    expect(hasRelay(got)).toBe(false);
    expect(got.length).toBeGreaterThan(0);
  });

  it('keeps STUN alongside the relay, so a direct path stays preferred', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ urls: 'turn:host:3478', username: 'u', credential: 'c' }],
    });
    const got = await iceServers('https://example.test/creds', fetchImpl as unknown as typeof fetch);
    expect(hasRelay(got)).toBe(true);
    expect(got.some((s) => String(s.urls).startsWith('stun:'))).toBe(true);
  });

  it('never throws when the endpoint fails — a dead credential service must not take the app with it', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got = await iceServers('https://example.test/creds', failing as unknown as typeof fetch);
    expect(hasRelay(got)).toBe(false);
    expect(got.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it('fetches once per url, however many spaces start at the same moment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ urls: 'turn:host:3478' }],
    });
    const url = 'https://example.test/creds';
    await Promise.all([1, 2, 3, 4].map(() => iceServers(url, fetchImpl as unknown as typeof fetch)));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
