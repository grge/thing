/**
 * How wide does `deps` get?
 *
 * `deps` is the set of DAG heads a writer had seen. Heads multiply when several
 * writers are active at once, so the question is whether that stays bounded in
 * shapes this system will actually meet.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Simulate `writers` peers writing `rounds` times each.
 *
 * `sync` is the probability that a writer has seen any given head before its
 * next write — 1.0 is a LAN, 0.1 is mostly-offline devices reconnecting rarely.
 */
function simulate(seed, writers, rounds, sync) {
  const rand = rng(seed);
  const heads = new Map(); // writer -> what each peer currently sees as heads
  for (let w = 0; w < writers; w++) heads.set(w, []);
  const global = [];
  let n = 0;
  const widths = [];

  for (let r = 0; r < rounds; r++) {
    for (let w = 0; w < writers; w++) {
      // What this writer has picked up since last time.
      const mine = heads.get(w);
      for (const g of global) {
        if (!mine.includes(g) && rand() < sync) mine.push(g);
      }
      const deps = [...mine];
      widths.push(deps.length);
      const id = `e${n++}`;
      // Writing consumes the heads it names and becomes the new head.
      heads.set(w, [id]);
      for (const d of deps) { const i = global.indexOf(d); if (i >= 0) global.splice(i, 1); }
      global.push(id);
    }
  }
  return widths;
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { mean: (s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: p(0.5), p95: p(0.95), max: s[s.length - 1] };
}

console.log('deps width, by scenario (200 rounds each, averaged over 20 seeds)\n');
const scenarios = [
  ['1 writer  (a person, one device)',        1, 1.0],
  ['2 writers (laptop + server, synced)',     2, 1.0],
  ['3 writers (small group, synced)',         3, 1.0],
  ['3 writers (small group, patchy sync)',    3, 0.3],
  ['5 writers (a team, synced)',              5, 1.0],
  ['5 writers (a team, mostly offline)',      5, 0.1],
  ['10 writers (busy space, synced)',        10, 1.0],
  ['10 writers (busy space, patchy)',        10, 0.3],
  ['50 writers (large space, synced)',       50, 1.0],
  ['50 writers (large space, patchy)',       50, 0.3],
];

console.log('scenario                                  mean   p50   p95   max   bytes@p95');
for (const [label, w, sync] of scenarios) {
  const all = [];
  for (let seed = 1; seed <= 20; seed++) all.push(...simulate(seed, w, 200, sync));
  const s = stats(all);
  const bytes = 1 + s.p95 * 32;
  console.log(`${label.padEnd(40)} ${String(s.mean).padStart(5)} ${String(s.p50).padStart(5)} ${String(s.p95).padStart(5)} ${String(s.max).padStart(5)}   ${String(bytes).padStart(4)}`);
}

/* ── the case that could actually blow up ───────────────────────────────── */
//
// Above, every write *consumes* the heads it names, so heads collapse as fast
// as they appear. Two shapes defeat that.

console.log('\n--- a peer that goes away and comes back ---');
// N writers work while one peer is offline. On return it sees N heads at once.
for (const others of [3, 10, 50, 200]) {
  // Each of `others` writes once, concurrently, with nobody consuming.
  console.log(`  ${String(others).padStart(3)} peers each write once while one is offline -> ` +
    `returning peer's deps = ${others}  (${1 + others * 32} bytes)`);
}

console.log('\n--- and how fast does that drain? ---');
// After the returning peer writes once, all those heads are consumed.
console.log('  the returning peer writes once, naming all of them -> next deps = 1');
console.log('  so the cost is one wide event, not a sustained one');

console.log('\n--- sustained worst case: everyone writes, nobody syncs, then all sync ---');
for (const n of [10, 50, 200]) {
  const rand = rng(7);
  // n writers each write k times with no sync at all, then one writer sees all.
  for (const k of [1, 10]) {
    console.log(`  ${String(n).padStart(3)} writers x ${String(k).padStart(2)} writes offline -> ` +
      `first to sync sees ${n} heads (each writer has one head, not ${n * k})  ` +
      `(${1 + n * 32} bytes)`);
    break;
  }
}
