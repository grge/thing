/**
 * The ephemeral channel (ARCHITECTURE.md §10).
 *
 * Carries blob availability and presence now, and resolution at stage 8. One
 * protocol for all of them, because they share every property that matters:
 * each is about the present moment, none survives everyone disconnecting, and
 * none is replicated to a peer who was not there.
 *
 * **Nothing here is signed** (§10.2). The transport already establishes that a
 * message came from the party on the other end, and no ephemeral message is a
 * claim that must be believed: presence is about its own sender, availability
 * is checked by asking for a blob, and a resolution answer is checked by
 * dialling it. Signing would add attribution, not protection.
 *
 * **Nothing here is ever stored.** That is the structural guarantee the channel
 * rests on, and it is why this module has no reference to a store at all: there
 * is no path from an ephemeral message to the log to be careful about.
 */
import type { EphemeralMessage, Have, Presence } from './protocol.js';

/** A message with the moment it stops being true. */
interface Held<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * What a peer says it holds, and who is present, with expiry.
 *
 * Time is injected rather than read from a clock, so expiry is testable without
 * waiting and a caller can drive it from whatever notion of now it has.
 */
export class EphemeralState {
  /** peer -> blob hashes it advertised. */
  private readonly have = new Map<string, Held<Set<string>>>();
  /** peer -> whatever it last said about itself. */
  private readonly presence = new Map<string, Held<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Take a message from a peer.
   *
   * `peer` is the connection's own identifier, supplied by the transport rather
   * than carried in the message — which is exactly why messages need no
   * signature: a peer cannot claim to be another one, because it does not say
   * who it is.
   */
  receive(peer: string, msg: EphemeralMessage, ttl = DEFAULT_TTL): void {
    switch (msg.type) {
      case 'HAVE':
        this.have.set(peer, {
          value: new Set(msg.hashes),
          expiresAt: this.now() + ttl,
        });
        return;
      case 'PRESENCE':
        this.presence.set(peer, {
          value: msg.payload,
          expiresAt: this.now() + Math.max(0, msg.ttl),
        });
        return;
    }
  }

  /** Which connected peers claim to hold this blob (§2.4). */
  whoHas(hash: string): string[] {
    const out: string[] = [];
    for (const [peer, held] of this.have) {
      if (this.expired(held)) continue;
      if (held.value.has(hash)) out.push(peer);
    }
    return out.sort();
  }

  /** Everyone currently present, and what they last said. */
  present(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [peer, held] of this.presence) {
      if (!this.expired(held)) out.set(peer, held.value);
    }
    return out;
  }

  /** Forget a peer entirely, on disconnect. */
  forget(peer: string): void {
    this.have.delete(peer);
    this.presence.delete(peer);
  }

  /**
   * Drop what has expired.
   *
   * Expiry is also enforced on read, so this is an optimisation rather than a
   * correctness requirement — a caller that never sweeps still never sees a
   * stale value.
   */
  sweep(): void {
    for (const [peer, held] of this.have) if (this.expired(held)) this.have.delete(peer);
    for (const [peer, held] of this.presence) if (this.expired(held)) this.presence.delete(peer);
  }

  private expired(held: Held<unknown>): boolean {
    return held.expiresAt <= this.now();
  }
}

/**
 * How long an unqualified announcement is trusted.
 *
 * §5.3 says expiry belongs to whoever announced, since only they know their own
 * volatility. This is the fallback for a message that did not say.
 */
export const DEFAULT_TTL = 60_000;

export function haveMessage(hashes: readonly string[]): Have {
  return { type: 'HAVE', hashes: [...hashes] };
}

export function presenceMessage(payload: unknown, ttl = 30_000): Presence {
  return { type: 'PRESENCE', payload, ttl };
}
