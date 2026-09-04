/**
 * Domain separation for signatures (ARCHITECTURE.md §2.1).
 *
 * Every preimage this system signs begins with a tag saying what kind of thing
 * is being signed. A key signs more than one kind — log events here, ephemeral
 * channel messages at stage 5 (§10.2) — and two protocols sharing a key without
 * distinguishing their preimages are one protocol with a hole in it: a message
 * signed for one can be replayed as the other.
 *
 * The tags live in one place so that adding a kind means adding a line here,
 * where the existing values are visible and a collision is obvious.
 *
 * **Never renumber.** These bytes are signed; changing one invalidates every
 * signature ever made under it.
 */

export const Domain = {
  /** A log event (§2.1). */
  Event: 1,

  // Reserved for the ephemeral channel (§10.2), which signs at least the
  // message kinds that make claims other peers act on. Not yet used, listed so
  // the numbering is decided in one place rather than three.
  //
  // Announce:  2,
  // Resolve:   3,
  // Presence:  4,
} as const;

export type Domain = (typeof Domain)[keyof typeof Domain];
