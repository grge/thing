/**
 * The transport: carries this protocol's messages over whatever discovery
 * provides (§3.4, §6).
 *
 * Knows nothing about PeerJS. It is handed a `Signalling` implementation and
 * talks to `PeerLink`s, so a self-hosted signal server would drop in with no
 * change here.
 */
import { hex, sha256, verifyEvent } from '../fold/index.js';
import { BlobReceiver, type Channel, sendBlob, sendControl } from './blobtransfer.js';
import { metrics, type TransferRecord } from './metrics.js';
import { decodeFrame, type Message, PROTOCOL_VERSION, type WireEvent } from './protocol.js';
import type { PeerLink, Signalling } from './signalling.js';
import { eventsSince, PendingBuffer, versionVector } from './sync.js';
import type { Event } from '../fold/index.js';

/** A PeerLink seen as the byte pipe blobtransfer.ts needs. */
class LinkChannel implements Channel {
  constructor(
    private link: PeerLink,
    private onSent?: (bytes: number) => void,
  ) {}

  sendFrame(frame: ArrayBuffer): void {
    this.link.send(frame);
    this.onSent?.(frame.byteLength);
  }

  get bufferedAmount(): number {
    return this.link.bufferedAmount;
  }
}

export interface BlobStore {
  get(hash: string): Promise<Uint8Array | null>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The log this transport replicates. Supplied by the app so the transport does
 * not own storage — it reads to answer a peer and hands arrivals back.
 */
export interface EventLog {
  /** Everything held, for VV computation and diffing. */
  all(): readonly Event[];
  /** Apply events that arrived from a peer, in chain order. */
  apply(events: readonly Event[]): Promise<void>;
  toWire(e: Event): WireEvent;
  fromWire(w: WireEvent): Event;
}

export interface TransportEvents {
  onOpen?: (peerId: string) => void;
  onClose?: (peerId: string) => void;
  onError?: (err: string) => void;
  /** A blob finished arriving and passed its integrity check. */
  onBlob?: (hash: string, bytes: Uint8Array) => void;
  /** Progress for the UI's `fetching` state (§8.2). */
  onProgress?: (hash: string, received: number, total: number) => void;
  /** No connected peer holds this blob — the `unavailable` state (§8.2). */
  onNoBlob?: (hash: string) => void;
  /** ICE state, so a failure says which phase it failed in. */
  onIce?: (peerId: string, state: string) => void;
  /** Events arrived and were applied — the UI should re-fold. */
  onEvents?: (count: number) => void;
  /**
   * A writer's chain is stalled behind a missing event (§3.3). Loud by design:
   * in mode 2 this means the whole space stops updating (§10.2).
   */
  onStall?: (writer: string, from: number, to: number) => void;
}

export class Transport {
  private links = new Map<string, PeerLink>();
  private receiving = new Map<string, BlobReceiver>();
  private records = new Map<string, TransferRecord>();

  private pending = new PendingBuffer();
  private log: EventLog | null = null;
  private space = '';
  private gapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private signalling: Signalling,
    private store: BlobStore,
    private events: TransportEvents = {},
  ) {
    signalling.onPeer((link) => this.adopt(link));
    signalling.onError((err) => {
      metrics.note('error', err);
      this.events.onError?.(err);
    });
  }

  /**
   * The only place a channel is made, so byte counting cannot be forgotten in
   * one of the five call sites that need it.
   */
  private channelFor(link: PeerLink): LinkChannel {
    return new LinkChannel(link, (n) => {
      const attempt = metrics.latestFor(link.peerId);
      if (attempt !== undefined) attempt.bytesSent += n;
    });
  }

  /**
   * Attach a log to replicate. Without one the transport carries blobs only,
   * which is what the stage 4 harness does.
   *
   * `space` is the space's **identity** — a public key (DESIGN.md §4.1) — and
   * is compared against what a peer announces. Pass `''` when the identity is
   * not yet known, which is the case for a space joined by typed code: a code
   * names a rendezvous slot, not a space, so there is nothing to compare until
   * a peer answers and its signed events say who it is. Announcing the code
   * here instead would guarantee a mismatch against the writer's key, which is
   * exactly the bug this parameter exists to avoid.
   */
  attach(space: string, log: EventLog): void {
    this.space = space;
    this.log = log;
    this.pending = new PendingBuffer(log.all());
    this.startGapWatch();
  }

  /**
   * Re-issue GAP for anything still missing, on a backoff, logging loudly
   * (§3.3). There is no timeout that abandons a gap: a permanently missing
   * event stalls that writer's chain, and the failure must be noisy rather than
   * silent, since it is also the instrumentation for POC question 1.
   */
  private startGapWatch(): void {
    if (this.gapTimer !== null) clearInterval(this.gapTimer);
    this.gapTimer = setInterval(() => {
      for (const gap of this.pending.gaps()) {
        this.events.onStall?.(gap.writer, gap.from, gap.to);
        for (const link of this.links.values()) {
          sendControl(this.channelFor(link), {
            type: 'GAP',
            writer: gap.writer,
            from: gap.from,
            to: gap.to,
          });
        }
      }
    }, 5000);
  }

  /** Stream newly created local events to every connected peer (§3.4). */
  broadcast(events: readonly Event[]): void {
    if (this.log === null || events.length === 0) return;
    const wire = events.map((e) => this.log!.toWire(e));
    for (const link of this.links.values()) {
      sendControl(this.channelFor(link), { type: 'EVENTS', events: wire });
    }
  }

  get peerId(): string | null {
    return this.signalling.localId;
  }

  get connectedPeers(): string[] {
    return [...this.links.keys()];
  }

  async start(id?: string): Promise<string> {
    try {
      const assigned = await this.signalling.start(id);
      metrics.note('registered', `peer id ${assigned}`);
      return assigned;
    } catch (err) {
      // Failing to register is invisible in the connection table, because no
      // connection is ever attempted — so it has to be recorded here.
      metrics.note('error', `could not register with signalling: ${String(err)}`);
      throw err;
    }
  }

  /** Dial a peer. The attempt is recorded whether or not it succeeds. */
  async connect(peerId: string): Promise<void> {
    const attempt = metrics.beginConnection(peerId);
    try {
      const link = await this.signalling.connect(peerId);
      attempt.connectedAt = Date.now();
      attempt.usedRelay = (await this.signalling.diagnostics(link)?.usedRelay()) ?? null;
      this.adopt(link);
    } catch (err) {
      attempt.failedAt = Date.now();
      attempt.error = String(err);
      throw err;
    }
  }

  private adopt(link: PeerLink): void {
    const diag = this.signalling.diagnostics(link);

    /*
     * An outbound dial already recorded its attempt in connect(). An inbound
     * one has recorded nothing — and in mode 2 the writer only ever accepts,
     * so without this its own tab would show no connections at all, which is
     * precisely the tab someone debugging would be watching.
     */
    let attempt = metrics.latestFor(link.peerId);
    if (attempt === undefined || attempt.connectedAt !== null || attempt.failedAt !== null) {
      attempt = metrics.beginConnection(link.peerId, 'accepted');
    }
    const record = attempt;

    diag?.onIceStateChange((state) => {
      record.iceStates.push(state);
      this.events.onIce?.(link.peerId, state);
    });

    link.onData((data) => void this.receive(link, data));
    link.onError((err) => this.events.onError?.(`${link.peerId}: ${err}`));
    link.onClose(() => {
      this.links.delete(link.peerId);
      this.events.onClose?.(link.peerId);
    });

    link.onOpen(() => {
      this.links.set(link.peerId, link);
      if (record.connectedAt === null) record.connectedAt = Date.now();
      // Asynchronous and best-effort: the pair is only in the stats once the
      // connection is actually up, so it cannot be read any earlier.
      void (async () => {
        record.usedRelay = (await diag?.usedRelay()) ?? record.usedRelay;
        record.pair = (await diag?.pairDetail()) ?? record.pair;
      })();
      // The handshake: announce what we hold, so the peer can send the rest.
      sendControl(this.channelFor(link), {
        type: 'HELLO',
        space: this.space,
        protocol: PROTOCOL_VERSION,
        vv: this.log === null ? {} : versionVector(this.log.all()),
      });
      this.events.onOpen?.(link.peerId);
    });
  }

  /** Ask connected peers for a blob, resuming if part is already held. */
  want(hash: string): void {
    const fromChunk = this.receiving.get(hash)?.resumeFrom ?? 0;
    for (const link of this.links.values()) {
      sendControl(this.channelFor(link), { type: 'WANT', hash, fromChunk });
    }
  }

  private async receive(link: PeerLink, data: ArrayBuffer | string): Promise<void> {
    const inbound = metrics.latestFor(link.peerId);
    if (inbound !== undefined) {
      inbound.bytesReceived += typeof data === 'string' ? data.length : data.byteLength;
    }

    const frame = decodeFrame(data);
    if (frame === null) {
      // A peer's bytes are never trusted to be well-formed (§3.5 in spirit).
      this.events.onError?.(`${link.peerId}: undecodable frame`);
      return;
    }

    if (frame.kind === 'chunk') {
      const c = frame.chunk;
      let rx = this.receiving.get(c.hash);
      if (rx === undefined) {
        rx = new BlobReceiver(c.hash);
        this.receiving.set(c.hash, rx);
        this.records.set(c.hash, metrics.beginTransfer(c.hash, c.total, c.chunks, 'receive'));
      }
      rx.accept(c);
      this.events.onProgress?.(c.hash, rx.received, rx.total);

      if (!rx.complete) return;

      const bytes = rx.bytes()!;
      const actual = hex(await sha256(bytes));
      const rec = this.records.get(c.hash);
      this.receiving.delete(c.hash);
      this.records.delete(c.hash);

      if (actual !== c.hash) {
        // Whole-blob integrity only (§6), so a bad chunk costs the whole
        // transfer. §10.4 records retry granularity as the untuned knob.
        if (rec !== undefined) {
          rec.retries += 1;
          rec.ok = false;
        }
        this.events.onError?.(`blob ${c.hash.slice(0, 8)} failed integrity; re-requesting`);
        this.want(c.hash);
        return;
      }

      await this.store.put(c.hash, bytes);
      if (rec !== undefined) {
        rec.finishedAt = Date.now();
        rec.ok = true;
      }
      this.events.onBlob?.(c.hash, bytes);
      return;
    }

    await this.control(link, frame.msg);
  }

  private async control(link: PeerLink, msg: Message): Promise<void> {
    const channel = this.channelFor(link);

    switch (msg.type) {
      case 'HELLO': {
        // A version mismatch is refused loudly rather than half-spoken (§3.4).
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.events.onError?.(
            `peer ${link.peerId} speaks protocol ${msg.protocol}, this build speaks ${PROTOCOL_VERSION}`,
          );
          link.close();
          return;
        }
        // A peer in a different space is not a peer for our purposes.
        //
        // Both ids are identities — public keys (DESIGN.md §4.1) — never
        // locators. A peer that has not established its identity yet announces
        // `''` and is not rejected here; see `attach`. Reporting both sides is
        // deliberate: when this fires wrongly, the two values are the evidence,
        // and a bare "different space" hid a real bug once already.
        if (this.space !== '' && msg.space !== '' && msg.space !== this.space) {
          this.events.onError?.(
            `peer ${link.peerId} serves ${msg.space.slice(0, 8)}…, not ${this.space.slice(0, 8)}…`,
          );
          link.close();
          return;
        }
        // Send what they lack. Both directions happen in one exchange: they are
        // doing the same on receipt of our HELLO (§3.4).
        if (this.log !== null) {
          const missing = eventsSince(this.log.all(), msg.vv);
          if (missing.length > 0) {
            sendControl(channel, {
              type: 'EVENTS',
              events: missing.map((e) => this.log!.toWire(e)),
            });
          }
        }
        return;
      }

      case 'EVENTS': {
        if (this.log === null) return;
        // Every arrival goes through the hold-aside buffer, so the fold never
        // sees a writer's history with holes in it (§3.3).
        const applicable: Event[] = [];
        for (const w of msg.events) {
          try {
            const e = this.log.fromWire(w);
            // Verified at the boundary, before the event exists anywhere else
            // (DESIGN.md §5). An unverified event is treated as one we do not
            // have: dropped, never buffered, never folded. This is what closes
            // I5 and I6 on the wire — a peer cannot win by inflating a clock
            // or claiming another writer's id, because neither survives the
            // signature check.
            if (!(await verifyEvent(e))) {
              this.events.onError?.(`unverified event from ${link.peerId}, dropped`);
              continue;
            }
            applicable.push(...this.pending.offer(e));
          } catch (err) {
            this.events.onError?.(`undecodable event from ${link.peerId}: ${String(err)}`);
          }
        }
        if (applicable.length > 0) {
          await this.log.apply(applicable);
          this.events.onEvents?.(applicable.length);
        }
        // Anything buffered means a hole; ask for it now rather than waiting
        // for the watchdog.
        for (const gap of this.pending.gaps()) {
          sendControl(channel, { type: 'GAP', writer: gap.writer, from: gap.from, to: gap.to });
        }
        return;
      }

      case 'GAP': {
        if (this.log === null) return;
        const wanted = this.log
          .all()
          .filter((e) => hex(e.writer) === msg.writer && e.seq >= msg.from && e.seq <= msg.to)
          .sort((a, b) => a.seq - b.seq);
        if (wanted.length > 0) {
          sendControl(channel, {
            type: 'EVENTS',
            events: wanted.map((e) => this.log!.toWire(e)),
          });
        }
        return;
      }

      case 'WANT': {
        const bytes = await this.store.get(msg.hash);
        if (bytes === null) {
          sendControl(channel, { type: 'NOBLOB', hash: msg.hash });
          return;
        }
        const rec = metrics.beginTransfer(msg.hash, bytes.length, 0, 'send');
        try {
          const stats = await sendBlob(channel, msg.hash, bytes, msg.fromChunk);
          rec.pauses = stats.pauses;
          rec.finishedAt = Date.now();
          rec.ok = true;
        } catch (err) {
          rec.finishedAt = Date.now();
          rec.ok = false;
          this.events.onError?.(String(err));
        }
        return;
      }

      case 'NOBLOB':
        // Only report unavailable once no peer is still sending it (§8.2).
        if (!this.receiving.has(msg.hash)) this.events.onNoBlob?.(msg.hash);
        return;

    }
  }

  close(): void {
    if (this.gapTimer !== null) clearInterval(this.gapTimer);
    this.gapTimer = null;
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.signalling.stop();
  }
}
