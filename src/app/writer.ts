/**
 * Event creation (DESIGN.md §3, §5). The only thing in the app that appends to
 * a log.
 *
 * Readers do not construct one of these at all: a reader holds no private key,
 * and that — rather than convention — is what makes a reader read-only
 * (DESIGN.md §4.1). The writer's identity *is* its public key, so `id` and the
 * space id are the same 32 bytes.
 */
import {
  type AttrName,
  type Event,
  eventId,
  type Hash,
  type KeyPair,
  type Kind,
  type Pos,
  signEvent,
  SIG_LEN,
  type Uuid,
  type Value,
  validateEvent,
  type WriterId,
} from '../fold/index.js';

export class Writer {
  private seq: number;
  private prev: Hash | null;
  private lamport: number;

  private constructor(
    private readonly key: KeyPair,
    seq: number,
    prev: Hash | null,
    lamport: number,
  ) {
    this.seq = seq;
    this.prev = prev;
    this.lamport = lamport;
  }

  /** The public key: this writer's id, and the space's id (DESIGN.md §4.1). */
  get id(): WriterId {
    return this.key.publicKey;
  }

  /**
   * Resume from an existing log. Scans for this writer's highest seq and the
   * whole log's highest lamport — the latter across *all* writers, since §2.2's
   * receive rule is `counter = max(counter, event.lamport)` and a loaded log is
   * indistinguishable from a received one.
   */
  static async resume(key: KeyPair, events: readonly Event[]): Promise<Writer> {
    let seq = 0;
    let prev: Hash | null = null;
    let lamport = 0;
    let last: Event | null = null;

    const idHex = hexOf(key.publicKey);
    for (const e of events) {
      if (e.lamport > lamport) lamport = e.lamport;
      if (hexOf(e.writer) === idHex && (last === null || e.seq > last.seq)) last = e;
    }
    if (last !== null) {
      seq = last.seq + 1;
      prev = await eventId(last);
    }
    return new Writer(key, seq, prev, lamport);
  }

  /** §2.2 receive rule. Called when events arrive from a peer (stage 5). */
  observe(lamport: number): void {
    if (lamport > this.lamport) this.lamport = lamport;
  }

  get state(): { seq: number; lamport: number } {
    return { seq: this.seq, lamport: this.lamport };
  }

  /**
   * Append one assertion. Advances seq by exactly 1 and lamport by at least 1,
   * so this writer never reuses a stamp — the invariant `(lamport, writer)`
   * depends on to be a total order (§2.2).
   */
  private async emit(target: Uuid, attr: AttrName, value: Value): Promise<Event> {
    this.lamport += 1;
    // Signed over the canonical encoding, which does not include `sig` itself
    // (see fold/sign.ts). The placeholder is never encoded and never escapes.
    const unsigned: Event = {
      writer: this.key.publicKey,
      seq: this.seq,
      prev: this.prev,
      lamport: this.lamport,
      target,
      attr,
      value,
      wall: Date.now(),
      sig: EMPTY_SIG,
    };
    const e: Event = { ...unsigned, sig: await signEvent(unsigned, this.key) };
    validateEvent(e);
    this.seq += 1;
    this.prev = await eventId(e);
    return e;
  }

  setParent(target: Uuid, parent: Uuid): Promise<Event> {
    return this.emit(target, ':parent', { t: 'uuid', v: parent });
  }
  setName(target: Uuid, name: string): Promise<Event> {
    return this.emit(target, ':name', { t: 'string', v: name });
  }
  setContent(target: Uuid, hash: Hash | null): Promise<Event> {
    return this.emit(target, ':content', hash === null ? { t: 'null' } : { t: 'hash', v: hash });
  }
  setPos(target: Uuid, pos: Pos): Promise<Event> {
    return this.emit(target, ':pos', { t: 'pos', v: pos });
  }
  setDeleted(target: Uuid, deleted: boolean): Promise<Event> {
    return this.emit(target, ':deleted', { t: 'bool', v: deleted });
  }
  setKind(target: Uuid, kind: Kind): Promise<Event> {
    return this.emit(target, ':kind', { t: 'kind', v: kind });
  }
  setType(target: Uuid, mime: string): Promise<Event> {
    return this.emit(target, ':type', { t: 'string', v: mime });
  }
}

/** Stand-in for the signature while the event is being signed. Never emitted. */
const EMPTY_SIG = new Uint8Array(SIG_LEN);

function hexOf(b: Uint8Array): string {
  let s = '';
  for (const byte of b) s += byte.toString(16).padStart(2, '0');
  return s;
}

export function newUuid(): Uuid {
  return crypto.getRandomValues(new Uint8Array(16));
}
