import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iceServers, parseIceResponse, resetIceServersCache } from './iceservers.js';

describe('parseIceResponse', () => {
  it('accepts a bare array, as a managed provider returns', () => {
    const got = parseIceResponse([{ urls: 'turn:host:3478', username: 'u', credential: 'c' }]);
    expect(got).toEqual([{ urls: 'turn:host:3478', username: 'u', credential: 'c' }]);
  });

  it('accepts { iceServers } too, as turn/auth returns', () => {
    const got = parseIceResponse({ iceServers: [{ urls: ['turn:host:3478'] }], ttl: 3600 });
    expect(got).toEqual([{ urls: ['turn:host:3478'] }]);
  });

  it('drops entries with no urls rather than passing them to the browser', () => {
    expect(parseIceResponse([{ username: 'u' }, { urls: 'turn:host:3478' }])).toEqual([
      { urls: 'turn:host:3478' },
    ]);
  });

  it('returns null for shapes it cannot use', () => {
    expect(parseIceResponse(null)).toBeNull();
    expect(parseIceResponse([])).toBeNull();
    expect(parseIceResponse([{ username: 'u' }])).toBeNull();
    expect(parseIceResponse({ nope: true })).toBeNull();
  });
});

describe('iceServers', () => {
  beforeEach(() => resetIceServersCache());

  it('falls back to STUN when no endpoint is configured', async () => {
    // VITE_TURN_CREDENTIALS_URL is unset under test, which is the unconfigured
    // case the app must survive.
    const got = await iceServers();
    expect(got.every((s) => String(s.urls).startsWith('stun:'))).toBe(true);
    expect(got.length).toBeGreaterThan(0);
  });

  it('never throws when the endpoint fails — a dead credential service must not take the app with it', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got = await iceServers(failing as unknown as typeof fetch);
    expect(got.length).toBeGreaterThan(0);
    warn.mockRestore();
  });
});
