import { describe, expect, it } from 'vitest';
import { isShareCode, newShareCode, parseShareUrl, peerIdForCode } from './storage.js';

describe('share codes', () => {
  it('mints codes of a fixed length from an unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const c = newShareCode();
      expect(isShareCode(c)).toBe(true);
      // No characters that get misread when transcribed by hand.
      expect(c).not.toMatch(/[01ilo]/);
    }
  });

  it('derives a namespaced peer id', () => {
    expect(peerIdForCode('k7mfq2xw')).toBe('thing-k7mfq2xw');
  });

  it('accepts a bare code — what someone types off another screen', () => {
    const rec = parseShareUrl('k7mfq2xw');
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('k7mfq2xw');
    expect(rec!.host).toBe('thing-k7mfq2xw');
    expect(rec!.mode).toBe('reader');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseShareUrl('  k7mfq2xw \n')?.id).toBe('k7mfq2xw');
  });

  it('accepts a full URL and carries the name', () => {
    const rec = parseShareUrl('https://grge.github.io/thing/#k7mfq2xw&photos');
    expect(rec?.id).toBe('k7mfq2xw');
    expect(rec?.name).toBe('photos');
  });

  it('decodes a percent-encoded name', () => {
    expect(parseShareUrl('https://x/#k7mfq2xw&my%20space')?.name).toBe('my space');
  });

  it('defaults the name when the link carries none', () => {
    expect(parseShareUrl('#k7mfq2xw')?.name).toBe('shared');
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseShareUrl('')).toBeNull();
    expect(parseShareUrl('too-short')).toBeNull();
    expect(parseShareUrl('k7mfq2xwEXTRA')).toBeNull();
    expect(parseShareUrl('k7mfq0xw')).toBeNull(); // 0 is not in the alphabet
    expect(parseShareUrl('https://grge.github.io/thing/')).toBeNull();
  });

  it('still parses the older long-form link', () => {
    const rec = parseShareUrl('https://x/#space=abc-123&name=photos&host=peer-xyz&role=reader');
    expect(rec?.id).toBe('abc-123');
    expect(rec?.host).toBe('peer-xyz');
    expect(rec?.name).toBe('photos');
  });
});
