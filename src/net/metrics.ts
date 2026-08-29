/**
 * Instrumentation for POC question 1.
 *
 * The plan says to instrument from the first commit, because these numbers are
 * the deliverable rather than a side effect: connection failure rate without
 * TURN, time-to-connect, stall frequency, whole-blob retry frequency.
 *
 * Kept in memory and dumped as JSON; nothing here needs to survive a reload.
 */

export interface ConnectionAttempt {
  readonly peer: string;
  readonly startedAt: number;
  connectedAt: number | null;
  failedAt: number | null;
  error: string | null;
  /** Whether an ICE relay candidate was used, i.e. TURN was needed (§9). */
  usedRelay: boolean | null;
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

export class Metrics {
  readonly connections: ConnectionAttempt[] = [];
  readonly transfers: TransferRecord[] = [];

  beginConnection(peer: string): ConnectionAttempt {
    const a: ConnectionAttempt = {
      peer,
      startedAt: Date.now(),
      connectedAt: null,
      failedAt: null,
      error: null,
      usedRelay: null,
    };
    this.connections.push(a);
    return a;
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
      medianConnectMs: times.length === 0 ? null : times[Math.floor(times.length / 2)]!,
      transfers: this.transfers.filter((t) => t.ok === true).length,
      bytesMoved: this.transfers.filter((t) => t.ok === true).reduce((n, t) => n + t.bytes, 0),
      retries: this.transfers.reduce((n, t) => n + t.retries, 0),
      pauses: this.transfers.reduce((n, t) => n + t.pauses, 0),
    };
  }

  toJSON(): string {
    return JSON.stringify(
      { summary: this.summary(), connections: this.connections, transfers: this.transfers },
      null,
      2,
    );
  }
}

/** One instance for the session; the harness reads it (§11.4). */
export const metrics = new Metrics();
