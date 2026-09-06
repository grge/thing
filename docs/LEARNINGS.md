# What this design got wrong, and what a rewrite should carry

**Status: accumulating.** Not a plan, and not a criticism of the current
architecture — most of it works. This is the list of things that were only
learnable by building, and that a next version should start from rather than
rediscover.

The current design is being finished as it stands. These are noted as they are
found, so that when a rewrite happens there is something better than memory.

---

## 1. `writer` is three concepts wearing one name

Today one field answers three different questions:

| question | who asks | changes how often |
| --- | --- | --- |
| who is accountable for this event? | the fold, `:writers`, the root check | never |
| which chain does this extend? | `checkLink`, `ChainSet`, sync | per process |
| which key signed it? | `verifyEvent` | per key rotation |

`APPEND-POINTS.md` splits the second off. The first and third are still fused,
and the level above all of them — **a person, stable across spaces** — does not
exist at all: a writer key is minted per space, and is the space key for the
space's creator.

**Carry forward:** decide the identity model *before* the event envelope.
Everything downstream inherits its shape, and the envelope is the hardest thing
to change once logs exist.

## 2. Dense sequence numbers were chosen for sync and paid for everywhere else

`seq` exists so a version vector can say "I hold 0–47 contiguous". That is a
genuinely good property: cheap to compute, cheap to compare, cheap on the wire.

The cost was not visible at the point of choosing. Dense per-writer positions
mean **one append point per writer**, which means a lock, which means a second
process cannot write, which means a control API, which means a second protocol.
Two sessions of admin-tooling design were spent routing around a constraint
introduced by a sync optimisation.

The literature (`EQUIVOCATION.md`) is blunter still: version vectors are unsafe
against a Byzantine writer for the same reason.

**Carry forward:** the causal-structure decision (dense sequences vs. hash DAG)
is *the* architectural fork. It determines what identity can mean, whether a
lock is needed, whether the CLI is a peer, and what sync costs. Make it
explicitly and early, with the downstream consequences written down, rather than
as an implementation detail of "how do we detect gaps".

## 3. Design pressure is a signal, and it was ignored twice

The admin-tooling design got steadily more elaborate — a control API, then a
write verb, then a split between reads and writes, then a fifth transport — and
each step was locally reasonable. The elaboration was the system saying a
constraint was in the wrong place.

Two earlier encounters with the same constraint were noted and passed over.
`writelock.ts` documents the hazard for tabs and says plainly that "across
devices nothing can prevent it, which is why the resolution exists" — the
generalisation was written down and not followed. §5's fork-repair note says a
fork "means the one-key-one-device constraint was already violated", treating it
as exceptional rather than as something two of your own processes do routinely.

**Carry forward:** when a design keeps needing another layer to work around one
sentence in the spec, suspect the sentence.

## 4. A constraint stated as a premise stops being questioned

§7.3 opens with *"a private key is meant to be held by one device at a time"*
and then spends a section on surviving the violation. Stated that way it reads
as a fact about keys rather than as a consequence of a choice made in §2.1.

**Carry forward:** where the spec states a constraint, say which decision
produces it. "One device at a time, *because* `seq` is dense" invites the
question that "one device at a time" closes.

## 5. Invariants leak into distant sections without saying so

§6 proposes deriving the encryption nonce from `(writer, seq)`, unique "by
construction under §7.3's constraint". That is a load-bearing dependency between
the crypto section and the chain-format section, recorded as a subordinate
clause in one bullet. Anyone relaxing §7.3 for any reason — and we nearly did —
would silently produce nonce reuse under one key.

**Carry forward:** a dependency on another section's invariant should be
declared where the invariant is *defined*, not only where it is used. §2.1 should
say what depends on chain uniqueness.

## 6. Package boundaries hid a missing layer

Four packages (`core`, `store`, `net`, `peer`) with nothing importing a subset
of them. The split bought nothing measurable and cost something real: `peer`
looked like a real boundary, so nobody noticed it had stopped one level short of
its own doc comment. The multi-space client it described lived nowhere, and
`node/peer.ts` and `web/client.ts` grew into the gap independently until they
were the same 300 lines twice.

**Carry forward:** split packages when something needs to import one without the
others, not to express layering. Layering is a reading order; a directory
expresses it fine.

## 7. Some bugs are only reachable from two processes

The duplicate-frame-handler bug passed 324 unit tests and was found by running
two real peers and noticing a delivery count double against a baseline. The
`adopt` race was carried verbatim from code that had shipped. Neither is
reachable from a single-process test.

**Carry forward:** keep a two-process end-to-end check in the loop from the
start, and record baseline counters (events delivered, sessions opened) so a
doubling is visible rather than merely plausible.

## 8. Small verification failures are silent

`grep` reports nothing on `fold.ts` because it contains an intentional `\0` as a
map-key separator, which makes grep treat it as binary. A claim central to
`EQUIVOCATION.md` — that the fold never reads `seq` — was first "verified" by a
command that could not have found anything. It happened to be true.

**Carry forward:** when a check underpins a design decision, make it fail
loudly. `grep -c` returning 0 and grep declining to read the file look identical.
