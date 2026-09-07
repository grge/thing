# `deps`: deciding what was allowed when it was written

**Status: built** (PLAN.md stage 7.8). The prototypes under `proto/` are kept
because they are how the design was checked before the envelope moved, and two
of the three bugs found in this work were found there.

It answers OPEN.md question 8a: the full fold and the incremental fold disagree
about a writer who was removed, and neither is right.

---

## The problem, in one paragraph

A space's writer set lives in the log it governs. To fold an event the fold must
ask "was this writer allowed?" — but *allowed* changed over time, and the fold
only checks once. The full fold checks against the **final** set, so removing a
writer unwrites everything they ever wrote (violating §7.2.3's *valid when
written*). The incremental fold keeps whatever it had already applied, so the
answer depends on **arrival order** (violating §3.6's determinism). Two peers,
one log, different state.

## The proposal

One new field on the envelope:

```
writer   who signed this            unchanged
point    which chain                unchanged
seq      position in that chain     unchanged
prev     this chain's previous      unchanged
deps     heads seen when signing    NEW — hashes of events, ~1 typical
lamport  logical clock              unchanged, demoted to a tiebreak
```

`deps` is the set of DAG heads its author had actually seen, excluding anything
reachable through them. `prev` is `deps` restricted to the author's own chain;
keeping both is mild redundancy that lets version vectors, gap detection and
`seq` keep working exactly as they do today. **This is additive** — nothing that
works now stops working.

The permission check becomes:

> Was this writer admitted **in the state this event's author had seen**?

which is a property of the event, computable identically on every peer,
independent of arrival order.

## What the prototype establishes

Five scenarios, 200 shuffled orderings each:

| scenario | result |
| --- | --- |
| add → write → remove → write | one result over 200 orderings; the pre-removal write survives, the post-removal one does not |
| removal then re-add | later writes fold, the removed-window write stays excluded |
| two concurrent membership edits | **both writers' events fold** — each was admitted in the past it saw |
| a dep that has not arrived | held, then folds when the dep arrives |
| backdated event | **folds** — see limitations |

All five are deterministic. §3.6 is restored and §7.2.3 becomes computable.

The concurrent-edit row is worth noting: it is *better* than today. The
membership **list** still loses one of two concurrent edits (the register's known
cost, §7.4), but the **writes** made under each edit all survive, because
admission is judged against what each author saw rather than against a merged
list.

### The bug the prototype found

The first version sorted competing root events by id. Wrong: a root event that
*descends from* another must win over it regardless of how their ids compare.
Sorting by id alone made a newly-added writer's events fail to fold. Causal
order first, id only as a tiebreak between genuinely concurrent roots — which is
exactly where §7.4's register cost lives, and nowhere else.

This is the kind of thing the prototype was for.

## What it does not address

**Backdating still works.** Alice, about to be removed, signs an event naming
only pre-removal heads and releases it later. It folds. This is demonstrated in
the prototype rather than argued.

`deps` narrows the attack from *claim any position in history* to *claim a real
position you can produce hashes for*, which is a large reduction and not a
closure. The literature is explicit that this is not closable by causality
alone — from *Decoupling Trust in Byzantine CRDTs*:

> Neither timestamps nor causal ordering alone allow replicas to reliably
> distinguish past and future behavior.

The reason is that a backdated event is **indistinguishable from an honest
offline one**. Someone genuinely disconnected for a week produces exactly the
same shape. The known fix — expanding a revocation's scope to cover *concurrent*
events (*Towards System-Oriented Formal Verification of Local-First Access
Control*) — introduces non-monotonic logic, where peers temporarily disagree
about authorisation and converge later. That sits badly with §3.6 and is a
policy that can be layered on `deps` if it is ever wanted.

**It does not solve equivocation** (OPEN.md 10). One writer can still sign two
different events at one `(writer, point, seq)`. §7.3's resolution still applies.

**It does not give attribution** (`../working/LEARNINGS.md` §1). Still no notion of a person.

**`deps` is unbounded under heavy concurrency.** It is the set of current heads,
and heads multiply with simultaneous writers. For this system's expected shape —
a person, their devices, a few collaborators — heads stay at one to three. For a
busy shared space it needs a bound, and there is not one.

## What it costs

Measured against a real log (206 bytes/event on disk, 435 on the wire):

| | on disk | on the wire |
| --- | --- | --- |
| today | 206 B | 435 B |
| +1 dep (typical: extending your own last write) | 239 B (+16%) | 508 B (+17%) |
| +2 deps | 271 B (+32%) | 575 B (+32%) |

A file created today costs ~824 bytes of log across 4 events; with one dep,
~956. A 32-byte hash alongside a 64-byte signature and a 32-byte `prev` is not
where this design gets expensive.

For context, the wire format already costs **2.1x** what the same event takes on
disk, because every binary field is hex inside JSON. Fixing that would save more
than `deps` adds — see `../working/LEARNINGS.md` §3a. Not proposed here.

## Why not the alternatives

**A Lamport derived from the hash chain.** Any scalar summary of a partial order
discards *which* events an author had seen, and that set is the entire security
property. A derived number is still a number its author chooses — the same
attack with more machinery.

**Replacing `seq` with a full hash DAG** (Kleppmann's construction,
`EQUIVOCATION.md`). The ambitious option. It takes version vectors with it: the
cheap "0–47 contiguous" statement becomes Bloom filters plus heads, plus a
garbage-collection problem neither paper solves. That trades the strongest part
of this design for a fix to a weaker one, unmeasured.

**Expanding revocation to concurrent events as the primary fix.** The formally
verified answer, and it brings non-monotonic logic. Available as a policy on top
of `deps` if the adversarial case ever needs closing.

## The two deferrals, checked

The fold has two reasons to hold an event back, and the worry was that they
tangle:

1. **its deps have not arrived**, so its permission cannot be decided — temporary;
2. **its writer was not admitted** in the past it saw — permanent, because that
   past is fixed at signing and the answer never changes.

That asymmetry is what keeps them from deadlocking: (2) is not waiting for
anything. Checked in the prototype:

| case | result |
| --- | --- |
| 6-deep dep chain delivered backwards | all 6 fold; resolution cascades in one pass |
| unadmitted writer, deps resolved | correctly excluded, not held forever |
| a dep that will never arrive | held; the rest of the log folds normally |
| a root event depending on a writer's own earlier event | deterministic over 200 orderings |
| **a dep cycle** | **found a bug — see below** |

### The second bug the prototype found

Two events each naming the other as a dep **folded**. `resolvable` checked only
that deps *exist*, so an event could appear in its own causal past and be judged
against a writer set that depended on itself.

A cycle cannot be *constructed* with content-addressed hashes — naming a hash
requires the event to already exist — but a peer can send arbitrary bytes, and
"impossible to construct honestly" is not a reason for the fold to accept it.
Now rejected, like any malformed input (§2.3).

## Generated histories, including removals

The existing property tests generate multi-writer histories that **add** writers
and never remove one, which is the gap 8a lived in. The prototype generates 30-
event histories with adds *and* removals, partial sync (each writer sees a random
subset of heads), and three writers.

**300 histories × 12 shuffled orderings = 3,600 folds, zero non-determinism.**
Widest `deps` observed: 4, matching the size estimate above.

And, because a generator that cannot detect the bug it was written for proves
nothing, the same histories were folded under *today's* rule — filter by the
final writer set:

> **299 of 300 histories disagree, and today's rule silently drops 1,719 events
> that were validly written.**

So the generator does catch the bug, and the zero above means something.

## How wide does `deps` get?

`proto/deps-width.mjs`. 200 rounds, 20 seeds per scenario.

| scenario | mean | p95 | max | bytes @ p95 |
| --- | --- | --- | --- | --- |
| 1 writer (a person, one device) | 0.99 | 1 | 1 | 33 |
| 2 writers (laptop + server, synced) | 1.99 | 2 | 2 | 65 |
| 5 writers (a team, mostly offline) | 1.34 | 2 | 4 | 65 |
| 10 writers (busy space, patchy sync) | 1.95 | 4 | 6 | 129 |
| 50 writers (large space, patchy sync) | 1.99 | 4 | 7 | 129 |

**Bounded by concurrently-active writers, not by log length**, and the mechanism
is that **writing consumes the heads it names**: every write collapses whatever
it saw into one new head. Heads only accumulate between one writer's consecutive
writes.

The worst case is a peer that goes away while others write, and comes back: it
sees one head per writer that moved. 50 peers → 50 deps → 1,601 bytes for **one
event**, which then drains to 1 on its next write. A wide event, not a sustained
cost.

Note this barely grows with writer count once sync is good — 50 synced writers
have the same p95 as 2. It is concurrency that costs, not population.

## What the permission check costs

`proto/deps-fold-cost.mjs`. The prototype walks the whole causal past per event,
which is **O(n²)**: 10s at 10k events, and 50k did not finish. That is fine for
a test harness and unusable in a fold.

The right shape carries the **set of maximal root events** forward in topological
order: each event's set is the union of its deps' sets, collapsing to itself if
it is a root.

| events | writers | sync | time | widest set |
| --- | --- | --- | --- | --- |
| 10,000 | 3 | 1.0 | 4ms | 1 |
| 100,000 | 3 | 1.0 | 17ms | 1 |
| 500,000 | 3 | 1.0 | 74ms | 1 |
| 100,000 | 10 | 0.3 | 32ms | 15 |
| 100,000 | 50 | 0.1 | 30ms | 26 |

Linear, ~0.2µs per event. **Verified equivalent to the naive walk: zero
mismatches over 8,000 events across 200 generated histories.**

Two things that had to be got right, both found by measuring:

- **A single carried-forward "winner" is wrong.** Two root events can be
  genuinely concurrent — neither in the other's past — and which wins is a
  tiebreak that has to be applied to the whole maximal set at once. Carrying one
  id disagreed with the naive walk on 147 of 8,000 events.
- **Consumed sets must be freed.** Retaining every event's set exhausted a 4GB
  heap at 100k events. A dep that has been written past is never read again, so
  dropping it after use takes the widest live set from 1,130 to 26.

## Open before building

- ~~A bound on `deps` under concurrency.~~ Measured above.
- ~~The cost of `pastOf` on a real log.~~ Measured above.
- ~~Whether `prev` survives, or collapses into `deps`.~~ **Not open — they prove
  different things.** `prev` is one hash of *your own* previous event, and
  `checkLink` verifying it against `eventId(previous)` is what makes `seq`
  trustworthy: you cannot claim `seq 5` without producing the real event at
  `seq 4`. That is what turns the version vector's "0–47 contiguous" into a
  verified statement rather than a claim. `deps` is a set, mostly of *other
  people's* events, and nothing checks it against a chain because there is no
  chain to check it against.

  The test that settles it: **`prev` is not derivable from `deps`.** Given the
  set you cannot tell which member is the author's own previous event without
  already knowing the chain — which is the thing being verified. And nothing
  reads `prev` except `checkLink` and the two serialisers, so no consumer would
  be simplified by merging them.

  Dropping `prev` therefore means dropping `seq`, which means dropping version
  vectors. That is the full DAG change (OPEN.md 10), not a tidy-up — and `prev`
  survives or dies with `seq` rather than on its own.

Nothing on that list is open any more. What remains before building is the
build itself, and the limitations in *What it does not address* above — none of
which measurement can change.
