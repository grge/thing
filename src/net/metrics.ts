/**
 * Instrumentation for POC question 1.
 *
 * The plan says to instrument from the first commit, because these numbers are
 * the deliverable rather than a side effect: connection failure rate without
 * TURN, time-to-connect, stall frequency, whole-blob retry frequency.
 *
 * Kept in memory and dumped as JSON; nothing here needs to survive a reload.
 */

/** How a candidate pair was actually formed — the "how did this negotiate" detail. */
export interface PairDetail {
  /** host | srflx | prflx | relay, from the ICE stats rather than assumed. */
  readonly local: string | null;
  readonly remote: string | null;
  /** udp | tcp on the wire. */
  readonly protocol: string | null;
  /** For a relay pair, how the client reached the TURN server: udp | tcp | tls. */
  readonly relayProtocol: string | null;
}

export interface ConnectionAttempt {
  readonly peer: string;
  /**
   * Who started it. A writer only ever *accepts*, so recording only dials
   * would leave the writer's own tab — the one you would be watching — with
   * nothing to show.
   */
  readonly direction: 'dialled' | 'accepted';
  readonly startedAt: number;
  connectedAt: number | null;
  failedAt: number | null;
  error: string | null;
  /** Whether an ICE relay candidate was used, i.e. TURN was needed (§9). */
  usedRelay: boolean | null;
  /** Read from live ICE stats once connected; null until then. */
  pair: PairDetail | null;
  /** Every ICE state this link passed through, in order. */
  readonly iceStates: string[];
  /** Framed bytes over this link. Counted at the transport, not guessed. */
  bytesSent: number;
  bytesReceived: number;
}

export interface TransferRecord {
  readonly hash: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly direction: 'send' | 'receive';
  startedAt: number;
  finishedAt: number | null;
  /** Backpressure pauses on send; whole-blob retries on receive (§10.4). */
  pauses: number;
  retries: number;
  ok: boolean | null;
}

/**
 * A signalling-layer event: registering with the broker, or failing to.
 *
 * Worth recording separately from connections because a signalling failure
 * produces *no* connection attempt at all — so without this, "cannot reach the
 * broker" and "nothing has happened yet" look identical, which is precisely
 * the confusion a debug view exists to remove.
 */
export interface SignalEvent {
  readonly at: number;
  readonly kind: 'registered' | 'error' | 'disconnected';
  readonly detail: string;
}

/** Bounded: this is a debug trail, not a log to be kept. */
const MAX_SIGNAL_EVENTS = 200;

export class Metrics {
  readonly connections: ConnectionAttempt[] = [];
  readonly transfers: TransferRecord[] = [];
  readonly signalling: SignalEvent[] = [];

  note(kind: SignalEvent['kind'], detail: string): void {
    this.signalling.push({ at: Date.now(), kind, detail });
    if (this.signalling.length > MAX_SIGNAL_EVENTS) this.signalling.shift();
  }

  beginConnection(peer: string, direction: 'dialled' | 'accepted' = 'dialled'): ConnectionAttempt {
    const a: ConnectionAttempt = {
      peer,
      direction,
      startedAt: Date.now(),
      connectedAt: null,
      failedAt: null,
      error: null,
      usedRelay: null,
      pair: null,
      iceStates: [],
      bytesSent: 0,
      bytesReceived: 0,
    };
    this.connections.push(a);
    return a;
  }

  /** The most recent attempt for a peer, so late-arriving detail can attach. */
  latestFor(peer: string): ConnectionAttempt | undefined {
    for (let i = this.connections.length - 1; i >= 0; i--) {
      if (this.connections[i]!.peer === peer) return this.connections[i];
    }
    return undefined;
  }

  beginTransfer(
    hash: string,
    bytes: number,
    chunks: number,
    direction: 'send' | 'receive',
  ): TransferRecord {
    const t: TransferRecord = {
      hash,
      bytes,
      chunks,
      direction,
      startedAt: Date.now(),
      finishedAt: null,
      pauses: 0,
      retries: 0,
      ok: null,
    };
    this.transfers.push(t);
    return t;
  }

  /** The summary worth pasting into a results document. */
  summary(): {
    attempts: number;
    connected: number;
    failed: number;
    failureRate: number | null;
    relayed: number;
    direct: number;
    medianConnectMs: number | null;
    transfers: number;
    bytesMoved: number;
    retries: number;
    pauses: number;
  } {
    const done = this.connections.filter((c) => c.connectedAt !== null || c.failedAt !== null);
    const connected = this.connections.filter((c) => c.connectedAt !== null);
    const times = connected
      .map((c) => c.connectedAt! - c.startedAt)
      .sort((a, b) => a - b);

    return {
      attempts: this.connections.length,
      connected: connected.length,
      failed: this.connections.filter((c) => c.failedAt !== null).length,
      failureRate:
        done.length === 0 ? null : (done.length - connected.length) / done.length,
      relayed: connected.filter((c) => c.usedRelay === true).length,
      direct: connected.filter((c) => c.usedRelay === false).length,
      medianConnectMs: times.length === 0 ? null : times[Math.floor(times.length / 2)]!,
      transfers: this.transfers.filter((t) => t.ok === true).length,
      bytesMoved: this.transfers.filter((t) => t.ok === true).reduce((n, t) => n + t.bytes, 0),
      retries: this.transfers.reduce((n, t) => n + t.retries, 0),
      pauses: this.transfers.reduce((n, t) => n + t.pauses, 0),
    };
  }

  toJSON(): string {
    return JSON.stringify(
      {
        summary: this.summary(),
        signalling: this.signalling,
        connections: this.connections,
        transfers: this.transfers,
      },
      null,
      2,
    );
  }
}

/** One instance for the session; the harness reads it (§11.4). */
export const metrics = new Metrics();
