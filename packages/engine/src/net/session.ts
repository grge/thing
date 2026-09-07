/**
 * One connection to one peer, for one space.
 *
 * Holds the state a connection needs — what the peer reported, what is held
 * aside waiting for a gap, what blobs are mid-transfer — and turns incoming
 * frames into calls on a `SpaceStore`. Everything below it is pure; this is
 * where the pure parts meet a peer.
 *
 * **Nothing enters the store unverified** (§2.3). Events go to `append`, which
 * checks signature and chain, and only what it accepted is acknowledged. A
 * peer cannot be trusted to have checked, and there is exactly one place where
 * that could be forgotten.
 */
import { chainOf, type Event, hex } from '../core/index.js';
import type { AppendResult, SpaceStore } from '../store/index.js';
import { BlobReceiver, type Channel, sendBlob } from './blobs.js';
import {
  announceMessage,
  type Answer,
  EphemeralState,
  haveMessage,
  resolveMessage,
  resolvedMessage,
} from './ephemeral.js';
import type { Locator } from './locator.js';
import {
  type ControlMessage,
  decodeFrame,
  encodeControl,
  encodeEphemeral,
  type EphemeralMessage,
  type Hello,
  PROTOCOL_VERSION,
  type Resolved,
  type WireVersionVector,
} from './protocol.js';
import {
  type Coverage,
  covers,
  frontiersOf,
  PendingEvents,
  reconcile,
  type Divergence,
} from './sync.js';
import { fromWire, toWire, vvToWire } from './wire.js';

export interface SessionOptions {
  /** This connection's identifier, from the transport. */
  readonly peer: string;
  /** Called when a chain is found to have forked (§2.3). */
  readonly onFork?: (fork: Divergence) => void;
  /** Called when events were accepted, so a caller can refold. */
  readonly onEvents?: (events: readonly Event[]) => void;
  /** Called when a blob finished transferring and verified. */
  readonly onBlob?: (hash: Uint8Array, bytes: Uint8Array) => void;
  /**
   * Called when a peer says it does not hold a blob (§2.4).
   *
   * Without this a refusal is indistinguishable from slowness: the transfer is
   * cancelled and nothing else happens, so a caller waits forever on bytes
   * that are never coming. That is the exact failure `NO_BLOB` was added to
   * the protocol to prevent, and it was only half-wired — the message arrived
   * and stopped there.
   */
  readonly onNoBlob?: (hash: string) => void;
  /**
   * Called when a peer announces blobs it holds (§2.4, §10).
   *
   * `HAVE` was recorded in ephemeral state and nothing acted on it, which left
   * the announcement useful only for a caller that went looking. The case that
   * needs it is a retry: a blob refused a moment ago because the peer was
   * still fetching it.
   */
  readonly onHave?: (hashes: readonly string[]) => void;
  /**
   * A peer announced what it serves (§5.3).
   *
   * The caller answers in kind, for the same reason `HELLO` does: whichever
   * side connects first announces into a connection whose other end has no
   * session yet, and that announcement is lost. Answering makes the exchange
   * symmetric without either side having to know which of them was first.
   */
  readonly onAnnounce?: () => void;
  /**
   * A peer is asking where a space is (§5.3).
   *
   * Answered by the caller, because only it knows what this peer serves and
   * what its *other* connections announced. One hop, no transit: an answer may
   * come from live connections, never from what those peers were told.
   */
  readonly onResolve?: (space: string) => Answer;
  /** An answer to a query this session asked. */
  readonly onResolved?: (msg: Resolved) => void;
  readonly now?: () => number;
}

/** How many events go in one message. Bounded so a batch cannot be unbounded. */
const BATCH = 200;

export class Session {
  private readonly pending = new PendingEvents<Event>();
  private readonly blobs = new BlobReceiver();
  readonly ephemeral: EphemeralState;

  /** What the peer last told us it holds. */
  private theirs: WireVersionVector = {};
  /**
   * Forks already reported, so each is surfaced once.
   *
   * Both peers detect the same divergence independently *and* tell each other
   * about it, so without this a caller would hear about one fork several times
   * — and would hear again on every reconnect.
   */
  private readonly reportedForks = new Set<string>();
  private greeted = false;
  /** Whether this session has answered a peer's first announcement. */
  private replied = false;
  private closed = false;

  /**
   * Questions asked and not yet answered (§2.3.1), by id.
   *
   * Kept so a reply can be matched to its asker: several may be outstanding,
   * and a connection that closes must fail them rather than leave a caller
   * waiting on a peer that has gone.
   */
  private readonly asked = new Map<number, (answer: Coverage) => void>();
  private nextAsk = 1;

  constructor(
    private readonly store: SpaceStore,
    private readonly channel: Channel,
    private readonly options: SessionOptions,
  ) {
    this.ephemeral = new EphemeralState(options.now ?? Date.now);
  }

  /** Open the conversation by saying what we hold. */
  async start(): Promise<void> {
    await this.sendHello();
  }

  private async sendHello(): Promise<void> {
    const hello: Hello = {
      type: 'HELLO',
      space: this.store.space,
      protocol: PROTOCOL_VERSION,
      vv: vvToWire(await this.store.versionVector()),
    };
    this.send(hello);
  }

  /**
   * Take one frame from the transport.
   *
   * Returns false if the frame was unusable, so a caller can count bad frames
   * from a peer without this throwing.
   */
  async receive(data: Uint8Array): Promise<boolean> {
    if (this.closed) return false;
    const frame = decodeFrame(data);
    if (frame === null) return false;

    switch (frame.kind) {
      case 'control':
        await this.onControl(frame.msg);
        return true;
      case 'ephemeral': {
        this.ephemeral.receive(this.options.peer, frame.msg);
        const msg = frame.msg;
        if (msg.type === 'HAVE') this.options.onHave?.(msg.hashes);
        else if (msg.type === 'ANNOUNCE') {
          // Answer the first one, once. Whichever side connects first
          // announces into a connection whose other end has no session yet, so
          // without a reply that announcement is simply lost — the same
          // problem `HELLO` solves by answering a greeting with one. Guarded
          // so two peers do not announce back and forth forever.
          if (!this.replied) {
            this.replied = true;
            this.options.onAnnounce?.();
          }
        } else if (msg.type === 'RESOLVE') {
          const answer = this.options.onResolve?.(msg.space) ?? { known: false, at: [] };
          this.sendEphemeral(resolvedMessage(msg.id, msg.space, answer));
        } else if (msg.type === 'RESOLVED') this.options.onResolved?.(msg);
        return true;
      }
      case 'chunk': {
        const result = await this.blobs.accept(frame.chunk);
        if (result.kind === 'complete') {
          await this.store.putBlob(result.bytes);
          this.options.onBlob?.(result.hash, result.bytes);
        }
        // A corrupt reassembly is dropped: the hash is the address, so bytes
        // that do not match it are not the blob that was asked for (§2.4).
        return result.kind !== 'corrupt';
      }
    }
  }

  private async onControl(msg: ControlMessage): Promise<void> {
    switch (msg.type) {
      case 'HELLO': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          // Different versions share no readable messages, so there is nothing
          // to negotiate — the connection is simply not usable.
          this.close();
          return;
        }
        if (msg.space !== this.store.space) {
          this.close();
          return;
        }
        this.theirs = msg.vv;
        // Answer a greeting with one, so either side may open.
        if (!this.greeted) {
          this.greeted = true;
          await this.sendHello();
        }
        await this.reconcileNow();
        return;
      }

      case 'EVENTS': {
        const events: Event[] = [];
        for (const w of msg.events) {
          const e = fromWire(w);
          if (e !== null) events.push(e);
        }
        await this.applyEvents(events);
        return;
      }

      case 'WANT': {
        await this.sendRange(msg.chain, msg.from, msg.to);
        return;
      }

      case 'FORKED': {
        // The peer noticed a divergence we may not have. Report it; repair is
        // deliberately not in this protocol (§2.3).
        this.reportFork(
          { chain: msg.chain, frontier: msg.frontier, mine: msg.theirs, theirs: msg.mine },
          false,
        );
        return;
      }

      case 'WANT_BLOB': {
        const hash = hexToBytes(msg.hash);
        const bytes = hash === null ? null : await this.store.getBlob(hash);
        if (bytes === null || hash === null) {
          this.send({ type: 'NO_BLOB', hash: msg.hash });
          return;
        }
        await sendBlob(this.channel, hash, bytes, msg.fromChunk);
        return;
      }

      case 'NO_BLOB': {
        this.blobs.cancel(msg.hash);
        this.options.onNoBlob?.(msg.hash);
        return;
      }

      case 'SYNCED?': {
        // Answered from the store, not from anything this session remembers:
        // the question is about what the peer *holds*, and the store is the
        // only thing that knows.
        const answer = covers(vvToWire(await this.store.versionVector()), msg.vv);
        this.send({
          type: 'SYNCED',
          id: msg.id,
          covered: answer.kind === 'covered',
          ...(answer.kind === 'behind' ? { behind: answer.chains } : {}),
          ...(answer.kind === 'forked' ? { forked: answer.forks.map((f) => f.chain) } : {}),
        });
        return;
      }

      case 'SYNCED': {
        const waiting = this.asked.get(msg.id);
        if (waiting === undefined) return; // A late reply to something abandoned.
        this.asked.delete(msg.id);
        waiting(
          msg.covered
            ? { kind: 'covered' }
            : msg.forked !== undefined && msg.forked.length > 0
              ? {
                  kind: 'forked',
                  // The chains are what crossed the wire; the tips are not, and
                  // are not needed to know that waiting is pointless.
                  forks: msg.forked.map((chain) => ({
                    chain,
                    frontier: -1,
                    mine: '',
                    theirs: '',
                  })),
                }
              : { kind: 'behind', chains: msg.behind ?? [] },
        );
        return;
      }
    }
  }

  /**
   * Append what the peer sent, hold what does not fit yet, ask for the gap.
   *
   * A batch may arrive with a hole in it, so anything storage refuses as a gap
   * is held rather than dropped (§2.5) and retried when the missing events
   * arrive.
   */
  private async applyEvents(events: readonly Event[]): Promise<void> {
    let result: AppendResult = await this.store.append(events);
    const accepted: Event[] = [...result.appended];

    for (const { event, why } of result.rejected) {
      if (why.kind === 'gap') this.pending.hold(chainOf(event), event.seq, event);
      // A duplicate is expected and ignored; a fork or a bad signature is the
      // peer's problem, not something to retry.
    }

    // Anything held may now be applicable. Draining can cascade: applying one
    // run may unblock the next, so this repeats until nothing more fits.
    while (this.pending.size > 0) {
      const vv = await this.store.versionVector();
      let progressed = false;
      for (const [chain, f] of vv) {
        const ready = this.pending.drain(chain, f.frontier);
        if (ready.length === 0) continue;
        result = await this.store.append(ready);
        accepted.push(...result.appended);
        // Only real progress ends the loop; a run the store refused as
        // duplicates would otherwise spin here forever.
        if (result.appended.length > 0) progressed = true;
      }
      if (!progressed) break;
    }

    // Only what actually entered the log. A peer may send the same range more
    // than once — reconciliation on HELLO, then again answering a WANT — and
    // the store deduplicates, so reporting every *arrival* would suggest
    // activity that did not happen.
    if (accepted.length > 0) this.options.onEvents?.(accepted);

    // Ask for whatever is still missing.
    const vv = await this.store.versionVector();
    for (const gap of this.pending.gaps(frontiersOf(vvToWire(vv)))) {
      this.send({ type: 'WANT', chain: gap.chain, from: gap.from });
    }
  }

  /** Compare vectors and act: send, ask, and report forks. */
  private async reconcileNow(): Promise<void> {
    const mine = vvToWire(await this.store.versionVector());
    const plan = reconcile(mine, this.theirs);

    // Reported rather than repaired, and deliberately not fatal: a fork is
    // confined to one chain and the rest of the space still syncs.
    for (const fork of plan.forked) this.reportFork(fork, true);

    for (const range of plan.want) {
      this.send({ type: 'WANT', chain: range.chain, from: range.from });
    }
    for (const range of plan.send) {
      await this.sendRange(range.chain, range.from);
    }
  }

  /**
   * Surface a fork once, and optionally tell the peer.
   *
   * Keyed by chain and the two tips, so a genuinely new divergence on the
   * same chain is still reported while a repeat of the same one is not.
   */
  private reportFork(fork: Divergence, tell: boolean): void {
    const key = `${fork.chain}:${fork.mine}:${fork.theirs}`;
    if (this.reportedForks.has(key)) return;
    this.reportedForks.add(key);

    this.options.onFork?.(fork);
    if (tell) {
      this.send({
        type: 'FORKED',
        chain: fork.chain,
        frontier: fork.frontier,
        mine: fork.mine,
        theirs: fork.theirs,
      });
    }
  }

  private async sendRange(chain: string, from: number, to?: number): Promise<void> {
    const batch: Event[] = [];
    for await (const e of this.store.readRange(
      to === undefined ? { chain, from } : { chain, from, to },
    )) {
      batch.push(e);
      if (batch.length >= BATCH) {
        this.send({ type: 'EVENTS', events: batch.map(toWire) });
        batch.length = 0;
      }
    }
    if (batch.length > 0) this.send({ type: 'EVENTS', events: batch.map(toWire) });
  }

  /**
   * Push events to the peer.
   *
   * Reconciliation happens once, when vectors are exchanged. Everything written
   * *after* that has to be pushed, or two connected peers would each sit on
   * their own new events until something forced another handshake — which is
   * how a live connection ends up silently stale.
   *
   * The receiver verifies and deduplicates as always, so pushing something it
   * already holds costs a message and nothing else.
   */
  push(events: readonly Event[]): void {
    if (events.length === 0) return;
    for (let at = 0; at < events.length; at += BATCH) {
      this.send({ type: 'EVENTS', events: events.slice(at, at + BATCH).map(toWire) });
    }
  }

  /**
   * Ask whether this peer is at least as recent as `mine` (§2.3.1).
   *
   * The condition under which a writer may go away: if the answer is covered,
   * this peer is not relying on the asker for anything in that vector.
   *
   * `mine` is passed in rather than read here, deliberately. A writer that
   * keeps writing while it waits would never settle against its own moving
   * vector, so the caller captures the moment it cares about and asks about
   * that (§2.3.1's *against a snapshot, not the present*).
   */
  askSynced(mine: WireVersionVector): Promise<Coverage> {
    if (this.closed) return Promise.resolve({ kind: 'behind', chains: Object.keys(mine) });
    const id = this.nextAsk++;
    return new Promise<Coverage>((resolve) => {
      this.asked.set(id, resolve);
      this.send({ type: 'SYNCED?', id, vv: mine });
    });
  }

  /** Ask a peer for a blob, resuming where an earlier attempt stopped. */
  requestBlob(hash: Uint8Array): void {
    const h = hex(hash);
    this.send({ type: 'WANT_BLOB', hash: h, fromChunk: this.blobs.resumeFrom(h) });
  }

  /**
   * Tell the peer we now hold one blob (§2.4).
   *
   * The arrival half of `HAVE`. Without it a peer that asked too early — while
   * this one was still fetching the bytes itself — gets `NO_BLOB` and has no
   * way to learn the answer changed. That is a real race rather than a
   * theoretical one: a relay mirrors a blob and the client asking through it
   * usually asks first, because the event arrives before the bytes do.
   */
  announceBlob(hash: string): void {
    this.sendEphemeral(haveMessage([hash]));
  }

  /** Tell this peer what spaces we serve, and how to reach us (§5.3). */
  announce(spaces: readonly string[], at: readonly Locator[] = []): void {
    this.sendEphemeral(announceMessage(spaces, at));
  }

  /** Ask this peer where a space is. The answer arrives at `onResolved`. */
  resolve(id: number, space: string): void {
    this.sendEphemeral(resolveMessage(id, space));
  }

  /** What this peer's connections announced about a space, for answering. */
  serversOf(space: string): { peer: string; at: readonly string[] }[] {
    return this.ephemeral.whoServes(space);
  }

  /** Whether this peer ever announced a space — §5.3's *unknown* case. */
  knowsOf(space: string): boolean {
    return this.ephemeral.knows(space);
  }

  /** When it was last announced, for "nobody is serving, last seen at T". */
  seenServing(space: string): number | undefined {
    return this.ephemeral.seenAt(space);
  }

  /** Tell the peer what blobs we hold (§2.4). */
  async announceBlobs(): Promise<void> {
    const hashes: string[] = [];
    for await (const h of this.store.blobHashes()) hashes.push(hex(h));
    this.sendEphemeral(haveMessage(hashes));
  }

  sendEphemeral(msg: EphemeralMessage): void {
    if (this.closed) return;
    this.channel.send(encodeEphemeral(msg));
  }

  /** Whatever this peer told us it has, for routing a blob request. */
  peerHas(hash: Uint8Array): boolean {
    return this.ephemeral.whoHas(hex(hash)).includes(this.options.peer);
  }

  private send(msg: ControlMessage): void {
    if (this.closed) return;
    this.channel.send(encodeControl(msg));
  }

  close(): void {
    this.closed = true;
    // Answer whatever is outstanding rather than leaving it pending: a peer
    // that has gone will never reply, and a caller waiting on a dead
    // connection is the failure this whole question exists to prevent.
    for (const [, resolve] of this.asked) resolve({ kind: 'behind', chains: [] });
    this.asked.clear();
    this.ephemeral.forget(this.options.peer);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

function hexToBytes(s: string): Uint8Array | null {
  if (s.length !== 64 || !/^[0-9a-f]+$/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
