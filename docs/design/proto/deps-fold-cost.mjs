/**
 * Carrying forward the *set of maximal roots*, not a single winner.
 *
 * A single winner is wrong: two roots can be genuinely concurrent, and which
 * one wins is a tiebreak that must be applied to the whole maximal set at once.
 * The set is small — bounded by concurrent roots, not by log length.
 */
function rng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}
function buildLog(n, writers, sync, rootRate=0.02) {
  const rand=rng(1); const events=[]; const heads=new Map();
  for(let w=0;w<writers;w++) heads.set(w,[]);
  const global=[];
  for(let i=0;i<n;i++){
    const w=i%writers; const mine=heads.get(w);
    for(const g of global) if(!mine.includes(g)&&rand()<sync) mine.push(g);
    const deps=[...mine]; const isRoot=rand()<rootRate;
    events.push({id:i,root:isRoot,deps});
    heads.set(w,[i]);
    for(const d of deps){const j=global.indexOf(d); if(j>=0) global.splice(j,1);}
    global.push(i);
  }
  return events;
}

function maximalRoots(events) {
  // maximal[i] = the set of root ids that are maximal in event i's past.
  const maximal = new Array(events.length);
  let widest = 0, totalWork = 0;
  for (const e of events) {
    let set = null;
    for (const d of e.deps) {
      const inherited = maximal[d];
      if (inherited === undefined) continue;
      if (set === null) set = new Set(inherited);
      else for (const r of inherited) set.add(r);
      totalWork += inherited.size;
    }
    if (set === null) set = new Set();
    if (e.root) {
      // This root dominates everything it saw, so the set collapses to itself.
      set = new Set([e.id]);
    }
    // Free the deps' sets once consumed: they are only needed by their
    // successors, and a head that has been written past will not be read again.
    for (const d of e.deps) maximal[d] = undefined;
    maximal[e.id] = set;
    if (set.size > widest) widest = set.size;
  }
  return { maximal, widest, totalWork };
}

console.log('carrying the maximal-root set forward\n');
console.log('   events  writers  sync  rootRate    time   widest set   per event');
for (const [n,w,sync,rr] of [
  [10000,3,1.0,0.02],[100000,3,1.0,0.02],[500000,3,1.0,0.02],
  [100000,10,0.3,0.02],[100000,10,0.3,0.20],[100000,50,0.1,0.20]]) {
  const log=buildLog(n,w,sync,rr);
  const t0=Date.now(); const r=maximalRoots(log); const t1=Date.now();
  console.log(`${String(n).padStart(9)} ${String(w).padStart(8)} ${String(sync).padStart(5)} ${String(rr).padStart(9)}  ${String(t1-t0).padStart(5)}ms ${String(r.widest).padStart(12)}   ${((t1-t0)*1000/n).toFixed(2)}us`);
}
