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

/** Are all of this event's deps (transitively) present? */
function resolvable(e, byId) {
  const stack = [...e.deps];
  const seen = new Set();
  while (stack.length > 0) {
    const id = stack.pop();
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
