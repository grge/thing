# What this design got wrong, and what a rewrite should carry

**Status: accumulating.** Not a plan, and not a criticism of the current
architecture — most of it works. This is the list of things that were only
learnable by building, and that a next version should start from rather than
rediscover.

The current design is being finished as it stands. These are noted as they are
found, so that when a rewrite happens there is something better than memory.

---

## 1. Signing proves authority, not attribution — and nothing else does either

**The deepest of these**, and the one several others are symptoms of.

A signature currently answers **"was a key entitled to make this write?"** It
does not answer **"who made this change?"**, and no other part of the system does
either. Those look like the same question and are not: the first is about
permission, the second is about a person, and this design only ever built the
first.

Three places where the gap shows, in increasing severity:

**A user is a different key in every space.** `mint()` produces a keypair per
space, so there is nothing that says two writers in two spaces are one person.
Nobody can be followed, and "what has Alice been doing" is not expressible.

**The space key is one key with several holders.** §7.2.1 admits root events on
a signature from the space key alone. So two people co-administering a space —
adding a writer, renaming — must *share that key*. At that point the log records
that the space key granted access and **cannot record which of them did it**.
This is not a missing feature; attribution is actively destroyed by the
mechanism that provides authority. Sharing a key is how the design intends
shared administration to work.

**A key does not name a person even in principle.** Keys are stored as raw seeds
(§5.1) and are meant to be movable between devices. A key proves possession of a
secret; it never proved a person, and nothing above it makes that leap.

**What follows.** If this system is ever meant to have a social dimension —
people with a presence, changes attributable to them, someone to follow — that is
not a feature to add later on top of what exists. It needs identity to be a
first-class thing that is *distinct from* both the space key and the writer key,
with signing carrying attribution alongside authority. That is roughly what
Keyhive separates (capabilities delegated to keys, identity deliberately left to
a layer above) and what SSB's fusion identity gropes toward.

It also reframes the two decisions taken in `APPEND-POINTS.md`. Opaque points
were chosen partly because "there is no Alice for a certificate to bind to" —
which is correct today and is exactly the thing a social system would have to
change first.

**Carry forward:** decide early whether signatures attribute or merely authorise.
They are separable, most of the cost is in choosing late, and the current answer
— authority only — was never explicitly chosen. It fell out of using one key for
identity, authority and chain position at once.

## 2. `writer` is three concepts wearing one name

Today one field answers three different questions:

| question | who asks | changes how often |
| --- | --- | --- |
| who is accountable for this event? | the fold, `:writers`, the root check | never |
| which chain does this extend? | `checkLink`, `ChainSet`, sync | per process |
| which key signed it? | `verifyEvent` | per key rotation |

`APPEND-POINTS.md` splits the second off. The first and third are still fused,
and the level above all of them — **a person, stable across spaces** — does not
exist at all: a writer key is minted per space, and is the space key for the
space's creator. That missing level is §1 above; this entry is the mechanical
half of the same problem.

**Carry forward:** decide the identity model *before* the event envelope.
Everything downstream inherits its shape, and the envelope is the hardest thing
to change once logs exist.

## 3. `Keystore` is four things, and only one of them has a contract

Found while asking what the engine's tests supply for capabilities. It is the
same shape as §2 above — several concepts under one name — and it is the piece
`web/` and `node/` will collide with first when they are rebuilt.

`web/src/keystore.ts` bundles everything a client knows about a space that is
*not* in the space:

| job | methods | nature |
| --- | --- | --- |
| secrets | `mint`, `keyFor` | the writing key; raw extractable seeds (§5.1) |
| inventory | `spaces`, `remember`, `forget` | which spaces this client holds |
| naming | `petname`, `setPetname` | §5.5, local, never replicated |
| addresses | `locator`, `rememberLocator` | §5.3, **stale by default** |

The unifying idea is sound — a log is replicated and identical everywhere, these
four are per-client and lost with the client's storage — but the pieces want
different treatment. **A secret and a disposable cache are sharing one
interface**, so they get the same storage, the same lifetime and the same backup
story, when they should share none of those. §5.1.1 calls losing the key the
largest unresolved risk in the design; `locator` losing its contents is a minor
inconvenience.

**And `node/` does not implement it.** The same four jobs are solved four
different ways there:

- secrets → `keyPath`/`loadKey`/`saveKey`, three loose functions in `cli.ts`
- inventory → absent; `Store.list()` serves, because a directory *is* the
  inventory
- naming → `FilePetnames`, its own class, against `PetnameStore` — the one
  quarter that *does* have a shared contract, and it lives in the engine
- addresses → **not implemented at all**; `thing join` takes a URL every time

So this is not one interface with two backends. It is an interface in `web/`,
four ad-hoc solutions in `node/`, and one of them missing.

**Carry forward:** decide what the pieces are before writing a contract for
them. The obvious move is a `MemoryKeystore` plus a conformance suite, matching
what `MemoryStore` does for storage — and that would be premature here, because
a conformance suite for the wrong shape makes the wrong shape harder to change.
Split first: the key wants backup and recovery, the inventory is derivable from
storage, the petname store already has its contract, and the locator cache wants
to be forgettable.

## 3a. The wire format costs 2.1x what it needs to

Measured while sizing something else. A real event is **206 bytes on disk** and
**435 on the wire**, because `wire.ts` encodes every binary field as hex inside
JSON — a 32-byte hash becomes 64 characters, and there are three of them per
event plus a 64-byte signature.

Base64 would bring it to roughly 1.4x; a binary framing to about 1.05x. That is
a larger saving than most things being weighed against it, with no design risk:
`wire.ts` is explicitly the one of the three encodings that is *free to change*,
since it is neither signed nor stored.

Not done now — it is a rewrite-shaped change and nothing is deployed that needs
it — but recorded so that "is X too many bytes per write" has a reference point.
The answer for most X is: smaller than what the encoding is already wasting.

## 4. Dense sequence numbers were chosen for sync and paid for everywhere else

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

## 5. Design pressure is a signal, and it was ignored twice

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

## 6. A constraint stated as a premise stops being questioned

§7.3 opens with *"a private key is meant to be held by one device at a time"*
and then spends a section on surviving the violation. Stated that way it reads
as a fact about keys rather than as a consequence of a choice made in §2.1.

**Carry forward:** where the spec states a constraint, say which decision
produces it. "One device at a time, *because* `seq` is dense" invites the
question that "one device at a time" closes.

## 7. Invariants leak into distant sections without saying so

§6 proposes deriving the encryption nonce from `(writer, seq)`, unique "by
construction under §7.3's constraint". That is a load-bearing dependency between
the crypto section and the chain-format section, recorded as a subordinate
clause in one bullet. Anyone relaxing §7.3 for any reason — and we nearly did —
would silently produce nonce reuse under one key.

**Carry forward:** a dependency on another section's invariant should be
declared where the invariant is *defined*, not only where it is used. §2.1 should
say what depends on chain uniqueness.

## 8. Package boundaries hid a missing layer

Four packages (`core`, `store`, `net`, `peer`) with nothing importing a subset
of them. The split bought nothing measurable and cost something real: `peer`
looked like a real boundary, so nobody noticed it had stopped one level short of
its own doc comment. The multi-space client it described lived nowhere, and
`node/peer.ts` and `web/client.ts` grew into the gap independently until they
were the same 300 lines twice.

**Carry forward:** split packages when something needs to import one without the
others, not to express layering. Layering is a reading order; a directory
expresses it fine.

## 9. Some bugs are only reachable from two processes

The duplicate-frame-handler bug passed 324 unit tests and was found by running
two real peers and noticing a delivery count double against a baseline. The
`adopt` race was carried verbatim from code that had shipped. Neither is
reachable from a single-process test.

**Carry forward:** keep a two-process end-to-end check in the loop from the
start, and record baseline counters (events delivered, sessions opened) so a
doubling is visible rather than merely plausible.

## 10. The spec's reasoning is usually better than a first read of it

Twice now a section looked like an arbitrary restriction and turned out to be
load-bearing once the *why* was read. §7.2.1 ("only the space key writes the
root") reads as a limitation; it exists to remove a genuine circularity — the
writer set lives on the root, the root is materialised by the fold, the fold
excludes non-writers — and §7.2 records that the obvious fix of folding twice
lets a stranger write "I am a writer" and be believed. §6's nonce clause is the
same pattern: a rule whose dependency is stated once, in passing.

**Carry forward:** where a section states a rule, state what breaks without it
in the same breath. Both of these did explain themselves, but far enough from
the rule that the rule could be read alone and misjudged.

## 11. Small verification failures are silent

`grep` reports nothing on `fold.ts` because it contains an intentional `\0` as a
map-key separator, which makes grep treat it as binary. A claim central to
`EQUIVOCATION.md` — that the fold never reads `seq` — was first "verified" by a
command that could not have found anything. It happened to be true.

**Carry forward:** when a check underpins a design decision, make it fail
loudly. `grep -c` returning 0 and grep declining to read the file look identical.
