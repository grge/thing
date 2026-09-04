/**
 * Stage 5: two logs converging through the sync protocol (§3.4).
 *
 * No network — two PendingBuffers and the diffing functions, driven directly.
 * This is the first test with a genuine *second writer*, which is the half of
 * POC question 2 that single-writer stages could not reach.
 */
import { describe, expect, it } from 'vitest';
import { eventsSince, PendingBuffer, versionVector } from './sync.js';
import { fold, hex, ROOT, type Event } from '../fold/index.js';
import { TestWriter, contentHash, uuid, writer } from '../fold/testkit.js';

/** A peer holding a log, syncing through the protocol's own functions. */
class Node {
  events: Event[] = [];
  private buf = new PendingBuffer();

  constructor(readonly w: TestWriter) {}

  write(fn: (w: TestWriter) => Event): Event {
    const e = fn(this.w);
    this.events.push(e);
    this.buf.offer(e);
    return e;
  }

  vv() {
    return versionVector(this.events);
  }

  /** What this node would send in response to `theirs` (§3.4). */
  diffFor(theirs: ReturnType<typeof versionVector>): Event[] {
    return eventsSince(this.events, theirs);
  }

  receive(incoming: readonly Event[]): number {
    let applied = 0;
    for (const e of incoming) {
      for (const ok of this.buf.offer(e)) {
        this.events.push(ok);
        this.w.observe(ok.lamport);
        applied += 1;
      }
    }
    return applied;
  }

  get state() {
    return fold(this.events);
  }
}

/** One full handshake in both directions (§3.4). */
function sync(a: Node, b: Node): void {
  const aVv = a.vv();
  const bVv = b.vv();
  b.receive(a.diffFor(bVv));
  a.receive(b.diffFor(aVv));
}

const names = (s: ReturnType<typeof fold>) =>
  [...s.objects.values()]
    .filter((o) => hex(o.uuid) !== hex(ROOT) && !o.deleted)
    .map((o) => o.name)
    .sort();

describe('two peers converging (§3.4)', () => {
  it('a fresh join receives the whole log', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const f = uuid('f');
    a.write((w) => w.kind(f, 'file'));
    a.write((w) => w.name(f, 'notes.txt'));
    a.write((w) => w.parent(f, ROOT));

    sync(a, b);
    expect(names(b.state)).toEqual(['notes.txt']);
  });

  it('both directions happen in one exchange', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const x = uuid('x');
    const y = uuid('y');
    a.write((w) => w.name(x, 'from-alice'));
    a.write((w) => w.parent(x, ROOT));
    b.write((w) => w.name(y, 'from-bob'));
    b.write((w) => w.parent(y, ROOT));

    sync(a, b);
    expect(names(a.state)).toEqual(['from-alice', 'from-bob']);
    expect(names(b.state)).toEqual(['from-alice', 'from-bob']);
  });

  it('converges to identical state — the property that matters (§1.3)', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const shared = uuid('shared');

    a.write((w) => w.kind(shared, 'file'));
    a.write((w) => w.name(shared, 'a-name'));
    a.write((w) => w.parent(shared, ROOT));
    sync(a, b);

    // Concurrent writes to *different* attributes do not conflict (§1.1).
    a.write((w) => w.content(shared, contentHash('from-a')));
    b.write((w) => w.name(shared, 'b-name'));
    sync(a, b);

    const sa = a.state.objects.get(hex(shared))!;
    const sb = b.state.objects.get(hex(shared))!;
    expect(sa.name).toBe(sb.name);
    expect(hex(sa.content!)).toBe(hex(sb.content!));
    // Neither write was lost: they touched different attributes.
    expect(sa.name).toBe('b-name');
    expect(sa.content).not.toBeNull();
  });

  it('a second sync sends nothing when both are current', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    a.write((w) => w.name(uuid('f'), 'x'));
    sync(a, b);
    expect(b.diffFor(a.vv())).toEqual([]);
    expect(a.diffFor(b.vv())).toEqual([]);
  });

  it('lamport clocks advance across peers, so later really means later (§2.2)', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const t = uuid('t');

    for (let i = 0; i < 5; i++) a.write((w) => w.name(t, `a${i}`));
    sync(a, b);

    // Bob has seen alice's events, so his next write must outrank them.
    const bobsWrite = b.write((w) => w.name(t, 'bob-wins'));
    const alicesHighest = Math.max(...a.events.map((e) => e.lamport));
    expect(bobsWrite.lamport).toBeGreaterThan(alicesHighest);

    sync(a, b);
    expect(a.state.objects.get(hex(t))!.name).toBe('bob-wins');
  });

  it('delete racing a write: undelete-wins, identically on both peers (§4.5)', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const f = uuid('f');
    a.write((w) => w.name(f, 'contested'));
    a.write((w) => w.parent(f, ROOT));
    sync(a, b);

    // Concurrent: alice deletes while bob writes content.
    a.write((w) => w.deleted(f, true));
    b.write((w) => w.content(f, contentHash('bobs-work')));
    sync(a, b);

    const sa = a.state.objects.get(hex(f))!;
    const sb = b.state.objects.get(hex(f))!;
    expect(sa.deleted).toBe(sb.deleted);
    // Bob's write is later in information flow, so the object survives — an
    // apparent data loss would be worse than a resurrected file (§4.5).
    expect(sa.deleted).toBe(false);
  });

  it('concurrent moves that would cycle resolve identically on both peers (§4.1)', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const x = uuid('aaa');
    const y = uuid('bbb');
    a.write((w) => w.kind(x, 'dir'));
    a.write((w) => w.name(x, 'X'));
    a.write((w) => w.kind(y, 'dir'));
    a.write((w) => w.name(y, 'Y'));
    sync(a, b);

    // The §4.1 scenario exactly: A into B while B into A.
    a.write((w) => w.parent(x, y));
    b.write((w) => w.parent(y, x));
    sync(a, b);

    const sa = a.state.objects.get(hex(x))!;
    const sb = b.state.objects.get(hex(x))!;
    expect(sa.cycleBroken).toBe(sb.cycleBroken);
    expect(hex(sa.parent)).toBe(hex(sb.parent));
    expect(sa.cycleBroken).toBe(true);
  });

  it('an out-of-order delivery still converges, via the buffer (§3.3)', () => {
    const a = new Node(new TestWriter(writer('alice')));
    const b = new Node(new TestWriter(writer('bob')));
    const f = uuid('f');
    a.write((w) => w.kind(f, 'file'));
    a.write((w) => w.name(f, 'one'));
    a.write((w) => w.name(f, 'two'));
    a.write((w) => w.name(f, 'three'));

    // Deliver reversed: everything buffers until seq 0 lands.
    const diff = a.diffFor(b.vv());
    b.receive([...diff].reverse());
    expect(names(b.state)).toEqual(['three']);
  });

  it('three peers converge through a star, without direct contact', () => {
    // Readers connect only to the writer (§3.4 topology), so this is the shape
    // mode 2 actually has.
    const hub = new Node(new TestWriter(writer('hub')));
    const r1 = new Node(new TestWriter(writer('reader1')));
    const r2 = new Node(new TestWriter(writer('reader2')));

    const f = uuid('f');
    hub.write((w) => w.kind(f, 'file'));
    hub.write((w) => w.name(f, 'shared.txt'));
    hub.write((w) => w.parent(f, ROOT));

    sync(hub, r1);
    sync(hub, r2);
    expect(names(r1.state)).toEqual(['shared.txt']);
    expect(names(r2.state)).toEqual(['shared.txt']);

    // A later edit reaches both, again only through the hub.
    hub.write((w) => w.name(f, 'renamed.txt'));
    sync(hub, r1);
    sync(hub, r2);
    expect(names(r1.state)).toEqual(['renamed.txt']);
    expect(names(r2.state)).toEqual(['renamed.txt']);
  });
});
