/**
 * Prototype: deciding "was this writer admitted, per what its author saw?"
 *
 * Standalone — no engine imports — so the shape can be tried before the
 * envelope changes. Events are plain objects; hashes are strings.
 */

/** An event: id, writer, target, attr, value, and the heads its author saw. */
function ev(id, writer, target, attr, value, deps = []) {
  return { id, writer, target, attr, value, deps };
}

/**
 * Everything causally at-or-before a set of heads.
 *
 * This is the whole mechanism: an event's `deps` name real events by hash, so
 * its causal past is fixed at signing time and cannot be extended later.
 */
function pastOf(heads, byId) {
  const seen = new Set();
  const stack = [...heads];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    const e = byId.get(id);
    if (e === undefined) continue; // dep not yet held — see `resolvable`
    seen.add(id);
    for (const d of e.deps) stack.push(d);
  }
  return seen;
}

/**
 * Are all of this event's deps present, and is its past actually a past?
 *
 * The second half is not theoretical hygiene. A cycle cannot be *constructed*
 * with content-addressed hashes — naming a hash requires the event to exist —
 * but a peer can send arbitrary bytes, and an event that appears in its own
 * causal past would otherwise be judged against a writer set that depends on
 * itself. Rejected rather than accepted, which is the same posture as every
 * other malformed input (§2.3).
 */
function resolvable(e, byId) {
  const stack = [...e.deps];
  const seen = new Set();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === e.id) return false; // an event cannot precede itself
    if (seen.has(id)) continue;
    seen.add(id);
    const d = byId.get(id);
    if (d === undefined) return false;
    for (const x of d.deps) stack.push(x);
  }
  return true;
}

/**
 * The writer set as of a causal past: fold only the root events in it.
 *
 * `:writers` is a register, so the winner is the highest-ordered root event in
 * that past. Ordering by id here stands in for `(lamport, writer, id)`.
 */
function writersAsOf(past, byId, spaceKey) {
  const roots = [...past]
    .map((id) => byId.get(id))
    .filter((e) => e !== undefined && e.target === 'ROOT' && e.attr === ':writers' && e.writer === spaceKey);
  if (roots.length === 0) return null; // nothing declared: admits everyone

  // **Causal order first, id only as a tiebreak.** Sorting by id alone is
  // wrong and was the prototype's first bug: a root event that *descends from*
  // another must win over it regardless of how their ids compare. Only
  // genuinely concurrent roots need an arbitrary winner, and that is where the
  // register's known cost (§7.4) lives.
  const dominated = new Set();
  for (const a of roots) {
    const past_a = pastOf(a.deps, byId);
    for (const b of roots) if (past_a.has(b.id)) dominated.add(b.id);
  }
  const latest = roots.filter((e) => !dominated.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));

  const set = new Set(latest[latest.length - 1].value.split(',').filter(Boolean));
  set.add(spaceKey);
  return set;
}

/** Was this event's writer admitted, per what its author had seen? */
function admitted(e, byId, spaceKey) {
  if (e.target === 'ROOT') return e.writer === spaceKey; // §7.2.1, unchanged
  const set = writersAsOf(pastOf(e.deps, byId), byId, spaceKey);
  return set === null || set.has(e.writer);
}

/** Fold: which non-root events count. Order-independent by construction. */
function foldAdmitted(events, spaceKey) {
  const byId = new Map(events.map((e) => [e.id, e]));
  return events
    .filter((e) => e.target !== 'ROOT')
    .filter((e) => resolvable(e, byId) && admitted(e, byId, spaceKey))
    .map((e) => e.value)
    .sort();
}

/* ── the scenario that is broken today ──────────────────────────────────── */

const SPACE = 'space';
const ALICE = 'alice';

// r1: space adds alice.  a1: alice writes, having seen r1.  r2: space removes alice.
const r1 = ev('r1', SPACE, 'ROOT', ':writers', 'alice', []);
const a1 = ev('a1', ALICE, 'obj', ':name', 'before-removal', ['r1']);
const r2 = ev('r2', SPACE, 'ROOT', ':writers', '', ['a1']);
// a2: alice writes again, having seen the removal. Must not fold.
const a2 = ev('a2', ALICE, 'obj2', ':name', 'after-removal', ['r2']);

const log = [r1, a1, r2, a2];

function shuffled(xs, seed) {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

console.log('scenario: alice added, writes, is removed, writes again');
const results = new Set();
for (let seed = 0; seed < 50; seed++) {
  results.add(JSON.stringify(foldAdmitted(shuffled(log, seed), SPACE)));
}
console.log('  distinct results over 50 orderings:', results.size);
console.log('  result:', [...results][0]);

/* ── backdating ─────────────────────────────────────────────────────────── */

// Alice withholds a write, then releases it claiming only r1 as its past.
const evil = ev('evil', ALICE, 'obj3', ':name', 'backdated', ['r1']);
console.log('\nbackdating: alice claims a past that predates her removal');
console.log('  folds?', foldAdmitted([...log, evil], SPACE).includes('backdated'));

// The same event, but claiming a past it cannot produce hashes for.
const forged = ev('forged', ALICE, 'obj4', ':name', 'forged', ['nonexistent']);
console.log('  a past it cannot produce hashes for folds?',
  foldAdmitted([...log, forged], SPACE).includes('forged'));

/* ── harder cases ───────────────────────────────────────────────────────── */

console.log('\n--- concurrent add and write ---');
// Space adds alice (r1). Concurrently, alice writes having seen NOTHING.
// Her event's past has no writer set at all, so it folds under "not declared".
const c1 = ev('c1', ALICE, 'obj', ':name', 'concurrent-with-add', []);
console.log('  writes concurrent with the very first :writers fold?',
  foldAdmitted([r1, c1], SPACE).includes('concurrent-with-add'));

console.log('\n--- concurrent removal and write ---');
// Alice writes seeing r1 (she is admitted). Space removes her, concurrently.
const r2b = ev('r2b', SPACE, 'ROOT', ':writers', '', ['r1']);
const a1b = ev('a1b', ALICE, 'obj', ':name', 'concurrent-with-removal', ['r1']);
console.log('  folds?', foldAdmitted([r1, r2b, a1b], SPACE).includes('concurrent-with-removal'));
console.log('  (this is the offline/malicious ambiguity: identical either way)');

console.log('\n--- re-add after removal ---');
const r3 = ev('r3', SPACE, 'ROOT', ':writers', 'alice', ['r2']);
const a3 = ev('a3', ALICE, 'obj5', ':name', 'after-readd', ['r3']);
const withReadd = foldAdmitted([...log, r3, a3], SPACE);
console.log('  after-readd folds?', withReadd.includes('after-readd'));
console.log('  after-removal still excluded?', !withReadd.includes('after-removal'));

console.log('\n--- a dep that has not arrived yet ---');
const orphan = ev('orphan', ALICE, 'obj6', ':name', 'orphan', ['not-here-yet']);
const held = foldAdmitted([...log, orphan], SPACE);
console.log('  held rather than folded?', !held.includes('orphan'));
console.log('  ...and folds once its dep arrives?',
  foldAdmitted([...log, ev('not-here-yet', SPACE, 'ROOT', ':writers', 'alice', ['r2']), orphan], SPACE)
    .includes('orphan'));

console.log('\n--- two concurrent membership edits (the register cost) ---');
const bobAdd = ev('m1', SPACE, 'ROOT', ':writers', 'alice,bob', ['r1']);
const carolAdd = ev('m2', SPACE, 'ROOT', ':writers', 'alice,carol', ['r1']);
const bobWrite = ev('bw', 'bob', 'obj7', ':name', 'bob-wrote', ['m1']);
const carolWrite = ev('cw', 'carol', 'obj8', ':name', 'carol-wrote', ['m2']);
const both = foldAdmitted([r1, bobAdd, carolAdd, bobWrite, carolWrite], SPACE);
console.log('  bob folds?', both.includes('bob-wrote'), ' carol folds?', both.includes('carol-wrote'));
console.log('  (each was admitted in the past it saw — both survive)');

/* ── determinism, over everything ───────────────────────────────────────── */

console.log('\n--- determinism across all scenarios ---');
const scenarios = {
  'removal':        [r1, a1, r2, a2],
  're-add':         [r1, a1, r2, a2, r3, a3],
  'concurrent edit':[r1, bobAdd, carolAdd, bobWrite, carolWrite],
  'backdated':      [r1, a1, r2, a2, evil],
  'orphan dep':     [r1, a1, r2, a2, orphan],
};
let allDeterministic = true;
for (const [name, log_] of Object.entries(scenarios)) {
  const seen = new Set();
  for (let seed = 0; seed < 200; seed++) {
    seen.add(JSON.stringify(foldAdmitted(shuffled(log_, seed), SPACE)));
  }
  const ok = seen.size === 1;
  allDeterministic &&= ok;
  console.log(`  ${name.padEnd(16)} ${seen.size} distinct result(s) over 200 orderings  ${ok ? 'OK' : 'NOT DETERMINISTIC'}`);
}
console.log('\n  all deterministic:', allDeterministic);

/* ── the two deferrals, interacting ─────────────────────────────────────── */
//
// The fold has two reasons to hold an event back:
//   1. its deps have not arrived, so its permission cannot be decided;
//   2. its writer was not admitted in the past it saw.
// (2) is permanent — the answer never changes, because the past is fixed at
// signing. (1) is temporary. The question is whether they can tangle.

console.log('\n--- the two deferrals ---');

// A long chain of deps arriving in the worst possible order.
const chain = [r1];
let prevId = 'r1';
for (let i = 0; i < 6; i++) {
  const e = ev(`k${i}`, ALICE, `o${i}`, ':name', `link-${i}`, [prevId]);
  chain.push(e);
  prevId = e.id;
}
const reversed = [...chain].reverse();
console.log('  6-deep dep chain, delivered backwards:',
  foldAdmitted(reversed, SPACE).length, 'of 6 fold');

// Does one pass suffice, or does resolution need to cascade?
console.log('  ...and delivered in order:', foldAdmitted(chain, SPACE).length, 'of 6');

// An event whose deps arrive but whose writer is *still* not admitted.
const stranger = ev('s1', 'mallory', 'obj', ':name', 'stranger', ['r1']);
console.log('  unadmitted writer with resolved deps folds?',
  foldAdmitted([r1, stranger], SPACE).includes('stranger'));

// Permanently unresolvable: deps that will never arrive.
const never = ev('n1', ALICE, 'obj', ':name', 'never', ['ghost']);
console.log('  permanently-missing dep does not stall the rest?',
  foldAdmitted([r1, a1, r2, never], SPACE).includes('before-removal'));

// A cycle: two events each naming the other. Cannot happen with real hashes —
// you cannot name a hash that does not exist yet — but the fold must not hang.
const cy1 = ev('cy1', ALICE, 'obj', ':name', 'cycle-a', ['cy2']);
const cy2 = ev('cy2', ALICE, 'obj', ':name', 'cycle-b', ['cy1']);
const t0 = Date.now();
const cyc = foldAdmitted([r1, cy1, cy2], SPACE);
console.log('  a dep cycle terminates?', Date.now() - t0 < 1000, '- folds:', cyc.length);

// The interesting one: a writer admitted by a root event that itself depends
// on that writer's own earlier work. Order of resolution matters here.
const w1 = ev('w1', ALICE, 'objA', ':name', 'alice-early', ['r1']);
const r4 = ev('r4', SPACE, 'ROOT', ':writers', 'alice,bob', ['w1']);
const b1 = ev('b1', 'bob', 'objB', ':name', 'bob-after', ['r4']);
const tangled = [r1, w1, r4, b1];
const seenT = new Set();
for (let seed = 0; seed < 200; seed++) {
  seenT.add(JSON.stringify(foldAdmitted(shuffled(tangled, seed), SPACE)));
}
console.log('  root event depending on a writer\'s own event:',
  seenT.size, 'distinct result(s) —', [...seenT][0]);

/* ── generated histories, including removals ────────────────────────────── */
//
// The gap that let 8a through: the existing property tests generate
// multi-writer histories that *add* writers and never remove one.

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function generate(seed) {
  const rand = rng(seed);
  const events = [];
  const heads = [];
  let members = new Set();
  let n = 0;
  const people = ['alice', 'bob', 'carol'];

  const emit = (writer, target, attr, value) => {
    // Each writer sees a random subset of current heads — models partial sync.
    const deps = heads.filter(() => rand() < 0.7);
    const e = ev(`e${n++}`, writer, target, attr, value, deps);
    events.push(e);
    for (const d of e.deps) { const i = heads.indexOf(d); if (i >= 0) heads.splice(i, 1); }
    heads.push(e.id);
    return e;
  };

  for (let i = 0; i < 30; i++) {
    const r = rand();
    if (r < 0.25) {
      // membership change, by the space key
      const who = people[Math.floor(rand() * people.length)];
      if (members.has(who) && rand() < 0.6) members.delete(who); else members.add(who);
      emit(SPACE, 'ROOT', ':writers', [...members].sort().join(','));
    } else {
      const who = people[Math.floor(rand() * people.length)];
      emit(who, `obj${Math.floor(rand() * 5)}`, ':name', `v${i}`);
    }
  }
  return events;
}

console.log('\n--- generated histories with removals ---');
let worst = 0, nondet = 0, everRemoved = 0;
for (let seed = 1; seed <= 300; seed++) {
  const log_ = generate(seed);
  if (log_.some((e) => e.target === 'ROOT' && e.value.split(',').filter(Boolean).length <
      Math.max(...log_.filter(x => x.target === 'ROOT').map(x => x.value.split(',').filter(Boolean).length)))) {
    everRemoved++;
  }
  const seen = new Set();
  for (let s = 0; s < 12; s++) seen.add(JSON.stringify(foldAdmitted(shuffled(log_, s), SPACE)));
  if (seen.size !== 1) nondet++;
  worst = Math.max(worst, Math.max(...log_.map((e) => e.deps.length)));
}
console.log(`  300 histories x 12 orderings each`);
console.log(`  histories containing a removal: ${everRemoved}`);
console.log(`  non-deterministic: ${nondet}`);
console.log(`  widest deps seen: ${worst}`);

/* ── does the generator catch today's bug? ──────────────────────────────── */
//
// A generator that cannot detect the bug it was written for proves nothing.
// This is today's rule — filter by the FINAL writer set — over the same logs.

function foldFinalSet(events, spaceKey) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const roots = events.filter((e) => e.target === 'ROOT' && e.writer === spaceKey);
  const dominated = new Set();
  for (const a of roots) {
    const pa = pastOf(a.deps, byId);
    for (const b of roots) if (pa.has(b.id)) dominated.add(b.id);
  }
  const latest = roots.filter((e) => !dominated.has(e.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const set = latest.length === 0 ? null
    : new Set([...latest[latest.length - 1].value.split(',').filter(Boolean), spaceKey]);
  return events
    .filter((e) => e.target !== 'ROOT')
    .filter((e) => set === null || set.has(e.writer))
    .map((e) => e.value).sort();
}

console.log('\n--- does the generator catch the bug it was written for? ---');
let differs = 0, lost = 0;
for (let seed = 1; seed <= 300; seed++) {
  const log_ = generate(seed);
  const withDeps = foldAdmitted(log_, SPACE);
  const finalSet = foldFinalSet(log_, SPACE);
  if (JSON.stringify(withDeps) !== JSON.stringify(finalSet)) {
    differs++;
    lost += withDeps.filter((v) => !finalSet.includes(v)).length;
  }
}
console.log(`  histories where the two rules disagree: ${differs} of 300`);
console.log(`  events today's rule drops that were validly written: ${lost}`);
