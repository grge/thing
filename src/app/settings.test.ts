import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, turnCredentialsUrl } from './settings.js';

describe('turnCredentialsUrl', () => {
  it('builds the Metered endpoint from a subdomain and key', () => {
    expect(
      turnCredentialsUrl({ turn: { provider: 'metered', subdomain: 'waypoint', apiKey: 'abc123' } }),
    ).toBe('https://waypoint.metered.live/api/v1/turn/credentials?apiKey=abc123');
  });

  it('escapes the key rather than trusting it to be url-safe', () => {
    const url = turnCredentialsUrl({ turn: { provider: 'metered', subdomain: 's', apiKey: 'a b&c' } });
    expect(url).toContain('apiKey=a%20b%26c');
  });

  it('is null when half-configured, so a partial form does not produce a broken fetch', () => {
    expect(turnCredentialsUrl({ turn: { provider: 'metered', subdomain: 'waypoint', apiKey: '' } })).toBeNull();
    expect(turnCredentialsUrl({ turn: { provider: 'metered', subdomain: '', apiKey: 'k' } })).toBeNull();
    expect(turnCredentialsUrl({ turn: { provider: 'custom', url: '  ' } })).toBeNull();
    expect(turnCredentialsUrl(DEFAULT_SETTINGS)).toBeNull();
  });

  it('passes a custom endpoint through untouched', () => {
    expect(turnCredentialsUrl({ turn: { provider: 'custom', url: 'https://turn-auth.example/' } })).toBe(
      'https://turn-auth.example/',
    );
  });
});

describe('parseSettings', () => {
  it('round-trips what saveSettings writes', () => {
    const s = { turn: { provider: 'metered' as const, subdomain: 'waypoint', apiKey: 'k' } };
    expect(parseSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('falls back to defaults on anything unrecognised, rather than throwing at startup', () => {
    for (const bad of [null, 42, 'nope', {}, { turn: null }, { turn: { provider: 'martian' } }]) {
      expect(parseSettings(bad)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('tolerates missing fields inside a known provider', () => {
    expect(parseSettings({ turn: { provider: 'metered' } })).toEqual({
      turn: { provider: 'metered', subdomain: '', apiKey: '' },
    });
  });
});
