/**
 * The event envelope and its canonical encoding (ARCHITECTURE.md §2.1).
 *
 * An event is one assertion: *this slice of this object now has this value.*
 * Events are never mutated and never deleted.
 *
 * **Values are opaque bytes here.** The substrate never reads one and the fold
 * kernel routes bags without inspecting them; a value means nothing until its
 * slice's rule decodes it (§3.2). So there is no value vocabulary in this
 * package — no union of types, no positions, no links. Those belong to rules.
 */
import { hex, Writer } from './bytes.js';
import { Domain } from './domain.js';
import { hash, type Hash, HASH_LEN } from './hash.js';
import { PUBLIC_KEY_LEN, type PublicKey, sign, type Signature, verify, type KeyPair } from './sign.js';

/** An object's identity. 16 bytes, assigned at creation, never reused (§2.1). */
export type Uuid = Uint8Array;

export const UUID_LEN = 16;

/**
 * An append point: one process's place to write, within one writer's identity.
 *
 * **`writer` says who; `point` says where.** Two processes holding one key —
 * a server and the CLI attached to it, two browser tabs — are the same
 * participant and must be able to write at the same time. Sharing a chain they
 * cannot: both resume from one tip, both mint at `seq = frontier + 1`, and the
 * result is two different events at one sequence number, *both validly signed*.
 * Signing cannot catch that, because the key genuinely signed both; the
 * literature calls it equivocation (`docs/design/EQUIVOCATION.md`).
 *
 * So a chain is keyed by `(writer, point)` rather than by `writer`, and each
 * process mints a fresh point when it opens a space for writing. Nothing
 * contends, so nothing forks, and no lock is needed to prevent it.
 *
 * **Opaque, and deliberately not a key.** A point identifies a chain; it does
 * not authorise anything. Authority is the writer's, checked by the signature,
 * exactly as before. See `docs/design/APPEND-POINTS.md` for why a per-point keypair
 * was rejected.
 */
export type Point = Uint8Array;

export const POINT_LEN = 16;

/**
 * A fresh append point.
 *
 * Random rather than counted: a counter would need agreement between the very
 * processes that cannot coordinate, which is the problem this solves. 16 random
 * bytes collide with probability that stays negligible for any number of
 * processes a person will ever run.
 */
/**
 * Canonicalise a dep set: sorted, deduplicated.
 *
 * Sorting matters because `deps` is in the signed preimage — an unordered set
 * would let one writer's knowledge produce several distinct signatures, and two
 * peers computing the same event's id would disagree.
 */
export function newDeps(hashes: Iterable<Hash>): Hash[] {
  const seen = new Map<string, Hash>();
  for (const h of hashes) seen.set(hex(h), h);
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, h]) => h);
}

export function newPoint(): Point {
  const out = new Uint8Array(POINT_LEN);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues !== undefined) {
    crypto.getRandomValues(out);
    return out;
  }
  // No platform RNG. Refusing beats silently minting a predictable point that
  // two processes could both pick.
  throw new Error('no secure random source for an append point');
}

/** The root object, where the writer set and the space's own attributes live. */
export const ROOT: Uuid = new Uint8Array(UUID_LEN);

/**
 * An event, minus its signature — everything that gets signed.
 *
 * Split from `Event` so the preimage has a type of its own: it is what a writer
 * constructs and what verification recomputes, and conflating the two invites
 * signing something subtly different from what is checked.
 */
export interface EventBody {
  /** The writer's Ed25519 public key (§2.1). Who is accountable for this. */
  readonly writer: PublicKey;
  /**
   * Which of this writer's chains this event extends.
   *
   * One process's append point. Identity is `writer`; this is only position,
   * so nothing about permission or ordering consults it.
   */
  readonly point: Point;
  /** Per `(writer, point)`, starts at 0, strictly incrementing. */
  readonly seq: number;
  /** Hash of this chain's event at `seq - 1`; null iff `seq === 0`. */
  readonly prev: Hash | null;
  /**
   * What this writer had seen when it signed: the ids of the events that were
   * heads of the log, excluding anything reachable through them.
   *
   * **`prev` proves a chain is intact; `deps` proves what was known.** They are
   * not redundant. `prev` is one hash of the author's *own* previous event, and
   * checking it is what makes `seq` trustworthy — you cannot claim `seq 5`
   * without producing the real event at `seq 4`, which is what turns a version
   * vector's "0–47 contiguous" into a verified statement rather than a claim.
   * `deps` is a set, mostly of *other people's* events, and nothing checks it
   * against a chain because there is no chain to check it against.
   *
   * **What it is for.** A space's writer set lives in the log it governs, so
   * folding an event means asking whether its writer was allowed — and
   * *allowed* changes over time. Without `deps` the fold can only check against
   * the writer set as it stands now, which retroactively unwrites everything a
   * removed writer ever wrote (§7.2.3 forbids exactly that) or depends on
   * arrival order (§3.6 forbids that). With `deps` the question becomes *was
   * this writer admitted in the state its author had seen*, which is a property
   * of the event and identical on every peer.
   *
   * **What it does not do.** A writer about to be removed can sign an event
   * naming only pre-removal heads and release it later; it will fold. That is
   * indistinguishable from an honest peer that was offline, and the literature
   * is clear that causality alone cannot separate the two. `deps` narrows
   * backdating from *claim any position in history* to *claim a real position
   * you can produce hashes for*. See `docs/design/DEPS.md`.
   *
   * Ordered and deduplicated by `newDeps`, so the encoding is canonical.
   */
  readonly deps: readonly Hash[];
  /** Logical clock, for ordering concurrent writes (§2.2). */
  readonly lamport: number;
  /** The object this asserts about. */
  readonly target: Uuid;
  /** Which slice of that object (§3.1). */
  readonly attr: string;
  /** Opaque to everything but the slice's rule (§3.2). */
  readonly value: Uint8Array;
  /**
   * Wall-clock milliseconds.
   *
   * **The one field with no mechanical purpose.** Nothing resolves by it, no
   * rule reads it, and a wrong value breaks nothing — it exists so a person can
   * be told when something happened. It is in the preimage, so it is part of an
   * event's identity, and two events differing only here are different events.
   */
  readonly wall: number;
}

export interface Event extends EventBody {
  /** Ed25519 over `encodeEventBody`, under `Domain.Event`. */
  readonly sig: Signature;
}

/**
 * The signed preimage: the space key, then the envelope.
 *
 * **The space key is here and not on the wire** (§2.1). A receiver knows which
 * space a connection carries, so transmitting it would be redundant — but
 * without it in the preimage a signed event is portable between any two spaces
 * its writer belongs to, and can be replayed from one into another. The domain
 * tag is prepended by `sign`, so this is not the whole of what gets signed.
 */
export function encodeEventBody(space: PublicKey, e: EventBody): Uint8Array {
  const w = new Writer();

  w.fixed(space, PUBLIC_KEY_LEN, 'space key');
  w.fixed(e.writer, PUBLIC_KEY_LEN, 'writer');
  w.fixed(e.point, POINT_LEN, 'point');
  w.u32(e.seq);
  // Count then hashes. Canonical because `newDeps` sorts and deduplicates, so
  // two writers with the same knowledge produce the same bytes.
  w.u32(e.deps.length);
  for (const d of e.deps) w.fixed(d, HASH_LEN, 'dep');

  if (e.prev === null) {
    w.u8(0);
  } else {
    w.u8(1);
    w.fixed(e.prev, HASH_LEN, 'prev');
  }

  w.u64(e.lamport);
  w.fixed(e.target, UUID_LEN, 'target');
  w.string(e.attr);
  w.lenPrefixed(e.value);
  w.u64(e.wall);

  return w.finish();
}

/**
 * An event's identity: the hash of its preimage.
 *
 * **The signature is not part of it.** An event's id therefore does not depend
 * on which of several valid signatures a writer produced, and stays stable under
 * any later change to the signature scheme.
 *
 * Synchronous, deliberately: this is on the fold's hot path, and an async hash
 * would make the fold async (§3.6).
 */
export function eventId(space: PublicKey, e: EventBody): Hash {
  return hash(encodeEventBody(space, e));
}

/** Sign an event body, yielding a complete event. */
export async function signEvent(
  space: PublicKey,
  body: EventBody,
  key: KeyPair,
): Promise<Event> {
  const sig = await sign(Domain.Event, encodeEventBody(space, body), key);
  return { ...body, sig };
}

/**
 * Verify an event against the key it claims to be from, in the space it claims
 * to be in.
 *
 * Both arguments matter: the writer key is what the signature is checked
 * against, and the space key is in the preimage, so an event lifted from another
 * space fails here rather than deeper in.
 */
export function verifyEvent(space: PublicKey, e: Event): Promise<boolean> {
  return verify(Domain.Event, encodeEventBody(space, e), e.sig, e.writer);
}

/** A slice key: which bag an event belongs to (§3.1). */
export function sliceKey(target: Uuid, attr: string): string {
  return `${hex(target)} ${attr}`;
}

export function sliceKeyOf(e: EventBody): string {
  return sliceKey(e.target, e.attr);
}
