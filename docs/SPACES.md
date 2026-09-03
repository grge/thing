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

**The central bet, so it is not buried.** The fold should be *universal* — one
deterministic algorithm in every client, driven by declarations rather than by
per-type code — and applications should ship only the **renderer**, never the
fold. We do not know how to build that. §3 argues for it; §3.3 lists what it
would take; §3.4 lists why it might not be reachable. Treat it as the direction
of travel, not as a solved design.

**How settled things are.** Sections are marked:

| | Meaning |
|---|---|
| **Follows** | A consequence of things already decided. Low risk; mostly needs writing down. |
| **Proposed** | The direction's actual content. Argued for here, not decided. |
| **Open** | Named because it is unresolved, and because pretending otherwise would be dishonest. |

---

## 0. The one-line version

**A space is a log plus a type. The fold is universal; the type declares how its
attributes merge and how the folded state is drawn. Applications ship the
renderer, never the fold.**

The filesystem is one type among several, not the substrate. Everything else in
this document is a consequence of taking that seriously.

**The honest caveat, stated once and up front:** the universal fold is a
*target*, not a design we know how to build. §3 argues for it and §3.4 lists the
reasons it might not be reachable. Nothing below should be read as though the
problem is solved.

---

## 1. Three layers, not two — **Proposed**

The system as built has one interpretation: a log of `(object, attribute,
value)` events folded into a filesystem tree. [DESIGN.md](DESIGN.md) §1 presents
the object model as the *core model* and the filesystem as what it folds into.

The complaint is not the triple. `(object, attribute, value)` is a fine general
shape. The complaint is that **filesystem semantics live inside the fold**:
`:parent` means tree structure, `:name` means the thing you display, scalars are
last-writer-wins because that is what a filesystem wants. Those are one
application's decisions, compiled into the substrate.

So the split is three layers, not two:

```
┌ substrate ─── log, per-writer chains, signatures, version vectors, blobs
│               type-blind. Never reads a payload.
│
├ fold ──────── universal. One algorithm, driven by the merge rule each
│               attribute declares. Deterministic, pure, in every client.
│               ← the target. Not built. See §3.4.
│
└ view ──────── type-specific. Walks the folded state and draws it.
                fs = tree + blobs; chat = message list; board = canvas.
```

Read against the current code: the substrate exists and is already type-blind.
The fold exists but is filesystem-specific. The view exists but is not
separated from the fold. **The work is the middle line** — pulling the
filesystem's semantics out of the fold and into declarations, leaving one
algorithm behind.

What that buys, and it is the whole argument:

- **Commutativity becomes structural** rather than a property the fold author
  maintains by hand (§3).
- **Compaction becomes mechanical per merge rule** rather than one hard general
  problem (§3.2, §6).
- **A peer can fold a space whose type it has never seen.** It cannot draw it,
  but it can compute its state, verify it, and compact it. This is the
  surprising property, and it is what makes §4 safe.

---

## 2. Space types — **Proposed**

### 2.1 What a type declares

A space's ROOT carries a type declaration. A type declares two things and no
others:

1. **A schema** — for each attribute, which merge rule it uses (§3). Data, not
   code. Read by the universal fold.
2. **A view** — how to draw the folded state. Code, and the only code that
   ships (§4).

**A type never supplies a fold.** That rule is what keeps the fold universal,
and every benefit in §1 depends on it. If a type ever needs its own fold
algorithm, the merge-rule registry is missing an entry — that is a gap in §3, to
be fixed in §3, not routed around per type.

Consequences worth stating plainly:

- **A peer that does not understand a type can still replicate it.** Chains
  verify, signatures verify, version vectors reconcile, blobs transfer. None of
  that reads the payload. Already true of the code today.
- **A peer that does not understand a type can still *fold* it**, given the
  schema, because the fold is universal. It computes correct state it cannot
  draw. This is new, and it is the point.
- **A peer that lacks the view can only refuse to draw.** Not "draws it badly" —
  refuses, and says so.
- **The type is not a permission.** It says what the bytes mean, not who may
  write them. Write permission is a separate ROOT-level concern (§5).

### 2.2 Candidate types

Not a proposal to build these. A list to test the shape against:

| Type | Merge rules it needs | Why it is interesting |
|---|---|---|
| **fs** | LWW on `:name`/`:parent`, blob refs | What exists. The floor — and the test that today's semantics survive being demoted to declarations. |
| **chat** | append-only set, ordered by clock | Nearly trivial: the fold is close to the identity function. Tests whether a universal fold is honest at the degenerate end. |
| **board** | a sequence/position CRDT | The hard one. Tests whether the registry can express structured concurrency at all (§3.4). |
| **code** | LWW on module contents | Makes §4 possible. Note it needs no exotic merge rule — a code-space is mostly a filesystem. |
| **ephemeral** | none; nothing durable | Presence, cursors, signalling, gossip. Tests whether "log" is even the right primitive (§7). |

Chat is the cheapest real test and should come first, precisely because it is
boring. If chat needs a merge rule the registry cannot express, the universal
fold is in trouble at the *easy* end, which would be decisive early.

### 2.3 What would falsify this

The claim is that one algorithm plus a registry of merge rules covers the
interesting applications. It is falsified if **any candidate type needs its own
fold** — not "would be more convenient with one", but genuinely cannot be
expressed as per-attribute merge.

`board` is where that is most likely (§3.4). If it happens, the choice is
between growing the registry and abandoning the universal fold, and this
document has picked growing the registry. **That is a bet, and it is the bet
this whole direction rests on.**

---

## 3. Typed attributes and structural commutativity — **Proposed**

This section is the universal fold. Everything else in the document depends on
it, and it is the least built thing here.

### 3.1 The idea

Today, commutativity ([DESIGN.md](DESIGN.md) §1.3) is a property the fold
maintains by convention, verified by a shuffle test. Every new attribute is a
new opportunity to break it, and the argument lives in the fold author's head.

Move that argument into the *declared type of the attribute*:

```
:name    LWW-register     max (lamport, writer) wins
:parent  LWW-register
:text    sequence         a positional/sequence CRDT
:votes   counter          per-writer counts, summed
:tags    OR-set           add/remove with causal tags
```

The fold is then, for every space of every type: *for each attribute, apply the
merge rule its schema declares.* Commutativity is structural — it follows from
each merge rule being a join-semilattice — rather than from care.

Note what happened to the filesystem: `:name` and `:parent` are still there,
still LWW, but now they are *declarations in the fs schema* rather than branches
in the fold. Nothing about the filesystem is lost; it stops being privileged.

CRDTs were never ruled out of the design — only out of the scope of a particular
experiment ([DESIGN.md](DESIGN.md) §10). This is where they return, at the
attribute layer rather than as a library bolted on top.

### 3.2 Why it pays for itself

- **New attributes get commutativity for free**, or fail loudly at declaration
  time because no merge rule fits — which is a design error surfaced early
  rather than a shuffle-test failure surfaced late.
- **Compaction becomes mechanical.** An LWW-register compacts to one value; a
  counter to one integer per writer; an OR-set to its live members. One hard
  general question becomes several easy specific ones (§6).
- **The security surface shrinks.** The deterministic, security-critical part
  stays in the client and never ships. Only the view is foreign code (§4).

### 3.3 What is actually required to build it

Naming these so the size of the gap is visible:

- A **merge-rule registry** with a stable identifier per rule, since two clients
  must agree on what `sequence` means.
- A **schema format** in ROOT, and a rule for what happens when it changes — a
  schema is itself mutable state in the log whose interpretation the fold
  depends on, which is the same circularity as §5's permissions.
- **Byte-level determinism** for every rule, because §6's snapshots hash the
  fold output.
- An answer for **an attribute whose rule a peer does not know**: refuse the
  whole fold, or fold the rest and mark it unresolved.

### 3.4 Why this might not be reachable — **Open**

The honest statement of the risk:

- **Sequence CRDTs may not fit.** They carry state that is not per-attribute —
  position identifiers, tombstones, causal metadata — and may need to escape into
  the payload or into their own event shape. If a sequence cannot be a merge
  rule, `board` cannot be a type, and §2.3's bet is lost.
- **The registry may not stay small.** A universal fold with forty special cases
  is a type-specific fold wearing a costume.
- **Nobody has built this here.** The three-layer split is a paper argument
  against one working implementation. Chat (§2.2) is the cheapest way to find
  out whether it survives contact.

---

## 4. Applications as spaces — **Proposed**

If a space can be of type **code**, then an application is a space: a signed,
content-addressed, replicable bundle that folds into executable modules.

**An application is a view, never a fold.** It receives folded state — already
computed, already verified, already deterministic — and draws it. It does not
decide what the log means. This is the constraint that makes the rest of the
section affordable, and §2.1 states it as a rule.

The client becomes thin. It knows how to:

1. Replicate a log and verify its chains.
2. Read a ROOT's type declaration: a schema and a view reference.
3. Fold the log with the universal fold, using the declared schema.
4. Resolve the view reference to a code-space, and replicate it like any other.
5. Run that view against the folded state.

Note that step 3 does not depend on step 4. **A client can hold correct,
verified, compacted state for a space whose view it has never fetched** — and
can serve, verify and compact it for others. A headless peer needs no
application code at all.

**The filesystem interpretation is then just the first application**, shipped
built-in for bootstrapping but not architecturally privileged. Anything the
filesystem view can do, another view can do.

What this buys, and it is a lot:

- **Applications distribute over the same network as data.** No app store, no
  server, no CDN. An application reaches you the way a file does.
- **Applications are versioned, signed and addressable** by construction,
  because that is what a space already is.
- **A space carries a reference to its own reader.** Handed a link to a space of
  an unknown type, the client can fetch the thing that knows how to draw it.

### 4.1 The arbitrary-code problem, and why it is smaller here

This is still *code from strangers*, which is the problem the modern web
platform is organised around not solving well. But the universal fold moves the
boundary in a very favourable direction.

**What foreign code cannot do**, structurally, because it is a view:

- It cannot change what the log means. The fold ran before it loaded.
- It cannot make peers disagree. Two clients with the same events compute the
  same state regardless of which view they run, or whether they run one.
- It cannot corrupt what is stored, replicated, or compacted.

A malicious view can therefore lie to *its own user* about state, and can be
hostile in the ordinary ways foreign UI code is hostile. That is a real problem
and a well-understood one — it is not a consensus problem, which is the class
that would have been fatal.

The remaining mitigations still apply and are stronger for being narrower:

- **Code-spaces are signed**, so a trusted-author list is a real mechanism — the
  identity layer is already an Ed25519 public key ([DESIGN.md](DESIGN.md) §4.1,
  §5.1), and trust-on-first-use is already implemented for spaces.
- **Content addressing means you can pin what you ran.**
- **A view needs no ambient authority.** It needs folded state in and drawing
  out; it does not need network, storage, or the space's key.

**Open, and still the expensive part:** the rendering boundary. A pure function
is trivial to sandbox; drawing a whiteboard is not, and a view that touches the
DOM directly ends the clean story. The likely shape is a constrained declarative
surface the view emits into rather than a DOM handle — but that is a guess, and
it is where this design gets costly. It is now the *only* unresolved sandboxing
question, which is a much better position than sandboxing a fold would have
been.

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

§3's mechanical compaction is the most promising thread, and the universal
fold sharpens it: compaction is per *merge rule*, not per type, so a rule solved
once is solved for every type that declares it. It turns one hard general
question into a handful of easy specific ones — and a peer can compact a space
whose view it does not have (§4).

---

## 7. The ephemeral channel — **Open**

Presence, cursors, typing indicators, signalling and peer gossip all want to
travel between peers and none of them want to be in a durable, signed,
permanently-replicated log.

Forcing them into the log is clearly wrong: it makes every cursor movement a
permanent fact. But a second, unlogged channel is a second protocol, a second
security story, and a second place for state to live.

Named here because §2.2's `ephemeral` entry is a hint that the log might not be
the right primitive for this at all — it is the one candidate type that declares
no merge rules, which may mean it does not belong in this taxonomy — and because
[RESOLUTION.md](RESOLUTION.md)'s gossip questions land in the same place.
Unresolved.

---

## 8. Links, and whether the filesystem is privileged after all — **Open**

The network of spaces is built out of links ([DESIGN.md](DESIGN.md) §2.1), and a
link is currently *an object in the filesystem interpretation*. If the filesystem
is just one application (§4), then the graph connecting all spaces is defined
inside one application's data model — which would make the filesystem privileged
in a way §1 denies.

The universal fold makes this much less awkward than it first appears. A link is
a **value type with a merge rule**, declared like any other attribute (§3.1).
Any type may declare a link-valued attribute; the fold resolves it identically
everywhere; the graph is readable by a client that holds no view at all, because
folding does not require one (§4). The filesystem is then merely the type that
uses links *for navigation*, which is a use, not a privilege.

What stays open:

- **Whether the substrate must also know.** Resolution and gossip
  ([RESOLUTION.md](RESOLUTION.md)) want to walk the link graph to find peers,
  and that is arguably below the fold. If so, links are the one piece of
  semantics the substrate is allowed to see, and that exception needs justifying
  rather than assuming.
- **Whether link-following is a view concern or a client concern.** Navigating
  between spaces of different types cannot belong to either type's view.
- **Whether the graph should be enumerable** without folding every space you
  hold, which is a real cost at scale.

---

## 9. What this direction should not foreclose

Regardless of whether any of the above is built, these are cheap now and
expensive later:

- **Keep the substrate payload-blind.** Chains, signatures, version vectors and
  blob transfer must not learn what an attribute means. This is already true and
  costs nothing to preserve.
- **Separate view from fold.** Anywhere the current fold decides something
  because *the filesystem* wants it — `:parent` meaning tree, `:name` meaning
  label — that is a view decision sitting in the wrong layer. Moving those out
  is the first concrete step toward §3, and is useful even if the universal fold
  is never reached.
- **Keep the fold pure and deterministic.** It is the sandbox boundary in §4 and
  the hashing requirement in §6. Far cheaper to preserve than to retrofit.
- **Keep ROOT extensible.** Type declaration, schema, permission set and
  `:seeds` ([RESOLUTION.md](RESOLUTION.md) §6.1) all want to live there.
- **Do not ship a fold.** If anything ever needs to send fold logic over the
  wire, the universal-fold direction has been abandoned — deliberately or not.

---

## 10. Honest difficulties

- **The universal fold is a target, not a design.** §3.3 lists what building it
  requires and §3.4 lists why it might not be reachable. The three-layer split
  is a paper argument standing against one working implementation.
- **§3 may not survive sequence CRDTs**, which is exactly where it would matter
  most. If a sequence cannot be a merge rule, `board` cannot be a type and the
  bet in §2.3 is lost.
- **Chat is the cheap test and has not been run.** Everything here would be
  better informed by one boring second type than by more argument.
- **The rendering boundary (§4.1) is unresolved** and could be a wall rather
  than a hurdle. It is now the only sandboxing question, but it is a hard one.
- **§5's revocation problem is genuinely unsolved**, not merely undesigned.
- **§6 is left open on purpose** and the trust-when-you-lack-the-events problem
  has no answer here.
- **The system currently works.** Every idea here trades a working thing for a
  more general one, and generality that is never used is a cost with no benefit.
