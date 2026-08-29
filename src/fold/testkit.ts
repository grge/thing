/**
 * Test helpers: building event sequences without hand-writing envelopes.
 * Not part of the shipped fold.
 */
import type { AttrName, Event, Hash, Kind, Pos, Uuid, Value, WriterId } from './types.js';
import { CONTENT_HASH_LEN, UUID_LEN, WRITER_LEN } from './types.js';

/** Deterministic 16-byte id from a short label, so tests read legibly. */
function idFrom(label: string, len: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < label.length && i < len; i++) b[i] = label.charCodeAt(i);
  return b;
}

export const uuid = (label: string): Uuid => idFrom(label, UUID_LEN);
export const writer = (label: string): WriterId => idFrom(label, WRITER_LEN);
export const contentHash = (label: string): Hash => idFrom(label, CONTENT_HASH_LEN);

/**
 * A writer that stamps its own seq/prev/lamport. `prev` is a stand-in here —
 * stage 1 does not verify chains, that is §3.3 in stage 5 — but seq is real so
 * per-writer ordering is representable.
 */
export class TestWriter {
  private seq = 0;
  private lamport = 0;

  constructor(readonly id: WriterId) {}

  /** Mirrors §2.2: counter = max(counter, incoming) on receive. */
  observe(lamport: number): void {
    this.lamport = Math.max(this.lamport, lamport);
  }

  private next(target: Uuid, attr: AttrName, value: Value, at?: number): Event {
    if (at !== undefined) this.lamport = at - 1;
    this.lamport += 1;
    const e: Event = {
      writer: this.id,
      seq: this.seq,
      prev: null,
      lamport: this.lamport,
      target,
      attr,
      value,
      wall: 0,
    };
    this.seq += 1;
    return e;
  }

  parent(target: Uuid, p: Uuid, at?: number): Event {
    return this.next(target, ':parent', { t: 'uuid', v: p }, at);
  }
  name(target: Uuid, n: string, at?: number): Event {
    return this.next(target, ':name', { t: 'string', v: n }, at);
  }
  content(target: Uuid, h: Hash | null, at?: number): Event {
    return this.next(target, ':content', h === null ? { t: 'null' } : { t: 'hash', v: h }, at);
  }
  pos(target: Uuid, p: Pos, at?: number): Event {
    return this.next(target, ':pos', { t: 'pos', v: p }, at);
  }
  deleted(target: Uuid, v: boolean, at?: number): Event {
    return this.next(target, ':deleted', { t: 'bool', v }, at);
  }
  kind(target: Uuid, k: Kind, at?: number): Event {
    return this.next(target, ':kind', { t: 'kind', v: k }, at);
  }
}
