/**
 * A minimal event producer, so tests read as intentions rather than as literals.
 *
 * Mirrors §2.2: `seq` is per-writer and strictly incrementing; `lamport`
 * increments on write and rises to `max(own, incoming)` on receipt. Nothing
 * here is under test — it exists so the fold has well-formed input.
 */
import { elementIdOf, type ElementId, type Event, type Uuid } from './types.js';

export class Writer {
  private seq = 0;
  private lamport = 0;
  readonly events: Event[] = [];

  constructor(readonly id: string) {}

  /** Raise the clock on receiving someone else's events (§2.2). */
  observe(events: readonly Event[]): void {
    for (const e of events) this.lamport = Math.max(this.lamport, e.lamport);
  }

  private emit(target: Uuid, attr: string, value: unknown): Event {
    this.lamport += 1;
    const e: Event = {
      writer: this.id,
      seq: this.seq,
      lamport: this.lamport,
      target,
      attr,
      value,
    };
    this.seq += 1;
    this.events.push(e);
    return e;
  }

  /** Set an attribute. Always a register slice (§3.2). */
  set(target: Uuid, attr: string, value: unknown): Event {
    return this.emit(target, attr, value);
  }

  /** Write a blob body: a hash the bytes are fetched by (§2.4). */
  setBlob(target: Uuid, hash: string): Event {
    return this.emit(target, ':body', hash);
  }

  /**
   * Insert into a sequence slice. Returns the element id, which is
   * `(writer, seq)` — derived from the envelope, never minted (§3.8).
   */
  insert(target: Uuid, after: ElementId | null, body: unknown): ElementId {
    const e = this.emit(target, ':body', { op: 'ins', after, body });
    return elementIdOf(e);
  }

  /** Tombstone a sequence element. It keeps its position (§3.8). */
  remove(target: Uuid, id: ElementId): Event {
    return this.emit(target, ':body', { op: 'del', target: id });
  }
}

/** Every event from every writer, as an unordered set (§1.1). */
export function logOf(...writers: Writer[]): Event[] {
  return writers.flatMap((w) => w.events);
}

/** Read a sequence slice back as a string, skipping tombstones. */
export function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((el) => !(el as { deleted: boolean }).deleted)
    .map((el) => (el as { body: unknown }).body)
    .join('');
}
