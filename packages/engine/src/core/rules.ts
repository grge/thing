/**
 * The rule vocabulary (ARCHITECTURE.md §3.2).
 *
 * Attribute rules are **fixed per attribute name** and known to every client,
 * which is what lets any client fold any space's structure without consulting a
 * declaration. Body rules are named by an object's `:kind` and vary.
 *
 * Every rule here is a join-semilattice and satisfies the homomorphism in
 * `rule.ts`; `rules.test.ts` checks both by property test rather than trusting
 * the claim.
 */
import { compareKeys, greater, type Key, type MaybeKey } from './chain.js';
import { sequence } from './sequence.js';
import { hex } from './bytes.js';
import { HASH_LEN } from './hash.js';
import { PUBLIC_KEY_LEN } from './sign.js';
import { type Acc, type AnyRule, type Entry, erase, type Rule } from './rule.js';

/* ── codecs ─────────────────────────────────────────────────────────────── */

const UTF8 = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: false });

/** Raw bytes, unexamined. The identity codec. */
const bytesCodec = {
  decode: (b: Uint8Array): Uint8Array => b,
  encode: (v: Uint8Array): Uint8Array => v,
};

/** UTF-8 text. */
const stringCodec = {
  decode: (b: Uint8Array): string | null => DECODER.decode(b),
  encode: (v: string): Uint8Array => UTF8.encode(v),
};

/** A single byte: zero is false, anything else true. */
const boolCodec = {
  decode: (b: Uint8Array): boolean | null => (b.length === 1 ? b[0] !== 0 : null),
  encode: (v: boolean): Uint8Array => Uint8Array.of(v ? 1 : 0),
};

/** A 32-byte hash. Rejects any other width rather than accepting a truncation. */
const hashCodec = {
  decode: (b: Uint8Array): Uint8Array | null => (b.length === HASH_LEN ? b : null),
  encode: (v: Uint8Array): Uint8Array => v,
};

/* ── register ───────────────────────────────────────────────────────────── */

/**
 * Last writer wins by `(lamport, writer, id)` (§3.2).
 *
 * The accumulator keeps the winning key as well as the value, which §3.7
 * requires: without it a late arrival cannot be resolved, because the key it
 * would have to beat is gone.
 */
export interface RegisterAcc<V> {
  readonly value: V | null;
  readonly key: MaybeKey;
}

function registerMerge<V>() {
  return {
    empty: (): RegisterAcc<V> => ({ value: null, key: null }),
    step: (acc: RegisterAcc<V>, entries: readonly Entry<V>[]): Acc<RegisterAcc<V>> => {
      let best = acc;
      for (const e of entries) {
        if (greater(e.key, best.key)) best = { value: e.value, key: e.key };
      }
      return { acc: best };
    },
    render: (acc: RegisterAcc<V>): V | null => acc.value,
  };
}

/* ── flag ───────────────────────────────────────────────────────────────── */

/**
 * A tombstone (§3.2).
 *
 * Deleted iff the greatest `true` in the bag beats the greatest `false`. Two
 * maxima over one bag, so the result is a pure function of the set.
 *
 * **Deliberately not "a delete loses to any later write anywhere on the
 * object".** That rule would have to read the object's other slices, breaking
 * the one-bag contract, and an unrelated body write would silently revive a
 * deleted object. Undeletion here is an explicit `false`, never an inference
 * from activity elsewhere.
 */
export interface FlagAcc {
  readonly set: MaybeKey;
  readonly clear: MaybeKey;
}

const flagMerge = {
  empty: (): FlagAcc => ({ set: null, clear: null }),
  step: (acc: FlagAcc, entries: readonly Entry<boolean>[]): Acc<FlagAcc> => {
    let { set, clear } = acc;
    for (const e of entries) {
      if (e.value) {
        if (greater(e.key, set)) set = e.key;
      } else {
        if (greater(e.key, clear)) clear = e.key;
      }
    }
    return { acc: { set, clear } };
  },
  render: (acc: FlagAcc): boolean => acc.set !== null && greater(acc.set, acc.clear),
};

/* ── the vocabulary ─────────────────────────────────────────────────────── */

/** `:name`, `:kind`, and anything else that is one value at a time. */
export const stringRegister: Rule<string, RegisterAcc<string>, string | null> = {
  id: 'register:string',
  codec: stringCodec,
  merge: registerMerge<string>(),
};

/** `:parent`, and any attribute holding an opaque identifier. */
export const bytesRegister: Rule<Uint8Array, RegisterAcc<Uint8Array>, Uint8Array | null> = {
  id: 'register:bytes',
  codec: bytesCodec,
  merge: registerMerge<Uint8Array>(),
};

/** `:deleted`. */
export const flag: Rule<boolean, FlagAcc, boolean> = {
  id: 'flag',
  codec: boolCodec,
  merge: flagMerge,
};

/**
 * A blob body: a hash, with the bytes travelling by §2.4's separate path.
 *
 * **The degenerate member of the vocabulary, not a special case** (§3.2).
 * Structurally a register over a hash — which is the point: large content needs
 * no mechanism of its own.
 */
export const blob: Rule<Uint8Array, RegisterAcc<Uint8Array>, Uint8Array | null> = {
  id: 'blob',
  codec: hashCodec,
  merge: registerMerge<Uint8Array>(),
};

/** A public key, rejecting any other width rather than accepting a truncation. */
const keyCodec = {
  decode: (b: Uint8Array): Uint8Array | null => (b.length === PUBLIC_KEY_LEN ? b : null),
  encode: (v: Uint8Array): Uint8Array => v,
};

/** A link's body: the space it points at (`docs/MAIN-SPACE.md`). */
export const spaceRegister: Rule<Uint8Array, RegisterAcc<Uint8Array>, Uint8Array | null> = {
  id: 'link',
  codec: keyCodec,
  merge: registerMerge<Uint8Array>(),
};

/**
 * The fixed attribute rules (§3.2).
 *
 * Keyed by attribute name, universally known, never declared. This table is why
 * phase 2 of the fold needs no input beyond the events themselves — and why an
 * unrecognised body rule costs one object rather than a whole space.
 */
export const ATTRIBUTE_RULES: Readonly<Record<string, AnyRule>> = {
  ':parent': erase(bytesRegister),
  ':name': erase(stringRegister),
  ':kind': erase(stringRegister),
  ':deleted': erase(flag),
  // Root-level attributes (§3.5). Fixed rules like any other, so phase 1 needs
  // no special case — the root is an object whose slices happen to be admitted
  // on a signature rather than a writer-set lookup.
  ':writers': erase(stringRegister),
  // §7.2.2: which writers moderate. A register like `:writers`, and named in
  // the fixed vocabulary for the same reason — every client must fold the
  // membership of a space without consulting a declaration (§3.2). §7.4 leaves
  // open whether moderator *actions* need a vocabulary of their own; this is
  // only the list.
  ':moderators': erase(stringRegister),
  ':view': erase(stringRegister),
};

/**
 * The rule for any attribute, including ones this vocabulary does not name.
 *
 * An unknown attribute is a register over bytes rather than an error: the fold
 * is total (§3.4), and a client that has not heard of an attribute should carry
 * and resolve it rather than drop it.
 */
export function attributeRule(attr: string): AnyRule {
  return ATTRIBUTE_RULES[attr] ?? erase(bytesRegister);
}

/**
 * Body rules, by the name an object's `:kind` gives.
 *
 * A media type means blob: the body is a hash and the bytes are fetched
 * separately. Anything not named here is a rule this client does not have,
 * which costs that object's body and nothing else (§3.4).
 */
export const BODY_RULES: Readonly<Record<string, AnyRule>> = {
  blob: erase(blob),
  register: erase(bytesRegister),
  'register:string': erase(stringRegister),
  // §3.8's bet: an ordered list two writers can edit at once, fitting the same
  // contract as the register above it. If this had needed an escape hatch —
  // log access, a clock, state outside the accumulator — the vocabulary claim
  // would have failed. See `sequence.ts` and `docs/SEQUENCE.md`.
  sequence: erase(sequence),
  // A reference to another space: a register over its public key
  // (`docs/MAIN-SPACE.md`). Structurally the blob rule with a different width —
  // a key rather than a hash — and it is the body rather than an attribute
  // because a link *is* its target, the way a file is its bytes (§4.2).
  link: erase(spaceRegister),
};

/** Resolve a `:kind` to a body rule, or null if this client lacks it. */
export function bodyRule(kind: string | null): AnyRule | null {
  if (kind === null) return null;
  // A media type names the blob rule and tells a view what the bytes are — the
  // overloading §3.9 flags. Treated here as: anything with a slash is a blob.
  if (kind.includes('/')) return erase(blob);
  return BODY_RULES[kind] ?? null;
}

/** Debug helper: a stable string for a key, for legible assertion failures. */
export function keyLabel(k: Key): string {
  return `${k.lamport}/${hex(k.writer).slice(0, 8)}/${hex(k.id).slice(0, 8)}`;
}

export { compareKeys };
