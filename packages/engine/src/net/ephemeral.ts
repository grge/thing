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
import { formatLocator, type Locator } from './locator.js';
import type { Announce, EphemeralMessage, Have, Presence, Resolve, Resolved } from './protocol.js';

/**
 * Caps on what one peer's announcement may claim (§5.3).
 *
 * **Bounds rather than trust**, which is the whole shape of the protections
 * here: a bad answer costs a wasted dial, so nothing needs to be believed and
 * everything needs to be limited. Unmeasured starting values — §5.3 says the
 * numbers belong in a measurement against a real network.
 */
export const MAX_SPACES_PER_PEER = 256;
export const MAX_LOCATORS_PER_PEER = 4;

/**
 * What a peer knows about where a space is (§5.3's three-way answer).
 *
 * `known: false` is *I do not track this space* — stop asking me. `known: true`
 * with an empty `at` is *I track it and nobody is serving*, which is a
 * different thing and worth telling a person.
 */
export interface Answer {
  readonly known: boolean;
  readonly at: readonly Locator[];
  readonly lastSeen?: number;
}

/** What one peer said it serves. */
interface Announced {
  readonly spaces: ReadonlySet<string>;
  readonly at: readonly string[];
}

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
  /**
   * peer -> space -> whatever it last said about itself there.
   *
   * Keyed by space as well as by peer, because one connection carries several
   * (`design/CONNECTIONS.md`) and a person may have two documents open. A
   * single slot per peer meant the second document's cursor overwrote the
   * first's.
   */
  private readonly presence = new Map<string, Map<string, Held<unknown>>>();
  /**
   * peer -> the spaces it announced, and how to reach it.
   *
   * Keyed by peer rather than by space, which is what makes §5.3's important
   * cap enforceable: *a cap on entries per announcing peer* is what stops one
   * peer crowding the real entry out of a list, and it is only expressible if
   * the entries are grouped by who said them.
   */
  private readonly announced = new Map<string, Held<Announced>>();
  /** space -> when anyone was last seen serving it, for the three-way answer. */
  private readonly lastSeen = new Map<string, number>();

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
        let forPeer = this.presence.get(peer);
        if (forPeer === undefined) {
          forPeer = new Map();
          this.presence.set(peer, forPeer);
        }
        forPeer.set(msg.space, {
          value: msg.payload,
          expiresAt: this.now() + Math.max(0, msg.ttl),
        });
        return;
      case 'ANNOUNCE': {
        // Capped per announcing peer (§5.3), which is the bound that matters:
        // one peer announcing ten thousand spaces must not be able to crowd
        // out the answer someone else gave.
        const spaces = msg.spaces.slice(0, MAX_SPACES_PER_PEER);
        const at = (msg.at ?? []).slice(0, MAX_LOCATORS_PER_PEER);
        this.announced.set(peer, {
          value: { spaces: new Set(spaces), at },
          expiresAt: this.now() + Math.max(0, msg.ttl),
        });
        for (const space of spaces) this.lastSeen.set(space, this.now());
        return;
      }
      // A query and its answer are conversation, not state: the session routes
      // them to whoever asked. Nothing here remembers them.
      case 'RESOLVE':
      case 'RESOLVED':
        return;
    }
  }

  /**
   * Which connected peers say they serve this space, and how to reach them.
   *
   * An empty `at` means *on this connection* — the announcer gave no address
   * because it has none to give, or because it dialled you. The caller knows
   * which connection the peer is and can use that.
   */
  whoServes(space: string): { peer: string; at: readonly string[] }[] {
    const out: { peer: string; at: readonly string[] }[] = [];
    for (const [peer, held] of this.announced) {
      if (this.expired(held)) continue;
      if (held.value.spaces.has(space)) out.push({ peer, at: held.value.at });
    }
    return out.sort((a, b) => (a.peer < b.peer ? -1 : 1));
  }

  /** Whether this peer has ever heard of a space — §5.3's *unknown* case. */
  knows(space: string): boolean {
    return this.lastSeen.has(space);
  }

  /** When anyone was last seen serving it, for the *nobody is serving* answer. */
  seenAt(space: string): number | undefined {
    return this.lastSeen.get(space);
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

  /**
   * Everyone currently present in one space, and what they last said.
   *
   * Per space, because presence is about a document rather than a connection:
   * two people editing different files over one transport are not present
   * together.
   */
  present(space: string): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [peer, byspace] of this.presence) {
      const held = byspace.get(space);
      if (held !== undefined && !this.expired(held)) out.set(peer, held.value);
    }
    return out;
  }

  /** How many blobs one peer advertised, for an availability view (§2.4). */
  blobCount(peer: string): number {
    const held = this.have.get(peer);
    return held === undefined || this.expired(held) ? 0 : held.value.size;
  }

  /**
   * Forget a peer entirely, on disconnect.
   *
   * `lastSeen` deliberately survives: it is the *memory* that a space was once
   * served, which is what makes "nobody is serving, last seen at T" a different
   * answer from "I have never heard of this".
   */
  forget(peer: string): void {
    this.have.delete(peer);
    this.presence.delete(peer);
    this.announced.delete(peer);
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
    for (const [peer, byspace] of this.presence) {
      for (const [space, held] of byspace) if (this.expired(held)) byspace.delete(space);
      if (byspace.size === 0) this.presence.delete(peer);
    }
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

export function presenceMessage(space: string, payload: unknown, ttl = 30_000): Presence {
  return { type: 'PRESENCE', space, payload, ttl };
}

/**
 * "I serve these, reach me here" (§5.3).
 *
 * `at` may be empty, and usually is: a peer that dialled you needs no address,
 * and a browser has none to give. Empty means *on this connection*.
 */
export function announceMessage(
  spaces: readonly string[],
  at: readonly Locator[] = [],
  ttl = DEFAULT_TTL,
): Announce {
  return {
    type: 'ANNOUNCE',
    spaces: [...spaces],
    ...(at.length === 0 ? {} : { at: at.map(formatLocator) }),
    ttl,
  };
}

export function resolveMessage(id: number, space: string): Resolve {
  return { type: 'RESOLVE', id, space };
}

/** The three-way answer (§5.3), built from what a peer actually knows. */
export function resolvedMessage(
  id: number,
  space: string,
  found: { known: boolean; at: readonly Locator[]; lastSeen?: number },
): Resolved {
  return {
    type: 'RESOLVED',
    id,
    space,
    known: found.known,
    at: found.at.map(formatLocator),
    ...(found.lastSeen === undefined ? {} : { lastSeen: found.lastSeen }),
  };
}
