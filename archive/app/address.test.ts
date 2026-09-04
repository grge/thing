/**
 * Addressing: identity, locators, links (DESIGN.md §4).
 *
 * The property under test throughout is the separation v0 did not have — that
 * identity, location and handle are three different things, and that only the
 * first is authoritative.
 */
import { describe, expect, it } from 'vitest';
import {
  base32,
  codeForSpace,
  defaultLocator,
  isShareCode,
  isSpaceId,
  parseShareInput,
  peerIdForCode,
  unbase32,
} from './address.js';
import { generateKeyPair, hex, WRITER_LEN } from '../fold/index.js';

/** A real key, since a space id is a public key and not an arbitrary string. */
async function spaceId(): Promise<string> {
  return hex((await generateKeyPair()).publicKey);
}

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const n of [0, 1, 5, 31, 32, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(hex(unbase32(base32(bytes))!.slice(0, n))).toBe(hex(bytes));
    }
  });

  it('rejects characters outside the alphabet', () => {
    expect(unbase32('!!!!')).toBeNull();
    expect(unbase32('0189')).toBeNull(); // 0/1/8/9 are not in the alphabet
  });
});

describe('the short code', () => {
  it('is derived from the key, so anyone holding it can find the rendezvous', async () => {
    const id = await spaceId();
    expect(await codeForSpace(id)).toBe(await codeForSpace(id));
  });

  it('uses an alphabet safe to transcribe by hand', async () => {
    for (let i = 0; i < 50; i++) {
      const code = await codeForSpace(await spaceId());
      expect(isShareCode(code)).toBe(true);
      expect(code).not.toMatch(/[01ilo]/);
    }
  });

  it('differs between spaces', async () => {
    const a = await codeForSpace(await spaceId());
    const b = await codeForSpace(await spaceId());
    expect(a).not.toBe(b);
  });

  it('derives a namespaced peer id', () => {
    expect(peerIdForCode('k7mfq2xw')).toBe('thing-k7mfq2xw');
  });

  it('is a locator, and the locator is re-derivable from identity alone', async () => {
    const id = await spaceId();
    const loc = await defaultLocator(id);
    expect(loc.transport).toBe('peerjs');
    expect(loc.address).toBe(peerIdForCode(await codeForSpace(id)));
  });
});

describe('what the UI can show a human', () => {
  it('the code is short enough to read off a screen; the id is not', async () => {
    // The share bar showed the *id* after step 2 widened it to a key, which is
    // 64 characters and overflowed the pane. The code is what belongs there.
    const id = await spaceId();
    expect(id.length).toBe(64);
    expect((await codeForSpace(id)).length).toBe(8);
  });
});

describe('space ids', () => {
  it('accepts a real public key and rejects a v0 share code', async () => {
    expect(isSpaceId(await spaceId())).toBe(true);
    expect(isSpaceId('k7mfq2xw')).toBe(false);
    expect(isSpaceId('nothex'.repeat(8))).toBe(false);
  });

  it('is the full key width, not a truncation of one', async () => {
    expect((await spaceId()).length).toBe(WRITER_LEN * 2);
  });
});

describe('share links', () => {
  it('round-trips a key through a link', async () => {
    const id = await spaceId();
    const link = `https://example.test/#k=${base32(Uint8Array.from(Buffer.from(id, 'hex')))}&n=photos`;
    const p = parseShareInput(link);
    expect(p?.kind).toBe('key');
    expect(p!.kind === 'key' && p!.id).toBe(id);
    expect(p!.kind === 'key' && p!.name).toBe('photos');
  });

  it('decodes a percent-encoded name', async () => {
    const id = await spaceId();
    const k = base32(Uint8Array.from(Buffer.from(id, 'hex')));
    const p = parseShareInput(`https://x/#k=${k}&n=my%20space`);
    expect(p!.kind === 'key' && p!.name).toBe('my space');
  });

  it('accepts a bare typed code, and marks it as a code rather than a key', () => {
    const p = parseShareInput('k7mfq2xw');
    expect(p).toEqual({ kind: 'code', code: 'k7mfq2xw' });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseShareInput('  k7mfq2xw \n')).toEqual({ kind: 'code', code: 'k7mfq2xw' });
  });

  it('rejects a key of the wrong length rather than accepting a truncation', () => {
    const short = base32(new Uint8Array(16));
    expect(parseShareInput(`https://x/#k=${short}`)).toBeNull();
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseShareInput('')).toBeNull();
    expect(parseShareInput('too-short')).toBeNull();
    expect(parseShareInput('k7mfq2xwEXTRA')).toBeNull();
    expect(parseShareInput('k7mfq0xw')).toBeNull(); // 0 is not in the alphabet
    expect(parseShareInput('https://grge.github.io/thing/')).toBeNull();
  });

  it('does not accept a v0 long-form link', () => {
    // v0 links carry no key, so there is nothing to verify against. Nothing
    // migrates (V1.md) — refusing is correct, not a regression.
    expect(parseShareInput('https://x/#space=abc-123&name=photos&host=peer-xyz')).toBeNull();
  });
});
