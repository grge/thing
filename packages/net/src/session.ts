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
import { type Event, hex } from '@thing/core';
import type { AppendResult, SpaceStore } from '@thing/store';
import { BlobReceiver, type Channel, sendBlob } from './blobs.js';
import { EphemeralState, haveMessage } from './ephemeral.js';
import {
  type ControlMessage,
  decodeFrame,
  encodeControl,
  encodeEphemeral,
  type EphemeralMessage,
  type Hello,
  PROTOCOL_VERSION,
  type WireVersionVector,
} from './protocol.js';
import { frontiersOf, PendingEvents, reconcile, type Divergence } from './sync.js';
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
  private closed = false;

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
      case 'ephemeral':
        this.ephemeral.receive(this.options.peer, frame.msg);
        return true;
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
        await this.sendRange(msg.writer, msg.from, msg.to);
        return;
      }

      case 'FORKED': {
        // The peer noticed a divergence we may not have. Report it; repair is
        // deliberately not in this protocol (§2.3).
        this.reportFork(
          { writer: msg.writer, frontier: msg.frontier, mine: msg.theirs, theirs: msg.mine },
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
      if (why.kind === 'gap') this.pending.hold(hex(event.writer), event.seq, event);
      // A duplicate is expected and ignored; a fork or a bad signature is the
      // peer's problem, not something to retry.
    }

    // Anything held may now be applicable.
    if (this.pending.size > 0) {
      const vv = await this.store.versionVector();
      for (const [writer, f] of vv) {
        const ready = this.pending.drain(writer, f.frontier);
        if (ready.length === 0) continue;
        result = await this.store.append(ready);
        accepted.push(...result.appended);
      }
    }

    if (accepted.length > 0) this.options.onEvents?.(accepted);

    // Ask for whatever is still missing.
    const vv = await this.store.versionVector();
    for (const gap of this.pending.gaps(frontiersOf(vvToWire(vv)))) {
      this.send({ type: 'WANT', writer: gap.writer, from: gap.from });
    }
  }

  /** Compare vectors and act: send, ask, and report forks. */
  private async reconcileNow(): Promise<void> {
    const mine = vvToWire(await this.store.versionVector());
    const plan = reconcile(mine, this.theirs);

    // Reported rather than repaired, and deliberately not fatal: a fork is
    // confined to one writer's chain and the rest of the space still syncs.
    for (const fork of plan.forked) this.reportFork(fork, true);

    for (const range of plan.want) {
      this.send({ type: 'WANT', writer: range.writer, from: range.from });
    }
    for (const range of plan.send) {
      await this.sendRange(range.writer, range.from);
    }
  }

  /**
   * Surface a fork once, and optionally tell the peer.
   *
   * Keyed by writer and the two tips, so a genuinely new divergence on the
   * same chain is still reported while a repeat of the same one is not.
   */
  private reportFork(fork: Divergence, tell: boolean): void {
    const key = `${fork.writer}:${fork.mine}:${fork.theirs}`;
    if (this.reportedForks.has(key)) return;
    this.reportedForks.add(key);

    this.options.onFork?.(fork);
    if (tell) {
      this.send({
        type: 'FORKED',
        writer: fork.writer,
        frontier: fork.frontier,
        mine: fork.mine,
        theirs: fork.theirs,
      });
    }
  }

  private async sendRange(writer: string, from: number, to?: number): Promise<void> {
    const batch: Event[] = [];
    for await (const e of this.store.readRange(
      to === undefined ? { writer, from } : { writer, from, to },
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

  /** Ask a peer for a blob, resuming where an earlier attempt stopped. */
  requestBlob(hash: Uint8Array): void {
    const h = hex(hash);
    this.send({ type: 'WANT_BLOB', hash: h, fromChunk: this.blobs.resumeFrom(h) });
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
