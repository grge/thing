import { describe, expect, it } from 'vitest';
import { type RelayCheck, summarise, turnUrls } from './relaycheck.js';

const base: RelayCheck = {
  servers: ['stun:stun.relay.metered.ca:80', 'turn:global.relay.metered.ca:80'],
  credentialed: true,
  relayCandidates: 0,
  otherCandidates: ['host', 'srflx'],
  errors: [],
  ms: 12000,
};

describe('turnUrls', () => {
  it('picks relay urls out of a mixed array, however urls is shaped', () => {
    expect(
      turnUrls([{ urls: 'stun:a:80' }, { urls: ['turn:b:80', 'turns:b:443'] }]),
    ).toEqual(['turn:b:80', 'turns:b:443']);
  });
});

describe('summarise', () => {
  it('reports success when a relay candidate arrived', () => {
    expect(summarise({ ...base, relayCandidates: 1, ms: 300 })).toMatchObject({ verdict: 'ok' });
  });

  it('distinguishes "no TURN url returned" from "relay failed"', () => {
    const s = summarise({ ...base, servers: ['stun:stun.example:80'] });
    expect(s.verdict).toBe('no-turn-url');
  });

  it('names a 401 as credentials rejected, not as unreachable', () => {
    // The distinction that matters: the relay answered, and said no. That is a
    // key problem, not a network problem, and they need different fixes.
    const s = summarise({
      ...base,
      errors: [{ url: 'turn:global.relay.metered.ca:80', code: 401, text: 'Unauthorized' }],
    });
    expect(s.verdict).toBe('rejected');
    expect(s.text).toContain('401');
  });

  it('names a 701 as unreachable, and says which url', () => {
    const s = summarise({
      ...base,
      errors: [{ url: 'turn:global.relay.metered.ca:80', code: 701, text: 'Timeout' }],
    });
    expect(s.verdict).toBe('unreachable');
    expect(s.text).toContain('global.relay.metered.ca');
  });

  it('catches a TURN url delivered without credentials', () => {
    expect(summarise({ ...base, credentialed: false }).verdict).toBe('rejected');
  });

  it('blames the network when nothing at all was gathered', () => {
    expect(summarise({ ...base, otherCandidates: [] }).verdict).toBe('network');
  });

  it('when STUN works and the relay is silent, blames the relay and says so', () => {
    const s = summarise(base);
    expect(s.verdict).toBe('unknown');
    expect(s.text).toContain('account tier');
  });
});
