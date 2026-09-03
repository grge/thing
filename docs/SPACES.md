# Spaces, types, and applications — a direction

**Status: direction, not decision. Nothing here is built and nothing is
settled.** Captured from a design conversation on 2026-09-03, after v1 steps 1–3
and the I23 fix landed. It is deliberately more speculative than
[DESIGN.md](DESIGN.md) and broader than [RESOLUTION.md](RESOLUTION.md): where
those describe a system, this describes a shape the system might grow into.

Read it as a set of claims about *what the architecture is for*, offered so that
the next round of work can be judged against a destination rather than only
against the next step. Where it says a thing "is" so, that is the direction's
shape, not a commitment.

**What it is not.** Not a replacement for [DESIGN.md](DESIGN.md), which remains
the standing description of what exists. Not a build plan. Where this document
and DESIGN.md disagree, DESIGN.md describes reality and this describes an
intention.

**How settled things are.** Sections are marked:

| | Meaning |
|---|---|
| **Follows** | A consequence of things already decided. Low risk; mostly needs writing down. |
| **Proposed** | The direction's actual content. Argued for here, not decided. |
| **Open** | Named because it is unresolved, and because pretending otherwise would be dishonest. |

---

## 0. The one-line version

**A space is a log plus a type. The type says how to fold the log. The
filesystem is one type among several, not the substrate.**

Everything else in this document is a consequence of taking that seriously.

---

## 1. What changed in the thinking — **Proposed**

The system as built has one interpretation: a log of `(object, attribute,
value)` events folded into a filesystem tree. [DESIGN.md](DESIGN.md) §1 presents
the object model as the *core model* and the filesystem as what it folds into.

The claim here is that this over-promotes the object model. It is already
strongly filesystem-flavoured — objects with named attributes, a parent
attribute, a name attribute, last-writer-wins on scalars. That is not a neutral
substrate that happens to suit filesystems; it is a filesystem's data model with
the tree walk factored out.

That is not a criticism of the choice. It was the right thing to build to prove
the replication story, and it works. The claim is narrower: **the object model
is an interpretation, and the architecture should say so**, because there are
other interpretations we want and they do not all fit comfortably inside
objects-with-attributes.

The reframing:

```
before      log ──fold──> objects ──walk──> filesystem
                  ^^^^ "the model"

after       log ──fold[T]──> state          T = the space's type
                             ├─ T=fs        objects, tree, blobs
                             ├─ T=chat      an ordered message list
                             ├─ T=board     a spatial document
                             └─ T=…
```

The log, the per-writer hash chains, the signatures, the version vectors and the
replication protocol are all *below* the fold and are the same for every type.
That layer is the substrate. The fold is not.

---

## 2. Space types — **Proposed**

### 2.1 A space declares its type

A space's ROOT carries a type declaration: an identifier saying how this log is
to be folded. Everything after that is type-specific.

Consequences worth stating plainly:

- **A peer that does not understand a type can still replicate it.** Chains
  verify, signatures verify, version vectors reconcile, blobs transfer. None of
  that reads the payload. A peer can be a perfectly good replica of a space it
  cannot render at all. This is the property that makes everything else in this
  document affordable, and it is already true of the code today.
- **A peer that does not understand a type must not fold it.** Not "renders it
  badly" — refuses, and says so. Half-understanding a log is worse than not
  reading it.
- **The type is not a permission.** It says what the bytes mean, not who may
  write them. Write permission is a separate ROOT-level concern (§5).

### 2.2 Candidate types

Not a proposal to build these. A list to test the shape against:

| Type | Fold produces | Why it is interesting |
|---|---|---|
| **fs** | objects, tree, blobs | What exists. The floor. |
| **chat** | an append-ordered message list | Nearly trivial: the log *is* the state. Tests whether the substrate is honest when the fold is the identity function. |
| **board** | a spatial document | Needs a real sequence/position CRDT. Tests whether the substrate survives contact with structured concurrency. |
| **code** | a signed bundle of executable modules | The one that makes §4 possible. |
| **ephemeral** | nothing durable | Presence, cursors, signalling, gossip. Tests whether "log" is even the right primitive here (§7). |

Chat is the most useful of these to build second, precisely because it is
boring. If chat requires contorting the object model, the object model is doing
too much work. If chat drops out naturally, the layering claim in §1 is real.

### 2.3 The interesting failure mode

If every new type turns out to be "objects with attributes, but…", then the
object model is not an interpretation, it is the substrate after all, and this
whole document is a misreading. **That is a falsifiable claim and building chat
tests it.**

---

## 3. Typed attributes and structural commutativity — **Proposed**

Today, commutativity ([DESIGN.md](DESIGN.md) §1.3) is a property the fold
maintains by convention, verified by a shuffle test. Every new attribute is a
new opportunity to break it, and the fold is where the argument lives.

The proposal is to move that argument into the *type of the attribute*:

```
:name    LWW-register     max (lamport, writer) wins
:parent  LWW-register
:text    sequence         a positional/sequence CRDT
:votes   counter          per-writer counts, summed
:tags    OR-set           add/remove with causal tags
```

Then the fold for any type is: *for each attribute, apply the merge rule its
CRDT type declares.* Commutativity is structural — it comes from the registry of
merge rules, each of which is a join-semilattice — rather than from the fold
author being careful.

Two consequences:

- **New attributes get commutativity for free**, or fail loudly at declaration
  time because no merge rule fits.
- **Compaction becomes mechanical per type.** An LWW-register compacts to one
  value; a counter to one integer per writer; an OR-set to its live members. You
  no longer need a general answer to "how do you compact a log", only a per-type
  one. This is the part of the idea that pays for itself.

CRDTs were never ruled out of the design — only out of the scope of a particular
experiment ([DESIGN.md](DESIGN.md) §10). This is where they come back, and they
come back at the attribute layer rather than as a library bolted on top.

**Open:** whether a sequence CRDT can be expressed in this registry shape at all,
or whether it needs to escape into the payload. Sequence CRDTs carry state that
is not per-attribute — position identifiers, tombstones — and that may not fit.
This is the most likely place for the idea to break.

---

## 4. Applications as spaces — **Proposed**

If a space can be of type **code**, then an application is a space: a signed,
content-addressed, replicable bundle that folds into executable modules.

The client becomes thin. It knows how to:

1. Replicate a log and verify its chains.
2. Read a ROOT's type declaration.
3. Resolve that type identifier to a code-space.
4. Fetch and replicate that code-space like any other.
5. Run its fold against the original log.

**The filesystem interpretation is then just the first application**, shipped
built-in for bootstrapping, but not architecturally privileged. Anything the
filesystem interpreter can do, another interpreter can do.

What this buys, and it is a lot:

- **Applications distribute over the same network as data.** No app store, no
  server, no CDN. An application reaches you the way a file does.
- **Applications are versioned, signed and addressable** by construction,
  because that is what a space already is.
- **A space carries its own reader.** Handed a link to a space of an unknown
  type, the client can go and fetch the thing that knows how to read it.

### 4.1 The obvious problem

This is *arbitrary code from strangers*, which is the problem the entire modern
web platform is organised around not solving well.

It is addressable, and the addressing work already done helps:

- **Code-spaces are signed.** A trusted-author list is a real mechanism, not a
  hand-wave — the identity layer is already an Ed25519 public key
  ([DESIGN.md](DESIGN.md) §4.1, §5.1), and trust-on-first-use is already
  implemented for spaces.
- **Interpreters do not need ambient authority.** A fold is a pure function from
  a log to state. The natural sandbox — a worker with no network, no storage, no
  DOM, given events and returning state — is both a security boundary and the
  correct functional shape. Those coinciding is a good sign.
- **Content addressing means you can pin what you ran.**

**Open, and load-bearing:** rendering. A pure fold in a worker is easy to
sandbox. Drawing a whiteboard is not, and the moment an interpreter touches the
DOM the clean story ends. The likely answer is a two-layer split — sandboxed
pure fold, plus a constrained declarative rendering surface it emits into — but
that is a guess and it is exactly where this design gets expensive.

---

## 5. Multi-writer spaces and permissions — **Proposed**

A space today is effectively single-writer-per-origin (I23, fixed). The
direction is multi-writer spaces where write permission is declared at ROOT.

The minimum viable shape: a **binary** permission at ROOT — a set of writer
public keys admitted to the space. Events from a key not in the set are
replicated (a peer cannot be trusted to filter honestly) but **not folded**.

This keeps the important property: **validity is a local, deterministic
computation over the log**, not a query to an authority. Two peers with the same
events agree on who may write, because the answer is in the events.

**Open, all of it:**

- **How the permission set itself changes.** It is a mutable attribute in a log
  whose validity depends on it, which is circular. Bootstrapping from the space
  key's own signature works for the first grant; revocation is genuinely hard —
  a revoked writer's old events are still validly signed, and "valid when
  written" versus "valid now" is a fork waiting to happen.
- **Whether binary is enough.** Per-object or per-attribute permission is a much
  larger design and probably the wrong second step.
- **How this interacts with §4.** If applications are spaces, then who may write
  to an application is who may ship a version of it.

---

## 6. Compaction and snapshots — **Open, deliberately left open**

Discussed at length and not resolved here. Recording the shape so the argument
is not re-derived:

- **Snapshots as content-addressed blobs.** A snapshot is `hash(fold(events up
  to watermark W))`, stored in the existing blob layer. It needs no signature: a
  peer holding the same events verifies by recomputing. Disagreement is
  detectable rather than silent, and identical states dedup across peers for
  free.
- **A snapshot is plausibly an ordinary event** carrying `{covers:
  version-vector, state: blob-hash}` — so it replicates normally, sits in a
  chain and cannot be silently inserted, and is verifiable-by-recomputation when
  possible and attributable-by-signature when not.
- **The unsolved part.** Verification requires the events you were trying to
  discard. *Fast start* (keep the log, skip the fold) is unambiguously safe.
  *Actual compaction* (discard the events) is unfalsifiable downstream once the
  originals leave the network. Content addressing solves verification-when-you-
  have-the-data; it does not solve trust-when-you-do-not.
- **The question to settle first:** may a peer compact events it did not write?
  If no, every snapshot is signed by the only party that could have lied anyway
  — a clean story that costs the ability to compact a departed writer. If yes,
  real garbage collection is possible and a corroboration story is required.
- **Determinism is a hard constraint.** `hash(fold(...))` requires a second
  canonical format, byte-stable across implementations. A one-byte difference
  means two peers permanently disagree about a hash while holding identical
  state.
- **Prior art:** Yjs does not solve this. It has no signing, replicates
  everything (so partial logs — and F13 — never arise), and its GC is a payload
  optimisation, not history reduction. Git is the better model: make the
  snapshot deterministic and content-addressed so it needs no signature.

§3's per-type mechanical compaction is the most promising thread, because it
turns one hard general question into several easy specific ones.

---

## 7. The ephemeral channel — **Open**

Presence, cursors, typing indicators, signalling and peer gossip all want to
travel between peers and none of them want to be in a durable, signed,
permanently-replicated log.

Forcing them into the log is clearly wrong: it makes every cursor movement a
permanent fact. But a second, unlogged channel is a second protocol, a second
security story, and a second place for state to live.

Named here because §2's `ephemeral` type is a hint that the log might not be the
right primitive for this at all, and because [RESOLUTION.md](RESOLUTION.md)'s
gossip questions land in the same place. Unresolved.

---

## 8. Links, and whether the filesystem is privileged after all — **Open**

The network of spaces is built out of links ([DESIGN.md](DESIGN.md) §2.1), and a
link is currently *an object in the filesystem interpretation*. If the filesystem
is just one application (§4), then the graph that connects all spaces is defined
inside one application's data model — which either means links must move below
the fold, or means the filesystem is architecturally privileged in a way §1
denies.

Three possible resolutions, none chosen:

1. **Links move below the fold** — a substrate-level reference, available to
   every type. Clean, but it means the substrate knows about spaces referencing
   spaces, which is more semantics than "a log of signed events".
2. **The filesystem stays privileged**, honestly, as the naming and navigation
   layer for everything else. Cheap and defensible, but it contradicts §1.
3. **Every type may emit links** as a declared output of its fold, alongside its
   state. Links become an interface a type implements rather than a data shape.

Option 3 is the most attractive and the least worked out.

---

## 9. What this direction should not foreclose

Regardless of whether any of the above is built, these are cheap now and
expensive later:

- **Do not assume one interpretation.** Anywhere the code says "the fold", it
  should be possible for it to say "the fold for this type". Keeping the
  replication layer strictly payload-blind costs nothing today.
- **Do not let the object model leak below the fold.** Chains, signatures,
  version vectors and blob transfer must not learn what an attribute means.
- **Keep ROOT extensible.** Type declaration, permission set and `:seeds`
  ([RESOLUTION.md](RESOLUTION.md) §6.1) all want to live there.
- **Keep the fold pure.** It is the sandbox boundary in §4 and the determinism
  requirement in §6. Both are much cheaper to preserve than to retrofit.

---

## 10. Honest difficulties

- **This is a large amount of speculation resting on one shipped interpretation.**
  Building chat (§2.2) is the cheapest real test of the central claim, and
  should probably come before anything else here.
- **§4 is the exciting part and the most likely to be wrong.** The rendering
  boundary (§4.1) is unresolved and could be a wall rather than a hurdle.
- **§5's revocation problem is genuinely unsolved**, not merely undesigned.
- **§3 may not survive sequence CRDTs**, which is where it would matter most.
- **The system currently works.** Every idea here trades a working thing for a
  more general one, and generality that is never used is a cost with no benefit.
