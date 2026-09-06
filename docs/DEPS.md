# `deps`: deciding what was allowed when it was written

**Status: proposed, with the permission check prototyped.** Not built. The
prototype is `proto/deps-permission-check.mjs` — standalone, runs under `node`,
no engine imports.

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

**It does not give attribution** (`LEARNINGS.md` §1). Still no notion of a person.

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
than `deps` adds — see `LEARNINGS.md` §3a. Not proposed here.

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

## Open before building

- **The fold gains an ordering dependency.** An event whose deps have not
  arrived cannot have its permission decided, so it waits. The fold already
  defers events from unadmitted writers; the interaction between the two needs
  care, and the prototype only shows that deferral works in isolation.
- **A bound on `deps` under concurrency**, if this is ever used for a busy space.
- **Whether `prev` survives at all**, or collapses into `deps`. Keeping it is the
  conservative choice and what makes this additive.
