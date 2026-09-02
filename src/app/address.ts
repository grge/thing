/**
 * Addressing: identity, locators, and the share link (DESIGN.md §4).
 *
 * v0 fused three things into one 8-character string — a space's identity, its
 * storage keyspace, and its network location. This module separates them:
 *
 * | Layer        | Is                          | Changes     |
 * |--------------|-----------------------------|-------------|
 * | Identity     | an Ed25519 public key       | never       |
 * | Location     | who claims to serve this now | constantly  |
 * | Human handle | a petname, per person       | per person  |
 *
 * Nothing here resolves *by name*. Names are for humans recognising things they
 * have already met; keys are for machines deciding what something is
 * (ADDRESSING.md §5.6).
 */
import { fromHex, hex, sha256, WRITER_LEN } from '../fold/index.js';

/**
 * A space's identity: an Ed25519 public key, as lowercase hex.
 *
 * Hex rather than base32 for the *internal* form, so it matches how every other
 * byte array is keyed and stored. Base32 is a link-format concern (§5.4) and
 * lives in the encode/decode pair below.
 */
export type SpaceId = string;

/** Where something might be reachable right now. Never part of identity. */
export interface Locator {
  readonly transport: 'peerjs';
  readonly address: string;
}

export function isSpaceId(s: string): boolean {
  return s.length === WRITER_LEN * 2 && /^[0-9a-f]+$/.test(s);
}

/* ── The short code ────────────────────────────────────────────────────────
 * Unambiguous alphabet — no 0/O, 1/I/l — because these get transcribed by hand
 * between devices, which is the whole point of them being short.
 */

const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 8;

export function isShareCode(s: string): boolean {
  return s.length === CODE_LENGTH && [...s].every((c) => CODE_ALPHABET.includes(c));
}

/**
 * The rendezvous code for a space: `base32(sha256(pubkey))[0..8]`.
 *
 * **Derived, and carrying no authority** (DESIGN.md §4.3). Anyone holding the
 * key can compute where to look, which is one fewer moving part than an
 * independent code. It is grindable at ~40 bits and that is fine, because
 * stealing it grants nothing: an impostor who claims the rendezvous slot can
 * answer you, but what they serve will not verify against the key in your link.
 *
 * Derived from the *hash* rather than the key's own bytes so that the code
 * leaks nothing usable about the key itself.
 */
export async function codeForSpace(id: SpaceId): Promise<string> {
  const digest = await sha256(fromHex(id));
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[digest[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/** The PeerJS id a space's writer claims. Namespaced so it cannot collide. */
export function peerIdForCode(code: string): string {
  return `thing-${code}`;
}

/**
 * The locator to try for a space, absent any better information.
 *
 * This is the whole of the resolver for now: *given a space key, produce
 * candidate locators.* Later it might be a websocket URL for an always-on peer,
 * or a lookup. The identity is untouched by all of it (DESIGN.md §4.2), which
 * is why this returns a Locator rather than a bare string.
 */
export async function defaultLocator(id: SpaceId): Promise<Locator> {
  return { transport: 'peerjs', address: peerIdForCode(await codeForSpace(id)) };
}

/* ── base32, for the link ─────────────────────────────────────────────────
 * RFC 4648 alphabet without padding. A 32-byte key is 52 characters — long, but
 * it lives in a link that gets clicked, not typed (§5.4).
 */

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export function unbase32(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const c of s) {
    const v = B32.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/* ── The share link ──────────────────────────────────────────────────────── */

export interface ShareLink {
  readonly id: SpaceId;
  /** The name the space suggests. A hint for display, never an address. */
  readonly name: string;
}

/**
 * Build a share link (ADDRESSING.md §5.4).
 *
 * The key goes in the **fragment**, so it never reaches a server log — it is
 * identity, and under any later encryption scheme it would also be capability.
 */
export function shareUrl(id: SpaceId, name: string): string {
  const u = new URL(window.location.href);
  const k = `k=${base32(fromHex(id))}`;
  u.hash = name === '' ? k : `${k}&n=${encodeURIComponent(name)}`;
  return u.toString();
}

/**
 * Parse a share link, or a bare typed code.
 *
 * Two ways in, with honestly different guarantees (§5.4):
 *
 * - **A link** carries the key, so the space can be verified on first contact.
 * - **A typed code** carries a rendezvous hint only. You reach *a* space
 *   claiming to be the one you wanted and cannot check it until you have seen
 *   its events — which is what trust-on-first-use (`pins.ts`) is for.
 *
 * Returns which of the two it got, because the caller must treat them
 * differently; collapsing them would silently give a typed code the guarantees
 * of a link.
 */
export type Parsed =
  | { readonly kind: 'key'; readonly id: SpaceId; readonly name: string }
  | { readonly kind: 'code'; readonly code: string };

export function parseShareInput(input: string): Parsed | null {
  const raw = input.trim();
  if (raw === '') return null;

  let hash = raw;
  if (raw.includes('#')) hash = raw.slice(raw.indexOf('#') + 1);
  else if (/^https?:/i.test(raw)) return null; // a URL with no fragment carries nothing

  if (hash.includes('k=')) {
    const p = new URLSearchParams(hash);
    const k = p.get('k');
    if (k === null) return null;
    const bytes = unbase32(k);
    if (bytes === null || bytes.length !== WRITER_LEN) return null;
    return { kind: 'key', id: hex(bytes), name: p.get('n') ?? '' };
  }

  if (isShareCode(hash)) return { kind: 'code', code: hash };
  return null;
}
