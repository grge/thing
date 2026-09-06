# Architecture

A peer-to-peer substrate for collaborative applications, running in the browser.

This document describes the design in full and assumes no prior context. It is
written to be read start to finish by someone who has never seen the system.

## How settled this is

**Most of this is not built.** The document describes a design, and it is written
in the present tense throughout because a design reads badly in the conditional —
but the present tense is a convention here, not a claim about what exists. Each
section carries a mark:

| | Meaning |
|---|---|
| **Proven** | Implemented and working. The reasoning has survived contact with running code. |
| **Decided** | Settled on paper. The argument is closed; no code exists. |
| **Open** | Genuinely unresolved. Named so it is not mistaken for settled. |

Three things are **Open** and load-bearing enough to name here, because a reader
who takes them for solved will plan badly:

- **The universal fold** (§3) is the central bet. Its structural half is safe:
  every attribute merges by a fixed, universally known rule, so any client can
  compute any space's tree and names. What is open is whether the vocabulary of *body* rules
  stays small enough to be a vocabulary (§3.8).
- **Forks are detected but not repaired** (§2.3). The handshake notices a
  diverged chain; fetching the competing branch needs a request that is left
  undesigned, deliberately, until compaction wants the same extension (§9.2).
- **Compaction is understood but unbuilt** (§9). Discarding events safely needs
  wire concepts that do not exist yet, so snapshots are for now a cache that
  never discards anything (§9.1).

There is also one **constraint on operating the system** that it cannot enforce
itself: **a private key is held by one device at a time.** Two devices sharing a
key fork that writer's chain, and while §7.3 resolves the fork deterministically
so the network converges, the losing branch's writes are dropped. Worth reading
before any decision about sharing administration.

A reader who wants only the parts that are safe to build on should read §2, §5,
§6, §7 and §10, which are Proven or Decided throughout.

---

## 1. Overview

The system replicates **append-only logs of signed events** between browser
peers over WebRTC, with no server holding the data.

A **space** is the unit of everything: identity, sharing, storage and
replication. A space is a log, and a log folds into state. That state is a tree
of **objects**, each with attributes and a body — and what a body *means* — a
file, a message, a co-edited document — depends on a rule that object declares.
The mechanism that folds the log is the same for all of them, and objects of
different kinds sit side by side in one space.

Three layers, strictly separated:

```
┌──────────────────────────────────────────────────────────────────┐
│ VIEW        draws the state                                      │
│             application-specific · ships as data over the network│
├──────────────────────────────────────────────────────────────────┤
│ FOLD        computes state from events                           │
│             universal · one algorithm · driven by declarations   │
├──────────────────────────────────────────────────────────────────┤
│ SUBSTRATE   stores, signs, verifies and replicates events        │
│             payload-blind · never interprets a value             │
└──────────────────────────────────────────────────────────────────┘
```

The separation is the design. Each layer knows strictly less than the one above
it, and the two lower layers are identical for every application:

- The **substrate** moves bytes it never interprets. It can replicate a space
  for an application that does not exist yet.
- The **fold** computes state by applying, to each slice of the log, the merge
  rule that slice uses. It is deterministic and identical in every client, so two
  peers holding the same events compute the same state — including peers that
  have never seen the application the space belongs to.
- The **view** is the only layer that is application-specific, the only layer
  that ships over the network, and the only layer that can be wrong without
  consequence for anyone else.

**Applications ship views, never folds.** This is the central constraint and
Section 8 explains what it buys.

Cutting across all three layers, a space has **two keys with separate jobs**: a
keypair whose public half *is* the space's identity and whose private half
authorises writes, and an optional symmetric key that decrypts content. The
first makes a space verifiable, the second makes it private, and because they
are separate, **a peer can hold and serve a space it cannot read** (Section 6).

Both keys are **per space and cover all of it**. There is no permission finer
than a whole space, which is why spaces are small and numerous: anything shared
on different terms is a different space, referenced from wherever it belongs
(Section 7.1).

### 1.1 Properties this produces

| | |
|---|---|
| **No server holds data** | Peers exchange events directly. Infrastructure assists connection, never custody. |
| **Order-independent** | The log is a *set*. Any peer with the same events has the same state, regardless of arrival order. |
| **Offline-capable** | A disconnected peer keeps writing. Reconnection is set reconciliation, not replay. |
| **Verifiable** | Every event is signed. A space's identity is a public key, so provenance is arithmetic rather than convention. |
| **Application-agnostic** | A peer can store, verify, replicate, fold and compact a space whose application it does not have. |
| **One boundary per space** | Reading and writing are governed per space and never per object, so who can see and change a thing is answered in one place. |
| **Readable only by intent** | Content may be encrypted under a separate key, so a peer can be a complete replica of a space it cannot read. |

---

## 2. The substrate — **Proven**

The substrate stores and replicates events. It never reads a value.

Signed events, per-writer chains, version-vector reconciliation and chunked blob
transfer with resume and backpressure are all implemented and working. This is
the part of the design with the least risk attached.

### 2.1 Events

An event is one assertion: *this attribute of this object now has this value.*
Events are never mutated and never deleted.

```
Event {
  writer:  PublicKey      // 32 bytes, Ed25519 — the writer's identity
  seq:     u32            // per-writer, starts at 0, strictly incrementing
  prev:    Hash | null    // hash of this writer's event seq-1; null iff seq == 0
  lamport: u64            // logical clock, for ordering concurrent writes
  target:  Uuid           // the object this asserts about
  attr:    AttrName       // which attribute
  value:   Value          // the asserted value
  wall:    u64            // wall-clock ms — display only, never resolves anything
  sig:     Signature      // 64 bytes, over a domain tag, the space key, and the above
}
```

There is no space field on the wire: a space is established once per connection
rather than repeated on every event. **The space's public key is nonetheless part
of the signed preimage**, prepended as a domain separator before `writer`. It
costs nothing to transmit, because the receiver already knows which space a
connection carries, and it is what makes a signature mean *this writer said this,
in this space* rather than merely *this writer said this*.

Without it a signed event is portable between any two spaces the writer belongs
to, and both outcomes are bad. If chains are per space, an adversary replays a
writer's chain from one space into another: it verifies, presents as a fork from
seq 0, and §7.3's longest-branch rule then lets a long chain lifted from
elsewhere displace that writer's real history. If chains are global per writer,
the second space stalls forever (§2.5) on sequence numbers consumed in the first.
The separator closes both, and it must be decided before any log exists because
it changes what is signed.

**Objects** are identified by UUID, assigned at creation and never reused. An
object's state is a set of independently-resolved attributes, so two writers
touching different attributes of the same object never conflict.

**`target` and `attr` together name a slice** — the bag of events an event
belongs to, and the unit the fold resolves independently (§3.1). The substrate
does not read them for any purpose of its own: chains, version vectors and
signatures work on `(writer, seq)` alone. They are carried, verified and
replicated as opaque bytes, and only the fold gives them meaning.

**Canonical encoding.** Two implementations must produce byte-identical
encodings, since hashing, signing and deduplication all depend on it: fixed field
order, length-prefixed values, no maps, no floating-point in hashed positions.
Attribute names and value variants encode as fixed numeric tags, which are never
renumbered because they are hashed.

**Every signature is domain-separated.** A preimage begins with a tag naming what
kind of thing is being signed, and an event's tag is one of several — the
ephemeral channel signs things too (§10.2), and a key that signs two kinds of
message without distinguishing them is one cross-protocol replay away from
signing the wrong one. So an event's preimage is *tag, then space key, then the
envelope*, and nothing else a peer signs can ever produce the same bytes.

**The signature is not part of its own preimage.** The canonical encoding covers
the tag, the space key, and the envelope from `writer` through `wall`; `sig`
travels beside it. An event's
identity is the hash of that preimage, so it does not depend on the signature
bytes — which keeps an event's id stable under any future change to the
signature scheme.

**Hash widths are a security parameter, not a size decision.** `prev` and event
ids are SHA-256. They must not be truncated: a `prev` link is a second-preimage
target for an adversary who wants to graft a fabricated history onto a specific
writer's chain, and event ids drive deduplication, where a collision silently
drops a real event. A ~2^64 birthday bound is ample against accident and
irrelevant against intent, so the saving is not worth having. Content hashes
(§2.4) are full SHA-256 for the same reason.

### 2.2 Chains, clocks and the shape of ordering

**Within a writer**, order is exact. Each event carries the hash of that writer's
previous event, forming a per-writer chain. A gap or a fork is detectable.

**Between writers**, there is no order, and none is needed. Concurrent writes to
the *same attribute of the same object* are resolved by that attribute's merge
rule (Section 3); everything else is genuinely independent.

**Lamport clocks** supply a deterministic tiebreak where a merge rule needs one.
A writer increments its counter on write and raises it to `max(own, incoming)`
on receipt. Ties break on writer public key bytes, so the comparison key
`(lamport, writer)` is a total order.

A writer could inflate its clock to win every conflict. Signing is what makes
this fail: an inflated clock is only usable by the writer whose key signs it,
and a writer that persistently misbehaves can be identified and ignored — the
misbehaviour is attributable rather than anonymous.

### 2.3 Replication

Peers exchange **version vectors**: for each writer, the highest sequence number
held contiguously, **and the hash of the event at that position**. Reconciliation
is the difference between two vectors, and events arriving out of order within a
writer are held aside until their predecessor arrives.

The frontier alone answers *how far have you got*. The tip hash answers *along
which history*, and without it two peers can agree on a number while holding
different chains. Consider peers holding branches of one writer that diverged at
seq 30: one at 47, one at 40. Comparing frontiers, the first simply sends 41–47,
which the second rejects as a mismatched `prev` and cannot repair — its own
vector already claims 40, so it cannot ask for the other branch's 30–40, and the
first never learns a second branch exists at all. Both behave correctly and
diverge permanently. Comparing `(frontier, tip)` makes that case *detectable* in
the ordinary handshake, at the cost of one hash per writer.

Detecting it is not resolving it. §7.3 decides which branch wins, but only for a
peer that holds both in full, and asking for a branch you have already accounted
for needs a request the frontier cannot phrase. So reconciliation also needs a
way to say **"send me your chain for this writer from seq N, along your tip"**,
which is an ordinary range request with the tip named.

**Three separate needs point at the same extension**, which is the argument for
designing it once rather than three times:

| Need | What the vector cannot say |
|---|---|
| Fork detection and repair (§7.3) | which history a frontier is on |
| Held-but-not-applicable events | "I have 49, stop sending it" — see below |
| Compacted ranges (§9.2) | "gone, not missing" |

"Contiguous" is what forces the second. A peer holding writer A's 0–47 and also
49 reports 47, because reporting 49 would suppress the send of 48 — the one event
needed to unstall the chain. The cost is that it can then never say it already
holds 49, so 49 is re-sent every round. The wasted bandwidth is the small half;
the real cost is that under repeated gaps there is no way for a receiver to say
*stop sending that one*. Two extensions are plausible — an explicit held-set
alongside the frontier, or a bounded list of exceptions — and neither is designed.

**Decided: detect now, repair later.** The tip hash goes in the handshake, so a
fork is noticed in the ordinary exchange and can be reported. The *request* that
would fetch a competing branch is deliberately not designed yet, for two
reasons: a fork means the one-key-one-device constraint (§7.3) was already
violated, so it is not a routine event; and the same extension is wanted by two
other needs that are not yet understood. Designing it once, when all three are,
beats designing it three times.

**What detection must do meanwhile.** A peer that sees mismatched tips must say
so — the writer's chain is forked and will not converge. It must not silently
fail to sync, and it must not stall the rest of the space: a fork is confined to
one writer's chain, and every other writer reconciles normally.

**Where the repair belongs.** With compaction (§9.2), because that is the other
change to this vocabulary and the two share a shape: both need a peer to say
something about a range it cannot simply serve. Building either alone would mean
revising the wire format twice.

The substrate verifies three things and no others:

1. The signature is valid for the claimed writer key, over this space's key.
2. `prev` matches the hash of that writer's previous event.
3. `seq` follows contiguously.

It does not check whether an attribute exists, whether a value is sensible, or
whether the writer is permitted to say it. Those are decisions for higher layers,
and keeping them out is what allows a peer to replicate an application it does
not have — or a space it cannot read (Section 6).

### 2.4 Blobs

Large content does not travel in the log. A blob-kinded object's body holds the
SHA-256 hash of a blob, and the blob is fetched on demand from any peer that has
it.

- **Content-addressed** by full SHA-256 of the bytes **as stored and
  transferred**, so integrity is verified by rehashing the reassembly. Identical
  content deduplicates only where the encryption is deterministic, which is a
  choice §6 makes rather than a property that comes free.
- **Chunked** for transfer, with backpressure and resume from a chunk index.
- **Availability is advertised.** Version vectors describe events, never blobs.
  Peers exchange blob-availability sets so "who holds this content" is
  answerable when the original writer is long gone. That exchange is about the
  present moment rather than the space's history, so it travels on the ephemeral
  channel (§10) rather than in the log.

**Addressing is by ciphertext where a space is encrypted, and this is forced.**
The alternative — addressing by the plaintext hash — buys dedup across spaces
that share content, and costs the property §6 exists to provide: a peer without
the reading key could not verify a blob it stores and serves, because it cannot
rehash what it cannot decrypt. A store it cannot check is a store it can be fed
garbage into. So the hash is over what the peer actually holds, and the
consequence is accepted: **dedup happens within a reading key, not across
them.** Two spaces holding the same photo under different keys store it twice.

A per-space store follows from the same reasoning. A single store shared across
spaces, keyed by content, answers a request for bytes regardless of which space
the requester belongs to — so a peer learns whether this device holds given
content without being able to see the space that references it. That is a leak
of existence across a boundary the rest of the design takes seriously, and it is
easy to introduce by accident, because a single store is the obvious way to get
deduplication.

**Integrity is whole-blob only.** The reassembly is hashed before it is accepted;
there are no per-chunk hashes. A large transfer failing near its end is refetched
entirely. Per-chunk hashing is the obvious fix and is deliberately not specified
here, because the retry frequency that would justify its cost is unmeasured.

The asymmetry is deliberate: **events replicate to everyone, blobs are pulled by
whoever wants them.** Metadata is small and determines what you might want next,
so it is always complete; content is large and often unwanted.

The defensible form of that argument is about *nature*, not size. Blobs are
immutable and content-addressed, so they have no history — the hash is the whole
of their identity and there is nothing to order or merge. Putting them in an
append-only log would store them in a structure whose purpose is sequencing
things that have none. Events are the opposite. The size difference is real but
incidental, and it expires the moment any body rule produces high-frequency
events.

### 2.5 A permanently missing event

Events after a gap are held aside and never applied, and the request for the
missing range retries indefinitely. There is no timeout and no resolution: if an
event is genuinely gone — its only holder left forever — that writer's chain
stalls at the gap permanently, and every event after it is held but unusable.

**Stalling loudly is the deliberate choice.** The alternative is applying a chain
with a hole in it, which forfeits the guarantee the chain exists to provide: that
a writer's history is exactly what that writer wrote. A peer cannot tell a
fabricated gap from an honest one, so treating gaps as skippable would let any
peer suppress history by withholding one event.

But it means **the protocol cannot distinguish "missing, in flight" from "gone
forever"**, and those want different behaviour: the first is waited on, the
second is reported to a user. Making that distinction expressible needs a way for
a peer to say a range is unavailable rather than merely absent — which is the
same wire concept compaction would need (§9), and a reason to design the two
together if either is built.

**Open**, and the mesh reduces its urgency without removing it: any peer holding
the missing event can fill the gap, so it takes the permanent loss of every
holder rather than one departure.

**A forked chain is a different problem with a different answer.** Both show up
as a `prev` that does not match, so they are easy to conflate. A gap is an event
nobody can supply — there is nothing to choose between, only something absent, so
waiting is the only correct behaviour. A fork is two events competing for one
position, where the material for a decision is entirely present, so a rule
decides and the fold proceeds (§7.3). Absence waits; contradiction resolves.

---

## 3. The fold — **Decided. The central bet.**

The fold turns a set of events into state. There is exactly one fold algorithm,
it is identical in every client, and no application supplies its own.

**Every layer above this one depends on it.** A filesystem, a chat and a
co-edited document all fold in one space, with one kernel containing no
per-application code, and any set of events converges to the same state under
every arrival order. What is not settled is whether the vocabulary of rules stays
small under pressure, which §3.8 explains is the way this fails.

**The shape in one paragraph.** State is a tree of objects. Each object has
attributes, which always merge the same way, and a **body**, which merges by a
rule the object names. A file's body is a blob hash; a document's body is a
sequence of characters two people can edit at once; a folder has no body at all,
and a chat is a folder whose children are messages. Objects of every kind sit
side by side in one space.

### 3.1 The log is a set of slices

Every event names a **slice**: the bag of events it belongs to. The fold
partitions the log by slice key, applies each slice's **merge rule** to its bag,
and collects the results. That is the whole algorithm. It never inspects a
payload; only a rule does that.

Slices are keyed in three tiers, and the tiering is what makes the fold
well-defined:

```
root                    fixed rule · space key only     writer set, view hint
(object, :attribute)    fixed rule · LWW register       structure, names, :kind
(object, :body)         rule named by that object's :kind
```

Each tier is foldable knowing only the tiers above it, so the fold runs in
phases with no fixed point to find:

1. **The root.** Admitted on a signature from the space key alone (§7.2.1), so
   this consults no prior state. Yields the writer set and the space's own
   attributes.
2. **Attribute slices.** Each attribute name has one fixed, universally known
   rule — `:name` and `:parent` are registers, `:deleted` is a flag — so no
   declaration is consulted to fold them. That is what makes this the layer that
   bootstraps the next. Yields the object tree, names, and each object's `:kind`.
3. **Body slices.** Each folded by the rule its object's `:kind` names.

Phase 2 is the load-bearing one. Because the attribute vocabulary is fixed and
declares nothing, **a client can always fold the structure of a space** — what
objects exist, what they are called, where they sit, what kind of thing each one
is — regardless of what the bodies turn out to be or whether it can read them.

### 3.2 Two kinds of rule, and only one of them varies

| | Attribute slices | Body slices |
|---|---|---|
| Rule | fixed per attribute name | named by `:kind` |
| Declared? | no — known to every client | yes |
| Holds | structure: `:parent`, `:name`, `:kind`, `:deleted` | the thing itself |
| A client that cannot fold it | cannot happen | shows the object, cannot read it |

The merge-rule vocabulary is therefore a vocabulary of **body** rules:

| Merge rule | A body of this kind is |
|---|---|
| **Blob** | a hash; the bytes are fetched separately (§2.4) |
| **Register** | one value, highest `(lamport, writer)` wins |
| **Counter** | a sum of per-writer counts |
| **OR-set** | a set, add/remove tagged causally; concurrent add wins |
| **Sequence** | an ordered list of positional identifiers |

All five are published CRDTs with proofs behind them. The sequence strains this
contract hardest, and §3.8 says why it fits and what would not.

**Where a rule needs causality, it carries its own.** §7.2.3 declines to put a
causal dependency in the envelope, and that stands — but an OR-set needs to know
which adds a remove observed, and a sequence needs to know what an insert was
anchored to. Both put that information *in the value*, where it is the rule's
business and no one else's. The cost is that such values grow with the history a
writer had seen, and that their canonical form (§3.6) has to pin how those tags
serialise. The benefit is that the substrate stays free of ordering it would
otherwise have to carry for every event, including the vast majority that need
none.

**Blob is the degenerate member, not a special case.** An object whose `:kind` is
`image/png` has a body slice folding to a hash, and the bytes travel by §2.4's
separate path. Large content therefore needs no mechanism of its own — it is
the simplest rule in the vocabulary.

**A rule is two things, and they are usable independently.** Each supplies:

1. **A codec** — how to read and write the values in its slice, with a canonical
   serialisation, because §9 hashes fold output.
2. **A merge** — how to combine a bag of those values into one result.

Splitting them costs nothing and buys legibility. A tool holding a rule's codec
can decode every value in that slice without folding anything, so an inspector
shows what a log actually says rather than a column of opaque bytes — and it does
so for any rule it has, not just the ones it can merge. The two halves have
different obligations anyway: the codec is what §3.6 pins, the merge is what must
be a join-semilattice.

**Values are otherwise opaque to everything above the rule.** The substrate never
reads one (§2), and the fold kernel routes bags without inspecting their contents.
Only the rule's own codec gives a value meaning — which is what keeps §2's
payload-blindness structural rather than a convention that something will
eventually break.

**A rule also needs a stable identifier**, since two clients disagreeing about
what `sequence` means is unrecoverable.

**`:deleted` is a flag, not a register, and the difference is instructive.** It
resolves as: deleted iff the greatest `true` in its bag beats the greatest
`false`. That is still a pure function of one bag — undeletion is an explicit
`false`, not an inference from activity elsewhere — and it is deliberately *not*
"a delete loses to any later write anywhere on the object". Such a rule would
have to read the object's other slices, breaking §3.3's one-bag contract, and it
would make an unrelated body write silently revive a deleted object.

The tempting shortcut is worse still: clearing the tombstone incrementally when a
later write arrives is order-dependent, and it passes casual testing. A rule that
looks like a register and is not is exactly the kind of error a fixed vocabulary
exists to prevent.

**The property every rule must have** is not merely that it is a pure function of
a set — that is true by construction, since a rule takes a bag, and it buys
order-independence for free. What §9.1 and any incremental fold need is stronger:

> `fold(fold(S₁), S₂)` = `fold(S₁ ∪ S₂)`

That is, folding a partial bag and then folding the rest onto that result must
give the same answer as folding everything at once. It is what lets a peer keep a
running result and add events as they arrive rather than replaying from empty,
and it is what makes a snapshot a legitimate starting point rather than a lossy
summary. §3.7 is this requirement seen from one side: it holds only if the fold's
output keeps the comparison keys, so a late arrival can still be resolved against
it.

This is a real obligation and a rule can fail it, which is why it is stated
rather than assumed. Each of the rules in the vocabulary satisfies it by being a
join-semilattice — merging is commutative, associative and idempotent — so
order-independence is *structural*, a consequence of the algebra rather than a
property maintained by care.

### 3.3 One body slice per object; collections are objects

An object has many attribute slices and **exactly one** body slice. Structure
that would want several comes from objects, not from slots:

- **A collection of independent things** — a folder of files, a chat of
  messages, a canvas of shapes — is a parent object with children, each child
  carrying its own body. Two people posting to a chat, or dragging different
  shapes, never share a bag, so they never contend.
- **Structure within one thing** — the blocks of a document that can merge and
  split, text with comments anchored into it — belongs in a *single* body
  slice, folded by a single rule that understands the whole of it.

The line between them is whether operations cross. Merging two paragraphs is an
operation spanning both, so paragraphs that can merge are one slice; messages in
a chat never combine, so they are separate objects. **Where operations do not
cross, slice; where they do, do not.**

That rule falls out of the contract rather than being imposed on it. A rule sees
one bag, so a resolution needing two bags cannot be expressed — there is nowhere
to put it. Splitting genuinely coupled state across slices would not merely be
inelegant; it would silently produce wrong results, because each rule would fold
correctly in ignorance of the other.

The consequence for structured documents is that their rule is **large** — one
rule handling nesting, ordering and its own internal schema. That is the cost,
and §3.8 treats it as the main risk to the vocabulary staying small. What
contains it is the tiering: large rules live at the leaves, where failing to
fold one means failing to read one object.

### 3.4 Totality, and why damage stays in one slice

Every event set folds to *something*. There is no such thing as a log that
cannot be folded:

- An event referencing an unknown object yields an object with that one
  attribute set.
- A `:parent` cycle is broken at fold time by a deterministic rule (the smallest
  UUID in the cycle is re-parented to the root), and the resolution is
  fold-local — never written back as an event. This is the one part of the fold
  that is *not* per-slice: it reads every resolved `:parent` at once, because a
  cycle is a property of the graph rather than of any one bag. It runs after
  phase 2 and before anything uses the tree, and it means a single `:parent`
  write can change which object gets re-parented — so an incremental fold must
  treat the parent graph as one unit even though everything else is bag-local.
- A body slice whose rule a client does not recognise is left unresolved,
  and every other slice folds normally.
- An event a rule cannot yet apply — a sequence insert whose anchor has not
  arrived — is **pending**: held, not discarded, folded when the anchor does.
  The rest of that slice still resolves.

**Slicing is what makes totality real rather than nominal.** A single
undifferentiated fold would have to answer "what does this log mean" as one
question, so one unrecognised rule or one missing anchor would take the space
down. Because damage is confined to a bag, the worst case is one object that
cannot be read inside a space that is otherwise entirely correct — which is the
normal condition in a network where peers come and go, and the same outcome §4
already describes for a space whose view is missing.

This is the argument for slicing. Independent resolution of concurrent writes is
a property of the merge rules, not of the partitioning, and incremental folding
is an efficiency. Containment is the structural benefit.

### 3.5 The root

Every space has a root object, materialised by the fold rather than stored
specially. Attributes on the root are therefore **space-level attributes**, and
no separate concept of space metadata is required.

The root carries the space's writer set
(Section 7), a suggested name, and any resolution hints (Section 5.3). It is the
one slice whose events are admitted on a signature alone (§7.2.1), which is what
lets phase 1 of the fold consult nothing.

### 3.6 Determinism

The fold is a pure function from an event set to state, with no clock, no
randomness, no I/O and no dependence on arrival order. Two clients holding the
same events produce not merely equivalent state but **byte-identical serialised
state**.

That is a strong requirement and it is deliberate: Section 9 depends on being
able to hash the fold output and have two peers agree on the hash.

**It is also stronger than it looks, and it is a specification of its own.**
Order-independence gives agreement about *state*; it does not give agreement
about *bytes*. Every merge rule carries internal metadata — an OR-set's causal
tags, a sequence's position identifiers, a counter's per-writer map — and that
metadata has representation freedom. Two correct implementations can agree
exactly on an OR-set's live members and disagree on which tombstoned tags they
still carry, or on the order those tags serialise in. They then hash differently
while being in every observable sense identical.

Two rules follow, and they should be written before any merge rule is coded:

1. **Canonical form is specified per merge rule**, not once globally. A rule is
   not finished until its serialisation is pinned, including the metadata a
   reader never sees.
2. **Hash the observable state, not the representation** — wherever the two can
   be separated. What must agree is what the state *is*; internal bookkeeping
   that no reader can distinguish should not be able to fork a hash.
3. **No floating point anywhere in a hashed position.** §2.1 already bans it from
   the event encoding, and hashing fold output extends the ban to every value a
   rule can produce. Canvas coordinates are how this arrives in practice; they
   are fixed-point integers for exactly this reason.

### 3.7 Snapshot the accumulator, not the rendered state

The fold's internal accumulator carries, per attribute, both the resolved value
and the key that won it. The state handed to a view drops the keys — a view has
no use for them.

**Anything that persists or transmits fold output must keep the keys.** A
snapshot of the rendered state is lossy: an event arriving later with an earlier
comparison key cannot be resolved against it, because the winning key it would
have to beat is gone. A snapshot of the accumulator merges late arrivals by the
same maxima the fold already uses, with no special case at the boundary.

This is cheap to preserve and expensive to retrofit, and it is easy to get wrong
because the rendered state is the obvious thing to serialise. The accumulator
must stay reachable from outside the fold.

---

### 3.8 Where the universal fold could fail — **Open**

The claim is that one algorithm plus a small vocabulary of body rules covers the
interesting applications. It is falsified not by an application being awkward but
by the vocabulary having to grow without bound, or by a rule having to see more
than its own slice. Three pressures, in decreasing order of how well understood
they are.

**The vocabulary may not stay small — the live risk.** §3.3 concedes that a
document whose blocks merge and split needs one large rule, because the
operations cross what would otherwise be slice boundaries. One such rule is a
cost. A vocabulary of them is the failure: at that point "merge rule" means
"arbitrary code with private state", and the distinction between shipping a view
and shipping a fold — which §8.1's entire security argument rests on — has
quietly gone.

The discipline that keeps this honest is that **a rule must be justified by an
algebra rather than by an application wanting it.** Register, counter, OR-set,
sequence: each is one published algorithm with a proof that it is a
join-semilattice. "Rich text document format" is not.

**Sequences strain the contract more than any other rule, and fit it.** A
sequence carries state no other rule needs: position identifiers allocated
relative to neighbours, and tombstones that must outlive the content they marked,
because a concurrent insert may still anchor to a deleted element. Three
properties make it fit — element identifiers derive from `(writer, seq)`, so a
missing anchor is an ordinary chain gap; tombstones live in the rule's own fold
output, which §3.7 requires of every rule anyway; and an insert whose anchor has
not arrived is pending rather than fatal (§3.4). Its signature is the register's:
one bag in, one value out. This matters because **without a sequence rule there
is no collaborative text and no spatial canvas.**

**High-frequency editing may not want a log at all.** Body rules suit state that
changes at human speed. Keystroke-granularity editing produces events faster than
any of this is designed for, and the natural remedy — let the editing session run
its own protocol and write occasional checkpoints into the log — has a cost worth
naming: **a checkpoint of concurrently edited state blurs authorship.** Whoever
signs it attests "I observed this state", not "I wrote this", and intermediate
history is not recoverable. For a design whose signing story is provenance
(§5.1), that is a real downgrade rather than an implementation detail.

**What is not at risk.** The tiering (§3.1) means none of the above can cost a
client the *structure* of a space. Attribute rules are fixed per attribute name
and declare nothing, so the tree, the names and each object's `:kind` fold
identically everywhere regardless of what the bodies turn out to be. The failure
mode of a missing or unworkable body rule is one object that cannot be read — the same
outcome §4 describes for a missing view, and a much smaller one than a fold that
cannot run.

**A boring application tests this better than an exciting one.** A chat is nearly
the degenerate case: a folder whose children are messages, each message's body an
ordinary register, no interleaving and no new rule. If something that simple
needs a rule the vocabulary cannot express, the bet is lost at the easy end and
lost early. A spatial canvas would answer the same question much later and much
more expensively.

---

### 3.9 How blobs are referenced — **Open**

An object whose body is a blob holds a hash, and the bytes travel by §2.4's
separate path. That much is settled and built. What is not settled is how a blob
reference is *expressed*, and there are two shapes with different consequences:

- **A body rule.** `:kind` distinguishes blob-backed bodies from log-backed
  ones, and the blob rule folds to a hash. Simple, and it keeps everything about
  an object's body in one place. This is what §3.2 assumes.
- **A value encoding.** Any slice's value may be a blob hash rather than an
  inline value, independently of what kind the object is.

**The case that decides it is snapshots.** A snapshot of a log-backed body
(§9.1) is itself a content-addressed blob, fetched on demand, belonging to an
object whose body is emphatically *not* a blob. So "is this body a blob" and "is
this value stored out of line" are two different questions, and a design that
answers them with one mechanism will have to separate them again. That argues
for the second shape without settling it.

**`:kind` is overloaded in the same way** (§4.2): a media type there names the
blob rule *and* tells a view what the bytes are. Those are also two questions,
and they want separating at the same time as this one.

Left open deliberately. It is a small decision that wants to be made against a
real implementation rather than in advance, and nothing above depends on which
way it goes.

---

## 4. Objects, kinds and views — **Decided in shape, Open in detail**

§3 established that an object's body is a slice folded by a rule the object
names. This section says what that leaves for a space to declare, and where
application code fits.

### 4.1 There is one structural model, and it is a filesystem

Every attribute merges by a fixed rule that every client knows (§3.2). Every
space therefore has the same structure — objects in a `:parent` tree, carrying
names and kinds — and a client needs no declaration from anyone to compute it.

That structure is a filesystem, and it is the *only* structure. A chat is not a
different kind of space; it is a folder whose children are messages. A
collaborative document is not a different kind of space; it is an object whose
body folds by the sequence rule. Both sit in the same tree as ordinary files,
and the same client folds all of them.

**So the filesystem is not a built-in application. It is the shape of state, and
what varies is only what an individual object's body means.** Three things follow
that are worth having:

- **There is no type negotiation.** A space does not announce what it is, and a
  client does not have to understand a space before it can fold it.
- **There is no schema to distribute or version.** The one thing a fold needs to
  know beyond the events — which rule a body uses — is an ordinary attribute on
  the object itself.
- **Mixed spaces are ordinary.** A folder holding a spreadsheet, a conversation
  and a photograph needs nothing special; those are three objects with three
  kinds.

### 4.2 What an object declares

Each object carries a `:kind` naming the rule for its body:

| `:kind` | Body is | |
|---|---|---|
| a media type — `image/png`, `text/plain` | a blob hash; bytes travel by §2.4 | proven |
| `register` | one value, last writer wins | proven |
| `sequence` | an ordered list, concurrently editable | decided |
| absent | no body; the object is a folder or a pure node | — |

Two things follow, and they are what make this cheap:

- **`:kind` is an ordinary attribute**, folded in phase 2 by the same fixed rule
  as `:name` and `:parent`. It needs no special handling and cannot be
  circular, because the declaration is in a different slice from the thing it
  describes (§3.1).
- **`:kind` is set once and not changed.** Changing what a thing *is* would mean
  reinterpreting a bag of events under a different rule, which has no sensible
  answer. Making a different kind of thing means making a new object. This is a
  one-line rule, and it is what keeps the phase ordering honest.

**A media type in `:kind` is doing two jobs** — naming the blob rule *and* saying
what the bytes are, so a view can choose how to draw them. That is the same
overloading §3.9 flags in the blob reference, and it wants resolving at the
same time.

### 4.3 Views, and what a space declares

A **view** draws folded state. It is the only application-specific layer and the
only code that ships (§8).

The root declares the writer set (§7), a suggested name, resolution hints
(§5.3), and optionally a **view hint**: which view this space would like to be
opened with. The hint is advisory in the strongest sense — a client that ignores
it folds the space correctly anyway, because folding consults no declaration
(§3.1).

What follows:

- **A peer can replicate any space.** Signatures, chains and version vectors do
  not read payloads.
- **A peer can fold the structure of any space, unconditionally.** No
  declaration is consulted to get the tree, the names and each object's `:kind`.
- **A peer can fold any body whose rule it has**, and so can verify, snapshot
  and compact it.
- **A peer lacking a rule loses one object, not the space.** It shows the object,
  with correct name and place, and reports the body unreadable (§3.4).
- **A peer lacking a view can only refuse to draw**, explicitly rather than
  approximately.
- **None of this is permission.** What the bytes mean is unrelated to who may
  write them, which is §7.

**A view never supplies a fold.** If an application appears to need one, the
correct response is to add a rule to the shared vocabulary — and §3.8 is the
argument for why that vocabulary must stay small, and what it costs if it does
not.

### 4.4 Why spaces are small and numerous

One space could hold everything, and does not, because **permission is per space
and covers all of it** (§7.1). Anything wanting its own audience or its own set
of writers must be its own space.

That is the whole of the argument. A conversation is usually its own space not
because a chat is a different kind of log — it is not — but because the people in
it are rarely exactly the people who can see the folder it would otherwise sit
in. Links (§5.7) are what keep that liveable: a space split for permission
reasons is referenced from what it was split from, and following the reference is
ordinary navigation.

---

## 5. Identity, addressing and connection — **Proven**

Identity, locators, share links, the derived short code and trust-on-first-use
are implemented and working. Resolution (§5.3) is the exception and is marked
where it starts.

Three concerns that are commonly fused, kept separate:

| Layer | What it is | How often it changes |
|---|---|---|
| **Identity** | an Ed25519 public key | never |
| **Location** | who claims to serve this space right now | constantly |
| **Handle** | a human-readable name | per person, privately |

### 5.1 A space is a keypair

**A space's identity is an Ed25519 public key.** Holding the corresponding
private key is what makes someone a writer.

Consequences fall out at once:

- **Read-only is arithmetic, not convention.** A peer without the private key
  cannot produce a valid signature.
- **A fork is honestly a different space** — a different key, no collision, no
  ambiguity about which is which.
- **Links are verifiable.** A reference to a space names a key, so what you
  receive either verifies against it or does not.
- **Copying is not a threat model.** Anyone can copy a space and re-share it.
  What signing protects is not access to content but the *identity* of a space:
  the ability to tell the original from a fork, and to prevent someone else
  claiming to be it.

Signing's job is **provenance, not permissions**. It answers "is this space who
it says it is" — not "may this person read it".

**Private keys must be extractable, and this is not the obvious choice.** The
tempting alternative is a non-extractable key held by the platform, on the
grounds that injected script could not then steal it. That does not survive
inspection: a non-extractable key can still be *used* by injected script to sign
anything it likes. It is not protected, only unstealable — an attacker's forgery
lasts as long as their code execution rather than forever. Meanwhile the cost is
total: no backup, and no way to move an identity between devices.

The defences that actually work are the ones that stop script executing at all —
content security policy, dependency discipline, and rendering peer-supplied
content in a sandbox with no access to the host. That last one is a real
constraint on §8, not an optimisation, because rendering data from strangers is
the whole job.

### 5.1.1 Key loss is the largest practical risk — **Open**

If identity is a keypair in browser storage, then clearing site data destroys
the ability to write to your own space permanently, with no recovery and no way
to tell readers what happened. Some browsers evict storage for sites without
recent interaction on the order of a week, which makes this routine rather than
an edge case. A fork is honestly a different space (above), so a replacement key
is a different space wearing the old one's name — the property that makes forks
clean is the same one that makes key loss unrecoverable.

Detection is possible in one place and should be taken: **a space whose private
key is missing opens read-only rather than minting a replacement**, because
silently minting one would present a new space as the old one.

The answer beyond that is not chosen. The candidates are an explicit export the
user is prompted to keep, escrow with someone or something, multi-device
enrolment where several keys are writers on one space, or an honest stance that
identities are cheap and disposable and nothing is expected to outlive its key.
These have very different products attached, which is why this is Open rather
than merely unbuilt. **It is the single most likely way an ordinary person loses
something irreplaceable here**, and comparable systems consistently find it is
where non-technical users fall off.

**Whatever answer is chosen must not resolve this by putting one key on two
devices.** That looks like the obvious fix for both backup and multi-device use,
and it is the one approach the design will not reward: two devices holding one
key fork that writer's chain, and §7.3's resolution — deterministic, but lossy —
drops one branch's writes. Multi-device enrolment is therefore *several keys,
each on one device, all in the writer set*, which the permission model already
supports. Backup is a different problem and wants a different answer: a key held
offline and restored only once the original is gone, never used in parallel with
it.

### 5.2 Locators are separate, plural and disposable

Identity says *what* a space is. A **locator** says where it can be reached right
now. They are different kinds of thing with different lifetimes:

```
Identity     an Ed25519 public key                      never changes
   ↓ resolve
Locator      { ws } | { via, peer }                     many, changing, expiring
   ↓ dial
Transport    WebSocket direct | WebRTC via signalling
```

There are two locator shapes, and both are flat — a locator is never expressed
in terms of another locator, so one learned third-hand is exactly as usable as
one learned directly:

| Shape | Means | Lifetime |
|---|---|---|
| `{ ws: <url> }` | Open a socket here. The endpoint *is* the peer. | long — a stable address |
| `{ via: <url>, peer: <session> }` | Signal through this server, ask for this session. | short — dies with the session |

Every locator carries a TTL set by whoever announced it, because only the
announcer knows its own volatility. Without expiry, a resolution table fills with
corpses and "resolve" degrades into "try forty dead addresses".

A space has zero or many locators at any moment and none of them is part of its
identity. Changing transport, or replacing the signalling infrastructure
entirely, invalidates no address anyone has ever shared.

### 5.3 Resolution — **Decided, not built**

Resolution answers one question: **given a public key, produce candidate
locators.** It is a lookup, not an authority.

**Because verification is against the key, a resolver cannot lie in any way that
matters.** A wrong or hostile answer makes you *dial* something; it cannot make
you *believe* something, because what answers either produces validly signed
events for that key or does not. The cost of a bad answer is a wasted connection
attempt, bounded by a dial timeout and a cap on how many entries any one peer may
contribute.

That single property is what allows resolution to be casual. It works by two
halves of one mechanism:

- **Announce (push).** A peer that starts serving a space tells the peers it is
  already connected to, and re-announces on reconnect. Availability is maintained
  by the same traffic that does the work — no crawl, no polling. A peer that
  stops announcing is gone within one TTL, which makes serving a genuine opt-in
  rather than a commitment that cannot be withdrawn.
- **Query (pull).** A peer that arrived after an announcement, or is following a
  link to a space nobody has mentioned, asks connected peers directly. Several
  are asked in parallel and the answers are merged rather than taken from the
  first responder.

Both halves travel on the ephemeral channel (§10), for the same reason a locator
carries an expiry: they state where something is *now*, and nothing about them
should outlive the moment.

A peer answers for what it serves and for what it has learned from peers it is
**currently connected to** — one hop, no transit. At one hop, every entry is
about a live connection, so the answering peer has recent evidence. Relayed-of-
relayed entries are ones nobody in the chain can vouch for.

An empty answer distinguishes three cases, because they call for different
behaviour: *I do not track this space* (stop asking this peer), *I track it and
nobody is serving, last seen at T* (ask elsewhere, and tell the user something
true), and *here are locators* (dial them).

**Where locators come from.** A client collates a list in preference order:

1. **The space's own declaration** — a signed list on the root of where the
   writers say it is served. Durable, replicated with the log, and still valid
   months later when every announcement has expired. Unavailable at first
   contact, because it lives in a log you do not have yet.
2. **The share link's hint** — the bootstrap case, and the only source that works
   before you know anybody.
3. **Cache** — locators for spaces opened before. First tried, first discarded:
   a cached locator is stale by default and must never be the reason a space is
   reported gone.
4. **Learned** — whatever peers announced or answered.
5. **A configured fallback resolver.**

Sources 1 and 2 are in tension in a way worth stating: **the best source is
unavailable exactly when it is most needed.** The space's own declaration is
durable and signed and still works months later — and it lives in a log you do
not have yet, so it can never serve first contact. The link hint is the reverse:
it is the only thing that works before you know anybody, and it is a guess made
by whoever wrote the link, at the moment they wrote it.

Hence the asymmetry about where hints belong. **A share link should carry a
locator hint; a link stored inside a space should not.** A share link is a
one-shot introduction whose staleness is recoverable by resharing it. A stored
link is data that outlives its target's hosting arrangements, and a rotted
address embedded there is worse than no address at all.

**Resolution knowledge travels along the link graph.** A link names a space and
carries no locator, deliberately. It does not need one: reaching a space that
contains a link generally means reaching what it points at, because the peers you
are already talking to are the ones who can say where the target is.

**Bootstrap is the one case none of this solves.** Every mechanism above moves
knowledge between peers who are already in contact. The very first contact with a
stranger's space needs one locator from outside the system, and that is the share
link. This is not a gap to be closed by better gossip — it is where the design
touches the world, and it is why the link hint is a primitive rather than
decoration.

**What stops resolution being abused.** Since a bad answer costs only a wasted
dial, the protections are all bounds rather than trust:

- **A dial timeout**, so a dead locator costs a known amount of time.
- **A cap on entries per space**, so one answer cannot be a flood.
- **A cap on entries per announcing peer** — the important one, because it is
  what stops a single peer crowding the real entry out of a list.
- **Nothing is authoritative.** Several peers are asked in parallel and answers
  merge; duplicate locators collapse, and the longest surviving expiry wins, so
  one peer's stale entry cannot shorten another's fresh one.

**The numbers are deliberately absent.** Timeout, both caps, and default expiry
are empirical, and choosing them from an armchair would give them a false
authority. They belong in a measurement against a real network.

**Two things remain genuinely open.** Whether answering a resolution query should
be obligatory — a peer that answers reveals which spaces it knows of, which is a
weak disclosure of what it holds. And whether the push side needs damping beyond
expiry: announcing only on connect and on change, and only for spaces actually
served, is the cheapest policy that works, but whether it is sufficient is a
question for observation rather than argument.

### 5.4 Sharing

A share link carries the key in the URL fragment, so it never reaches a server:

```
https://<app>/#k=<base32 public key>&n=<suggested name>&l=<locator hint>
```

There is also a short typeable code, derived as a prefix of the hash of the
public key. The code is **a rendezvous hint only** — never identity, never
authority. It is short enough to be guessable, which is precisely why nothing
depends on it: an impostor who claims a code can answer your call, but what they
serve will not verify against the key you actually want.

The two routes therefore have honestly different guarantees. **A link gives full
verification**; **a code gives a hint**. On first successful connection by either
route, the key is pinned against the handle used, and a later mismatch is a
blocking warning rather than a silent substitution — so a typed code is
spoofable at most once, and never for a space already known.

### 5.5 Names are private

There is no global namespace and no registry. Every peer names spaces for
itself; a share link may carry a *suggested* name, which the receiver is free to
accept or replace. Two people can call the same space different things, and two
different spaces can share a name without conflict.

### 5.6 Transport

Peers connect over WebRTC data channels, with a signalling server used only to
introduce them and a relay available when direct connection fails. Both are
infrastructure for *connection*, never for custody: they see encrypted transport
and hold nothing.

A peer may also serve over WebSockets at a stable address. Such a peer is not a
new kind of participant — it speaks the same protocol, holds the same logs and
serves the same blobs as a browser tab. It differs only in **reachability**: it
has a stable address, so it can be dialled directly and can introduce peers to
each other. There is no privileged server role to discipline, because there is no
privileged server role.

**Reachability is not the same question as runtime**, and conflating the two
leads to a wrong picture of what needs what:

| | Needs introduction? | Because |
|---|---|---|
| A peer at a stable address | no | anyone can dial it |
| A browser tab | yes | it cannot accept connections |
| A command-line peer behind NAT | yes | same reason as the browser |

WebRTC exists to solve one problem — *neither side can be dialled* — and a peer
that can be dialled does not have that problem. So a peer at a stable address
needs no signalling, no relay and no WebRTC, not because it is headless but
because it is reachable. A command-line peer on a laptop is headless and
unreachable, and needs exactly what a browser needs.

**What an unreachable peer can always do is dial outward.** That is enough to
participate fully: it syncs with any peer it can reach, holds the space, and
serves it to anything that dials *it*. What it cannot do is be found by someone
who only has its identity — which is what introduction is for.

That also gives two peers who cannot reach each other directly an option beyond a
blind relay: if both can reach the same always-on peer, they can sync through it
using the ordinary protocol, and it keeps a replica afterwards. A blind relay
carries ciphertext and retains nothing; syncing through a peer means that peer
holds the space. Where the space is encrypted (Section 6), it holds ciphertext
and the distinction largely disappears — which is the case that makes always-on
peers safe to use by default.

**Two practical constraints on the browser, which are not negotiable.** A secure
context is required: some browsers will not gather usable connection candidates
over plain HTTP, including a local network address, so testing across two devices
means serving over HTTPS rather than a development server on a LAN IP. And direct
connection frequently fails — phones on cellular networks mostly do, which is
ordinary carrier NAT rather than a fault — so a relay is assumed rather than
treated as a fallback for unusual cases.

**Signalling and transport must not be one dependency.** A library that offers
both will silently put its own framing, chunking and size limits underneath the
protocol, at which point measurements describe the library rather than the
network. Signalling is one job — introduce two peers, exchange connection details,
then leave the path — and the interface should be narrow enough that the
implementation behind it is replaceable without anything above it changing.

**Connection lifecycle is unspecified and is where the bugs will be.** The
reconciliation algorithm (§2.3) and the introduction mechanism (§5.3) are both
described; the state machine between them is not. It has to answer at least:
what happens when a peer connects while a sync is already in progress with it,
whether the same space may sync over two connections at once and what reconciles
the results if so, how a half-finished blob transfer resumes against a different
peer than it started with, and what a peer does with events received from a
connection that drops before the batch completes. None of this is architecturally
hard, and all of it is fiddly enough that it deserves its own design rather than
being discovered.

### 5.7 The network of spaces

A link is an ordinary attribute value naming a space, optionally an object
within it. A link is an ordinary attribute value, so the graph of spaces is
readable by any client that can fold — including one that holds no view.

An object with a link and no body is a portal. An object with both is a card:
a thumbnail that goes somewhere. Links inherit naming, placement and deletion
from whatever object carries them.

Links are one-directional and unlisted. Nobody can enumerate who links to them
without being told, exactly as on the early web.

---

## 6. Privacy and the reading key — **Decided in shape, Open in construction**

Identity is a public key, and it makes a space verifiable. It does not make a
space private: anything a peer can replicate, a peer could read.

Privacy is therefore a separate key. A space may have a **symmetric reading
key**, and where it does, event values and blob contents are encrypted under it.

**The construction is not specified here and must be before this is built.** What
the rest of this section says about *who can do what* holds under any competent
authenticated cipher; what follows is what a construction has to get right.

- **Nonces must never repeat under one key**, and a space is exactly the setting
  where they would: many writers encrypting independently, offline, with no
  coordination. Random nonces invite a birthday collision; a counter needs
  agreement nobody can reach. The envelope already carries a unique pair —
  `(writer, seq)` — which is unique by construction under §7.3's constraint and
  is the natural nonce input. **That dependency is load-bearing and easy to
  miss:** the pair is unique *because* one key has one chain. Any change that
  lets one identity hold two chains — per-process append points, say, which
  `APPEND-POINTS.md` traces — makes two writers produce the same nonce for
  different plaintexts under one key, which an authenticated cipher does not
  survive. The nonce input must gain whatever component distinguishes the
  chains, and this bullet must be revisited *before* §6 is built.
- **Encryption must be deterministic where deduplication is wanted.** §2.4 says
  identical content deduplicates; under a randomised scheme two writers adding
  the same file produce different ciphertexts and it does not, even within one
  space. Deriving a blob's key and nonce from its plaintext hash restores
  deduplication at a known cost: it reveals to anyone holding the key that two
  objects have identical content, and it permits a confirm-a-known-file attack
  by someone who can guess a candidate. That is a real trade and it should be
  made deliberately.
- **Keys should be derived, not used raw.** One reading key with separate derived
  subkeys for event values and blobs keeps the two domains apart.

**One key per space, covering all of it.** There is no per-object or per-subtree
encryption: holding the reading key means reading everything in the space, and
not holding it means reading none of it. Sharing part of a space with a
different audience is expressed by that part being a separate space
(Section 7.1).

```
Space key      Ed25519 keypair       identity   · public key names the space
                                                · private key authorises writes
Reading key    symmetric key         privacy    · decrypts values and blobs
                                                · optional; shared out of band
```

The reading key is distributed the same way the space is: **in the fragment of a
share link**, alongside the public key, where it never reaches a server.
Omitting it from a link produces a reference to a space the recipient can
replicate and verify but not read.

### 6.1 What a peer without the reading key can do

Almost everything except read. The substrate never interprets a value
(Section 2), so encryption costs it nothing:

| | Without the reading key |
|---|---|
| Store the log | **yes** |
| Verify signatures and chains | **yes** — signatures are over ciphertext |
| Replicate events to other peers | **yes** |
| Store and serve blobs | **yes** — content-addressed by ciphertext hash |
| Answer resolution queries | **yes** |
| Read any value | **no** |
| Fold structure (the object tree) | **yes** — attribute rules are fixed, not declared |
| Fold any body | **no** — a body's rule is named by an encrypted `:kind` |
| Fold into *meaningful* state | **no** — the shape resolves, the values do not |
| Write | **no** — that needs the private space key, separately |

Folding is the interesting case, and it splits. **Attribute slices fold over
ciphertext**: their rules are fixed per attribute name (§3.2), so a peer knows
which rule applies without reading anything, and each rule picks a winner by
`(lamport, writer)` without inspecting values. Such a peer therefore computes
*the shape* of the state — which objects exist, which attributes they carry,
which writes won — while knowing what none of it says.

**Body slices do not fold at all.** A body's rule is named by `:kind`, `:kind` is
an encrypted value, so a peer without the key cannot even determine which rule to
apply, let alone run it. This is deliberate: exempting `:kind` from encryption
would leak which objects are conversations, which are documents and which are
images, and would buy only the ability to fold bodies whose contents remain
meaningless.

In practice such a peer stores and serves rather than folding, because shape
without meaning is of no use to it. The point is that it *can* — nothing in
replication requires reading.

The consequence is the useful one: **a peer can be a complete, verifying,
useful replica of a space it cannot read.** Storage and readership are separate
concerns, and only the second requires trust.

### 6.2 What this makes possible

- **Always-on peers without custody.** A peer with a stable address can hold and
  serve a space, keeping it alive when everyone else is offline, while holding
  only ciphertext. It is infrastructure without being an audience.
- **Relaying without reading.** Two peers who cannot reach each other directly
  can sync through a third that holds the space. Where that third has no reading
  key, this is a relay that keeps a replica — better than a blind relay, which
  keeps nothing, and no worse in what it learns.
- **Sharing that separates hosting from readership.** Handing someone the space
  key asks them to help keep a space alive. Handing them the reading key too
  invites them in. These are genuinely different acts and the link format makes
  them different.

### 6.3 What it does not do

- **It is not partial.** There is no way to share half a space. A reader sees
  everything or nothing, and the only way to divide readership is to divide the
  space.
- **It is not access control.** A reading key cannot be revoked. Anyone who has
  ever held it holds it permanently, and can decrypt anything they have or later
  obtain that was encrypted under it. Restricting access after the fact requires
  a new key and re-encryption, which is a new space in all but name.
- **It does not hide structure.** A peer without the key still sees how many
  events exist, who wrote them, when, how large the blobs are, and how the space
  changes over time. Encrypted values conceal content, not activity.
- **It does not hide identity.** The space's public key is what peers ask for by
  name. Holding an encrypted space is not private in the sense of being secret;
  it is private in the sense of being unreadable.
- **It does not protect against a reader.** Anyone with the reading key can copy
  the plaintext and re-share it. This is true of every system where reading is
  possible, and worth stating because the rest of the design is careful about
  who can do what.

---

## 7. Writers and permission — **Decided**

A space may have many writers. The root declares the **writer set**: the public
keys admitted to the space.

There is a circularity lurking here — the rule that says which events count is
itself written by events — and §7.2 closes it with a single restriction on who
may write the root. That restriction is what makes this section Decided rather
than Open, and it is worth reading before the details, because everything else
here depends on it.

**The writer set is per space and applies to the whole of it.** There is no
per-object or per-attribute permission: a writer admitted to a space may write
anything in it. Sharing write access to part of a space is not expressed by
narrowing a permission — it is expressed by that part being a separate space
(Section 7.1).

Events signed by a key outside the set are still *replicated* — a peer cannot be
trusted to filter honestly, and refusing to carry them would let any relay
censor silently — but they are **not folded** into state. Validity is therefore a
local, deterministic computation over the log rather than a query to an
authority: two peers holding the same events agree on who may write, because the
answer is in the events.

The space's own key is the root of that authority, and — unusually — it does not
delegate it. Every statement about who may write is signed by the space key
itself, which is §7.2's whole mechanism.

### 7.1 The space is the unit of permission

Both keys are per space, and both apply to all of it:

| | Granularity | Governs |
|---|---|---|
| **Reading key** (Section 6) | whole space | who can read anything in it |
| **Writer set** | whole space | who can write anything in it |

Neither has a finer grain, and this is a deliberate limit rather than a stage on
the way to one. It means the two questions a person actually asks — *who can see
this?* and *who can change this?* — have exactly one answer per space, visible in
one place, with no possibility of a document whose permissions differ from the
folder it sits in.

The cost is that **wanting different sharing means wanting a different space.**
That sounds like a restriction and is closer to a design generator: it is what
makes spaces numerous and small rather than few and large, and it is why a
conversation, a document and a shared canvas are each a space in their own right
instead of objects inside one. A space is not a container that things live in.
It is the boundary around a set of things shared on the same terms.

Links are what make that liveable (Section 5.7). A space that must be split for
permission reasons is not severed from what it was split from — it is referenced
from it, and following the reference is ordinary navigation. Fine-grained
permission and coarse permission plus links reach similar places; the second is
far easier to reason about, because the boundary is something you can see and
name rather than a rule attached to an object somewhere inside.

### 7.2 The circularity, and how the root closes it — **Decided**

There is a circularity in the paragraphs above, and it has to be closed
explicitly or the design does not work.

The writer set lives on the root. The root is materialised by the fold. The fold
excludes events from writers outside the set. So: **to know who may write, fold
the log; to fold the log, know who may write.**

The general shape is *state the fold needs, held in the log the fold computes*.
Only the writer set has it. Nothing else the fold consults is declared: attribute
rules are fixed per attribute name (§3.2), and a body's rule is named by an
ordinary attribute on the object, which phase 2 has already resolved before any
body is folded (§3.1).

**The naive fix does not work.** The instinct is to fold twice: once ignoring
permission to read the writer set off the root, then again properly. But the
writer set is written by events, and those events are themselves subject to
permission. A stranger writes "I am a writer"; pass one ignores permission, so it
believes them; pass two admits everything they wrote. Anyone can join any space
by asserting that they may.

### 7.2.1 The rule: only the space key writes the root

**Events targeting the root object are admitted if and only if they are signed by
the space key itself. Events targeting anything else are admitted if and only if
their writer is in the writer set.**

This does not make the circularity cheaper to compute. It removes it. Root events
are *self-authorising* — admitting one is a signature check, never a lookup — so
the fold becomes two phases with no fixed point to find:

1. **Compute the root.** Sweep the log; take every root-targeted event signed by
   the space key; ignore everything else. Fold those. This consults no prior
   state, so nothing is self-referential. It yields the writer set and
   everything else the root carries.
2. **Fold the rest**, admitting an event iff its writer is in the set phase 1
   produced.

Phase 1 depends on nothing; phase 2 depends only on phase 1. The loop is gone,
and it is gone structurally rather than by convention.

Three consequences follow, and the second is the one that saves the most work:

- **No causal dependency is needed in the envelope.** The expensive part of the
  standard answer — every event carrying evidence of what its writer had already
  seen, which is a substrate change — is not required to close the loop. §7.2.3
  says what is given up instead.
- **The merge rule for the writer set stops being a hard choice.** The difficulty
  in reconciling concurrent membership edits comes from several people editing
  membership. Here there is one writer to the root, so a plain last-writer-wins
  register over the whole membership list is sufficient: the space key holder
  states who is in, and the most recent statement wins.
- **The authority story is legible.** "Whoever holds the space key decides who
  may write" is a sentence a person can be told, and it matches what people
  already expect of a group they administer.

**What it costs.** Authority over membership cannot be delegated, because
delegating it would mean folding a grant, which is the circularity again. One
party administers the space, and if they lose the space key the membership list
is frozen permanently — the space keeps working for its existing writers and can
never admit or remove another. That is a sharper consequence of key loss than
§5.1.1 otherwise describes. It also means the space key is an *operational* key
rather than one that can be created and locked away, since it is needed every
time membership changes.

### 7.2.2 Moderators hold their own keys, never the space key

The obvious way to have several administrators is to share the space key between
them. **It should not be done**, and the reason is more specific than shared
secrets being poor practice: two holders writing concurrently fork the one chain
that determines who may write. §7.3 resolves such a fork rather than leaving the
space stuck, so this is a silent loss of one administrator's changes rather than
a catastrophe — but it is a loss with no upside, since the shape below gets
several administrators without it.

The shape that works instead keeps the root single-writer:

- The **space key** has sole authority over the root, and therefore over who is a
  writer and who is a moderator. One holder, used rarely.
- **Moderators are ordinary writers**, holding their own keys, distinguished by
  an attribute in the membership list rather than by holding anything shared.
- **Moderator actions are ordinary events** — removing a member from a chat,
  pinning a message — targeting ordinary objects, signed by that moderator's own
  key, folded like anything else.

This costs one thing: a moderator action is not self-authorising the way a root
event is, so folding it means checking whether that writer was a moderator. That
check is against phase 1's output, which is already computed, and it is the same
shape as an ordinary write-permission check.

It buys two things worth having. No secret is ever shared, so §7.3's hazard never
arises. And every moderator action is **attributable to a person** rather than
being an anonymous act by the space — *Alice removed Bob* rather than *Bob was
removed* — which is better in a log whose whole purpose is provenance.

### 7.2.3 Revocation means "may no longer write", never "was never here"

A revoked writer's old events remain validly signed; signatures do not decay. So
"valid when written" and "valid now" are different predicates over the same log,
and the design must pick one.

**It picks *valid when written*, and this should be stated as a property rather
than apologised for.** Removing a writer stops their future writes. It does not
remove what they already wrote, and it cannot.

The alternative is unworkable here rather than merely unattractive. Under *valid
now*, a revocation retroactively unwrites history that peers have already folded
and shown to people. Worse, *when* a peer learns of the revocation determines
what it computes, so a peer that has not yet received the revocation disagrees
with one that has — and both are behaving correctly. With no authority to break
the tie, that is a permanent fork manufactured by the security mechanism itself.

**What this means concretely, using the case that motivates it.** Removing
someone from a chat:

| | |
|---|---|
| They can no longer post | **yes** — immediately, and every peer agrees, because the membership event is in the log |
| Their old messages remain | **yes** — and this is wanted; a conversation with one person's messages retroactively deleted is a worse artifact than one where they are visible |
| They can no longer read | **no** — see below |

The third row is not a permission question at all, and no rule in this section
touches it. Reading requires the reading key (§6), which a removed member already
holds and cannot be made to forget. They can go on replicating the space and
decrypting everything written after their removal.

**So removal is muting, not exclusion, and the interface must not imply
otherwise.** Genuinely ending someone's access means rotating the reading key and
re-encrypting, which §6.3 explains is a new space in all but name — and which
buys less than it appears to, since anyone who could read could also copy.

**One ambiguity remains, and it is accepted.** Because there is no causal
ordering between writers (§2.2), a write that is concurrent with the removal that
would have stopped it has no determined answer: peers may fold it either way
depending on what they hold, converging once they hold both events. In practice
this is a window of seconds around a removal, affecting whatever the removed
writer was in the middle of saying. Eliminating it means putting causality in the
envelope, and that price is not worth paying for this. **It would become worth
reconsidering if the reading key were ever derived from membership**, since "who
was a member at time T" would then determine what can be decrypted, and a few
seconds of ambiguity would stop being cosmetic.

### 7.3 Chain forks: one key, two devices — **Decided**

A private key is meant to be held by **one device at a time**. This section says
what happens when that is violated, because it will be, and because the answer
determines whether the violation is survivable.

**Two devices holding one key fork that writer's chain.** The mechanism is
§2.1's per-writer chain: each event carries `seq` and the hash of that writer's
previous event, which makes a writer's history a linked list with exactly one
tail. Two devices both believe they are at the same tail. Both write. The result
is **two different events at the same sequence number, with the same
predecessor, both validly signed.**

**Signing cannot catch it.** A forged event fails verification; this one does
not, because the key genuinely signed both. The two branches have identical
provenance, so nothing can adjudicate them *on authority* — there is no fact
about which one the writer "meant".

### 7.3.1 The resolution is deterministic, not fair

Identical provenance means no branch deserves to win. It does not mean no branch
can be *chosen*. What the network needs is not fairness but **convergence**: every
peer applying the same rule to the same event set must reach the same answer.
A rule that picks arbitrarily satisfies that; a rule that refuses to pick does
not.

**The rule: the longer branch wins. Ties break on the lowest event hash at the
first divergent sequence number.**

Both halves are total and computable from the event set alone, with no clock, no
arrival order and no authority — the same standard §3 holds the fold to. The
losing branch's events are **not folded**. They remain in the log, replicated and
signed, and a client can show them; they simply do not contribute to state.

Length is the primary rule for one reason worth stating: **it favours the branch
that kept being used.** The ordinary case of this failure is one device carrying
on while another sat stale with a few writes on it, and length resolves that the
way a person would want without anyone deciding. It is not a security property —
whoever writes more wins, and an adversary can always write more — it is a
heuristic that makes the common case land well and is harmless in the rest.

**First-seen must not be the rule**, though it is the intuitive one. It depends
on arrival order, so two peers holding the same events disagree permanently,
which is precisely the failure being avoided.

**Convergence here is eventual, not immediate, and that is worth being precise
about.** Length is a property of the events a peer holds, so a peer holding all
of one branch and half of the other will prefer differently from a peer holding
both in full. That is not the divergence first-seen produces: it is the ordinary
condition of a peer that has not finished syncing, it resolves as soon as both
branches are complete, and the answer it converges on is the same for everyone.
The requirement the rule must meet is that peers holding *the same events* agree,
and length meets it. A client should nonetheless treat a fork as unsettled while
either branch is still arriving, rather than presenting an early preference as
final.

### 7.3.2 Why a deterministic bad outcome beats a nondeterministic one

The alternative — refusing to resolve, treating a forked chain as an error state
— is worse in every case, including the adversarial one it appears to protect
against.

**Refusing does not protect the space.** Someone who holds the private key can
already write anything, and under §7.2.1 can rewrite the membership list. The
fork rule does not grant that power; it only decides what happens in the moment
two holders write at once. Withholding a decision leaves the space stalled
(§2.5) for everyone, the legitimate holder included, and with no way to say why.

So the trade is: **a thief may win control, or the space breaks for everybody.**
The first leaves an outcome and someone holding the space — which is something a
person can respond to, by forking, by telling people, by carrying on elsewhere.
The second leaves nothing.

This is a general preference and the design applies it elsewhere: §3.4 breaks
parent cycles by an arbitrary rule and says the rule is arbitrary, rather than
refusing to fold. **Prefer a deterministic bad outcome to a nondeterministic
one.** An arbitrary answer everyone shares is a working system; a principled
refusal is a broken one.

### 7.3.3 What it still costs

Resolution makes a fork survivable. It does not make it free.

- **The losing branch's writes are dropped from state.** Bounded to what one
  writer produced on one branch, and the events survive in the log — but it is
  data loss, and a client that hides it is lying to someone about their own work.
- **Under §7.2.1 a forked space key means a contested membership list.** The
  rule resolves it, so phase 1 of the fold still has exactly one answer, but the
  answer may be the branch the space's owner did not intend.
- **Sequence numbers are no longer a clean per-writer counter across the fork
  point.** The winning branch continues and the losing one is abandoned mid-run,
  so a naive reading of "how far is this writer" is misleading. The chain is
  intact along the surviving branch, which is what replication needs.

**Therefore detection matters more, not less.** A fork that resolves silently is
a fork nobody investigates, and the symptom — occasional writes that quietly
never appear — reads as a mysterious bug rather than as a key on two devices. Two
events at one sequence number with one predecessor is a cheap, checkable
condition, and a client that sees it should say so plainly.

### 7.3.4 The operational rule stands

Resolution changes the failure from *unrecoverable* to *deterministic and lossy*,
which is a large improvement and not a licence:

> **Export a key to move an identity, never to share one.**

Within a single device an exclusive lock per space is a complete fix — the first
context to open a space writes, later ones open read-only and say so. Across
devices nothing prevents a fork, because no lock spans devices without a
coordinator and a coordinator is the server this design does not have.

A second person who needs to write gets **their own key** and a place in the
writer set. A second person who needs to administer gets §7.2.2's moderator role.
A second *device* of the same person gets its own key too, enrolled alongside the
first. In none of these cases is sharing a key the right answer, and the reason
is now ordinary — it silently loses work — rather than catastrophic.

### 7.4 What remains open

The mechanism above is settled. Three smaller questions are not, and all are
answerable without disturbing it:

- **Membership as a whole-list register, or as add and remove operations.** A
  register is simplest and is the default assumed above, but it means one
  administrator editing membership from two contexts loses an edit entirely.
  Operations preserve both edits at the cost of needing their own merge
  semantics.
- **Whether admission can happen while the space key holder is offline.** Under
  §7.2.1 it cannot: no administrator present, no new writers. For a small group
  that is unremarkable; for anything invite-driven it is a real constraint, and
  the workaround — pre-authorising a batch of keys — is clumsy.
- **Whether moderator actions need their own attribute vocabulary** or are
  ordinary writes distinguished only by who signed them.

---

## 8. Applications are spaces — **Open**

The argument in §8.1 is sound and the consequence is real. What is unbuilt is all
of it, and §8.2 names the one channel that still has to be designed.

An application is an ordinary space whose objects are executable modules — blob
bodies with a media type, in a `:parent` tree, exactly like any other files. It
is signed, content-addressed, versioned and replicated by the same machinery as
everything else, because there is nothing else it could be.

A client is correspondingly thin. To open a space it:

1. Replicates the log and verifies the chains.
2. Folds it — structure unconditionally, bodies by the rules each object's
   `:kind` names (§3.1).
3. Reads the root's view hint, if it has one.
4. Resolves that hint to a code space and replicates it.
5. Runs that view against the folded state.

**Step 2 does not depend on steps 3 to 5.** A client can hold correct, verified,
compacted state for a space whose view it has never fetched, and can serve that
space to others. An always-on peer needs no application code at all — and note
that the fold needs no declaration to run, so this holds even for a space whose
root says nothing at all.

Applications therefore distribute over the same network as data — no store, no
CDN, no central registry — and are versioned and signed by construction, because
that is what a space already is.

### 8.1 Why foreign code is tolerable here

A view is code from a stranger, which is normally a serious problem. The layering
makes it a much smaller one.

**What a view structurally cannot do:**

- It cannot change what the log means. The fold ran before the view loaded.
- It cannot make peers disagree. Two clients with the same events compute the
  same state regardless of which view they run, or whether they run one at all.
- It cannot corrupt what is stored, replicated or compacted.
- It needs no ambient authority: it takes folded state in and produces drawing
  out. It does not need the network, the store, or the space's key.

A hostile view can therefore mislead **its own user**, in the ordinary ways
hostile interface code does. It cannot cause disagreement about state, which is
the failure class that would be unrecoverable in a system with no central
authority.

The remaining protections are conventional and effective because the surface is
narrow: code spaces are signed, so trusting an author is a real mechanism;
content addressing means a client can pin exactly the version it ran; and a view
executes against a constrained drawing interface rather than direct access to
the host.

### 8.2 The rendering boundary — **Decided in shape, Open in detail**

A view needs to draw a real interface and take real input, and it must do so
without acquiring the host's origin — because with the origin it has storage, the
network and the space's private key, which is exactly the ambient authority §8.1
claims it never needs.

The temptation is to design a description language: the view emits drawing
commands across a serialisation boundary and never touches a display directly.
That is a large piece of work — an isolated execution context, a wire format, and
a vocabulary rich enough to express an application — and it is not necessary,
because the platform already provides an isolation boundary with a rich interface
language on the far side of it.

**A view runs in a sandboxed, cross-origin frame under a strict content
policy.** That yields, without any of it being designed here:

- **Origin isolation.** The view cannot reach the host's storage or keys, because
  it is not on the host's origin. This is the property the whole section needs.
- **A complete interface language** — the document model — with no vocabulary to
  invent and no expressiveness ceiling to discover later.
- **Input as the platform's problem.** Focus, keyboard, pointer and accessibility
  are handled by the frame rather than tunnelled through a protocol.
- **No network of its own**, denied by policy rather than by omission.

What remains to be designed is one channel, and it is small: **the view proposes
writes and the host decides.** Proposals cross by message-passing; the host
validates them against the space's rules, signs with the user's key, and appends.
The view never holds the key and never appends directly. This is a genuine hole
in "needs no ambient authority" — but a narrow one, mediated, rate-limitable, and
attributable to the user rather than to the view.

**What this does not solve** is a view exfiltrating what it was shown. A view
rendering decrypted content can encode it and try to get it out; policy closes
the obvious routes, and §6.3 already concedes that anyone who can read can copy.
It is the same exposure a reader always has, not a new one the boundary
introduces.

**The favourable comparison holds.** Sandboxing a *fold* would have been this
problem plus a correctness requirement: a fold that escapes makes peers disagree
permanently, where a view that escapes harms only its own user. Moving the
boundary here converts an unrecoverable failure class into a recoverable one, and
the remaining work is one message channel rather than a platform.

---

## 9. Snapshots and compaction — **Decided in shape, Open in construction**

A log grows without bound. **The safe half of the remedy is easy and the
valuable half is unsolved**, and the two are separated below because conflating
them is what makes the problem look tractable when it is not.

The two halves are:

| | Keeps events? | Verifiable by a peer that lacks the events? |
|---|---|---|
| **Fast start** — skip the fold, keep the log | yes | does not need to be |
| **Compaction** — discard superseded events | **no** | **this is the problem** |

### 9.1 Fast start is safe and should be built first

A **snapshot** is the fold of every event up to a stated watermark — a version
vector naming, per writer, how far it covers. Because the fold is deterministic
and canonically encoded (§3.6), a peer holding those events verifies a snapshot
by recomputing it. Two peers who snapshot the same events produce byte-identical
output, so snapshots deduplicate like any other content and disagreement is
detectable rather than silent.

Used this way a snapshot is **purely a cache**: the events are all still there,
and the snapshot only saves the cost of re-folding them at startup. It can be
discarded at any time with no loss. Nothing in this paragraph needs a signature,
a trust decision, or a protocol change, and it captures most of the practical
benefit for a long time — the expensive thing at startup is folding a long log,
not storing it.

It requires one thing of §3, which is cheap now and awkward later: **the fold
must be able to start from a supplied state rather than only from empty.** A fold
of shape `fold(state, events)` costs nothing today over `fold(events)` and is the
seam everything else here needs. Note §3.7 — what gets snapshotted is the
accumulator, keys included, not the state a view sees.

### 9.2 Compaction is where the trust problem is

Discarding events is what actually bounds growth, and it breaks the verification
story completely:

> **Verification requires the events you were trying to discard.** A peer that
> recomputes a snapshot to check it does not need the snapshot. A peer that needs
> the snapshot — one that just arrived and holds nothing — cannot check it.

So "a snapshot needs no signature, because peers recompute it" is true only for
the peers who least need one. For a newcomer it degrades to trusting whoever
served it, and the lie is undetectable *and stays undetectable*, because the
events that would have exposed it are exactly what compaction deleted. In a
system with no central authority, that is the failure class worth being most
afraid of.

**Compaction also breaks the chain and the version vector**, which is a second
cost usually noticed later. Events are chained by `prev` and a missing one stalls
the chain (§2.5), so a peer asking for a compacted range waits forever for
something nobody will ever send. The protocol cannot distinguish *gone,
compacted* from *missing, in flight* — the same distinction §2.5 already wants —
so compaction needs a wire concept for "truncated here, start from this
snapshot". And a version vector stops answering its own question: after
truncation a peer knows the effect of events it can no longer serve, so knowledge
and retention become two different quantities where the vector expresses one.

**The safety rule that would normally save this is unimplementable here.** The
usual discipline is to never truncate below the frontier of any peer still being
served. That requires enumerating the peers being served, and a shared space is
deliberately uncontrollable and its readers unenumerable (§6.3). **You cannot
hold a floor for peers you cannot see.** Compaction here is therefore
unsafe-by-default in a way it is not in a system with a membership list.

### 9.3 Who may compact, and who vouches for it — **Decided**

The rule that makes a snapshot trustworthy without recomputation:

> **Only a writer may compact its own chain, and the resulting snapshot is signed
> by that writer.**

A snapshot then carries the same authority as any other assertion by that writer:
it is a signed checkpoint referencing the last event's hash, becoming a new
genesis for that chain. A newcomer who cannot recompute it can still verify *who
said it*, and that party is the only one who could have lied about their own
history anyway. Recomputation remains available to anyone holding the events, so
the checkpoint is verifiable-by-recomputation when possible and
attributable-by-signature when not.

Two things follow:

- **It is free under one writer per space** (§7.2's fallback) and awkward under
  many, where a space spans several chains each needing its own author's
  attestation — so a peer can only ever compact the part of the log it wrote, and
  a departed writer's chain can never be compacted by anyone.
- **A departed writer cannot compact their own chain**, which is the case
  compaction was most wanted for.

**The space key closes that case, and adds no new trust.** §7.2.1 already makes
the space key the sole authority over who may write, so every peer that accepts a
space at all has already accepted that key's word on what counts. Letting it
countersign a checkpoint over a departed writer's chain asks nothing further of
anyone: a newcomer trusting the membership list is trusting the same signature.

That checkpoint is not verifiable by recomputation for the peer that needs it —
but neither is a writer-signed one, so nothing is lost. What it costs is honest
and bounded:

- More work for a key §7.2.1 already describes as operational, and one more thing
  that stops being possible when it is lost.
- It attests *"this is the state that chain reached"*, not *"I wrote this"*. The
  space key is vouching for a fold it did not author, which is a weaker claim
  than a writer signing their own history — and the right one, since it is the
  only party with standing to make any claim at all about a writer who is gone.

The remaining alternatives — corroboration by independent peers agreeing on a
hash, or a structure letting a newcomer spot-check a snapshot against events it
does fetch — are real designs with their own failure modes, and are not needed if
the space key will sign.

**Even so, do not build compaction yet.** The trust question is answered; the
protocol work around it — a wire concept for "truncated here, start from this
snapshot" (§2.3), and a version vector that distinguishes knowledge from
retention — is not, and none of it is needed until logs are actually large. Build
§9.1, keep every event, and let logs grow. Two things make that runway longer than it sounds — blobs are already
outside the log, so growth tracks *number of edits* rather than content volume;
and coarse permission (§7.1) keeps spaces small by construction, since anything
shared on different terms is a different space. Whether that is enough is an
empirical question, and it should be answered by watching a real log grow rather
than by building the hard half in advance.

### 9.4 What is mechanical, once it is wanted

Two properties survive all of the above and are worth recording, because they
make the eventual work smaller than it looks.

**Reduction is per merge rule, not per application.** An LWW-register compacts to
one value, a counter to one total per writer, an OR-set to its live members. A
rule solved once is solved for every object that declares it, and a peer can
compact a space whose view it has never seen. This is the same property that
makes the fold universal, applied to the inverse operation.

**Encryption cuts across it partly, and the limit is worth being exact about.**
Attribute slices reduce fine without the reading key: their rules are fixed per
attribute name (§3.2), so a peer knows which rule applies without reading
anything, and each rule discards superseded events without knowing what they
said. **Body slices do not.** Reducing one means knowing its rule, its rule is
named by `:kind`, and `:kind` is an encrypted attribute value — so a
ciphertext-only peer cannot pick a rule and cannot reduce any body.

The alternative would be exempting `:kind` from encryption. That is not taken:
§6.3 already concedes encryption hides content rather than activity, but leaking
the kind of every object in a space is a real disclosure — it says which objects
are conversations, which are documents, which are images — and it buys only
compaction by peers who cannot read what they are compacting.

So: **a ciphertext-only peer stores, serves and verifies; it does not compact
bodies.** Compaction of a body is done by a peer holding the reading key, and the
snapshot it produces is ciphertext like everything else. Snapshots of an
encrypted space are themselves encrypted, because the property that makes one
trustworthy is that peers agree on its hash, and that requires comparing the same
representation.

---

## 10. The ephemeral channel — **Decided in shape, Open in detail**

A peer connection carries **three channels**, and they are distinguished by what
happens to a message after it is delivered.

| | Carries | Durability | Replicated to |
|---|---|---|---|
| **Log** | signed events | permanent | every peer, eventually |
| **Blobs** | content-addressed bytes | permanent, fetched on demand | whoever asks (§2.4) |
| **Ephemeral** | everything else | expires | only peers present at the time |

The first two are the system's memory. The third is its nervous system, and it
is one channel rather than several — which is worth stating plainly, because the
things it carries look unrelated until you notice they share every property that
matters:

- **Signalling** — introducing two peers so they can connect.
- **Resolution** — announcing what a peer serves, and asking where a space is
  (§5.3).
- **Availability** — which blobs a peer holds (§2.4).
- **Presence** — who is here, where their cursor is, what they are typing.

All four are *about the present moment*. None should survive everyone
disconnecting. None is replicated to a peer who was not there. And all four
would be actively wrong in the log: writing them there would make every cursor
movement and every stale address permanent, and would replicate a peer's
transient state to everyone who ever syncs the space.

**The distinction is durability, not importance.** A resolution announcement
matters a great deal; it is ephemeral because it describes where something is
*right now*, and an address that has rotted is worse than no address at all
(§5.3).

### 10.1 What it must provide

The channel is one protocol with one security story, and the primitives it needs
follow from the four uses above:

- **Send to one connected peer**, which signalling and blob availability need.
- **Send to all connected peers**, which announcement needs — bounded to peers
  already connected, never relayed further than one hop (§5.3).
- **Expiry**, since every message it carries is a claim about now. A message
  without a lifetime becomes a lie rather than merely stale.
- **Attribution**, where a message makes a claim another peer will act on.

### 10.2 Authentication — **Decided: the transport is enough**

Log events are signed; ephemeral messages are not. That looks like a gap and is
not, because of what the transport already provides and what these messages
actually claim.

**The transport authenticates the sender.** A data channel is encrypted and
tamper-proof end to end, so every message on an open connection demonstrably
came from the same party, unmodified. Nobody can inject into a channel they are
not on.

**And no ephemeral message is a claim you have to believe.** Each is either
about its own sender, or a hint whose truth is established by acting on it:

| | What it claims | How it is checked |
|---|---|---|
| **Presence** | where my cursor is | nothing depends on it; it expires |
| **Availability** | I hold these blobs | ask for one — a lie costs a failed fetch |
| **Signalling** | connect to this peer | the connection works or it does not, and the space key decides who answered |
| **Resolution** | space K is served there | dial it — what answers either produces validly signed events for that key or does not (§5.3) |

Signing would add attribution, not protection. A signed lie is still a lie; what
makes these messages safe is that believing one costs nothing but a wasted
attempt.

**The one asymmetry worth naming.** Resolution relays: an answer may carry what
a peer heard from *another* peer (§5.3, one hop). The channel authenticates that
the sender said it, and cannot establish that the third party ever did — so a
relayed announcement is indistinguishable from a fabricated one. That is
tolerable for the same reason the rest is: a bad answer costs a dial, bounded by
a timeout and a per-announcer cap, both of which §5.3 already requires. It is
worth knowing that this is the one message kind where the transport's guarantee
stops short of the claim being made.

**What is required instead of signing** is that ephemeral messages cannot be
confused with log events. They are never stored and never folded — a structural
property rather than a check — and §2.1's domain tag stays reserved for them.
Not because anything signs them today, but because the separation must already
exist if anything ever does.

**When to revisit.** If an ephemeral message ever becomes something acted on
expensively — a resolution answer that causes work rather than a dial, or a
presence claim that grants something — the calculation changes, because the cost
of believing a lie would no longer be bounded by a wasted attempt.

### 10.3 The cost, stated honestly

A second channel is a second protocol, a second security story, and a second
place for state to live. It earns that only because the alternative — presence,
gossip and addresses as permanent signed history — is clearly worse. Keeping it
to *one* channel rather than four is what stops that cost being paid repeatedly.

---

## 11. Summary of constraints

The design holds together only if these hold:

1. **The substrate never interprets a payload.** It moves and verifies bytes.
2. **The fold is universal, pure and deterministic.** One algorithm, driven by
   declarations, byte-identical output across clients.
3. **Structure is always foldable; only bodies vary.** The attribute vocabulary
   is fixed and known to every client, so any client can compute any space's
   tree, names and kinds without a declaration. That is what confines an unknown
   or unworkable body rule to one object.
4. **Every merge rule is a join-semilattice.** Order-independence comes from the
   algebra, not from discipline.
5. **Applications ship views, never folds.** The layer that ships is the layer
   that cannot cause disagreement.
6. **Identity is a key; location is a hint.** Anything that resolves a name is
   advisory, because what it returns is verified against the key.
7. **Storing is not reading.** Verification uses the public key; reading uses a
   separate symmetric key. A peer can be a complete replica of a space it cannot
   read, which is what allows infrastructure to exist without custody.
8. **The space is the unit of permission.** Both keys cover a whole space and
   nothing finer. Different terms mean a different space, which is what keeps
   spaces small and numerous.
9. **Only the space key writes the root.** This is what makes the rule that says
   which events count computable without already knowing the answer, and it is
   what keeps a causal dependency out of the envelope.
10. **A private key is held by one device at a time.** Two devices sharing a key
    fork that writer's chain. The fork resolves deterministically (§7.3) so peers
    still converge, but one branch's writes are dropped.
11. **Events are the truth; everything else is cache.** Snapshots, indexes and
    rendered state are all discardable and recomputable.

---

## 12. What is unresolved

The open questions and the build order they suggest are tracked in
**[OPEN.md](OPEN.md)**, which changes as questions close while this document
changes rarely. Two of them are load-bearing enough to name here:

- **Whether the vocabulary of body rules stays small** (§3.8). If it does not,
  "merge rule" becomes "arbitrary code with private state", and §8.1's argument
  for why foreign code is tolerable stops holding.
- **Reconciling forked chains** (§2.3). §7.3 decides which branch wins but the
  version vector cannot express that a fork exists, so peers can diverge without
  either noticing. A tip hash makes it detectable; repair needs a request the
  vocabulary does not have yet.

Everything else is either implementation-shaped — better answered with code in
front of you — or deferrable without cost.
