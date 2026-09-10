# Sequence numbers, equivocation, and what the literature says

**Status: findings, and the proposal they led to was taken.** Append points
(`APPEND-POINTS.md`) removed the one-key-one-device constraint this document
questions: a chain is keyed by `(writer, point)` and each process mints its own,
so two devices holding one key no longer collide. Quotations of §7.3 below are
of the text *as it then stood*, and are what the change was argued against. Nothing here recommends a change yet. It
records what a literature review turned up about a constraint we arrived at
independently, and what it would cost to relax it.

The question that prompted it: we want CRDT convergence *and* signing *and*
tamper-evidence, and we have been quietly sacrificing part of the first to get
the other two. One key may be used by one writer at a time. Is that necessary?

**The short answer: no, and the mechanism that forces it is the one the
literature says is unsafe anyway.** Whether to change it is a separate question
this document does not answer.

---

## 1. What we built, and where the constraint lives

An event carries `seq` (per-writer, dense, from 0) and `prev` (the hash of that
writer's previous event). Together they make each writer's history a linked list
with exactly one tail.

That is the whole constraint. Two processes holding one key both read the same
tail, both write at `seq = frontier + 1`, and produce **two different events at
one sequence number, both validly signed**. Signing cannot catch it: the key
genuinely signed both.

§7.3 already says this, and says it plainly — *"a private key is meant to be
held by one device at a time"* — then spends a section on resolving the fork
deterministically so the network converges anyway. §5's note on fork repair goes
further: a fork *"means the one-key-one-device constraint (§7.3) was already
violated, so it is not a routine event"*.

Everything downstream follows from that one sentence:

| consequence | why |
| --- | --- |
| the store lock | only one process may hold a space |
| the control API for writes | a second process must ask the first |
| a second protocol | asking is not converging |
| the CLI is not a peer | it commands rather than reconciles |
| §7.3's resolution | forks happen anyway, so one branch must lose |

We have spent two sessions designing around this, and the design kept getting
more elaborate rather than less. That is usually a sign the constraint is in the
wrong place.

## 2. The fold does not use `seq`

Checked directly, and it is the finding that makes everything else worth
considering:

- `fold.ts` and `incremental.ts` contain **no reference to `seq`**.
- Convergence runs on `(lamport, writer, id)` — `chain.ts:36`.
- `seq` and `prev` are consumed by `checkLink` (chain integrity) and by
  `versionVector`/`frontiersOf` (gap detection in sync).

So `seq` and `prev` serve two purposes, neither of which is convergence:

- **`prev` — tamper-evidence.** A hash chain: history cannot be rewritten
  undetected.
- **`seq` — dense integers for version vectors.** "I hold 0–47 contiguous" is
  compact only because positions are consecutive.

**The single-append-point constraint is a side effect of the second.** It buys
gap detection. It was never required by the CRDT.

## 3. What the literature calls this

Kleppmann, *Making CRDTs Byzantine Fault Tolerant* (PaPoC 2022), addresses this
exact failure and names it:

> Version vectors are not safe in the presence of Byzantine nodes … because a
> Byzantine node may generate several distinct updates with the same sequence
> number, and send them to different nodes (this failure mode is known as
> **equivocation**).

That is our bug, described as a Byzantine fault. Which reframes it usefully:

> **Our own CLI is indistinguishable from a Byzantine node.**

We built tamper-evidence against a hostile peer, then found a second process on
the same machine committing the identical fault by accident. That is why the
lock felt misplaced — we were using process-level coordination to prevent
something the data model treats as unpreventable.

The paper's construction: every update carries **a set of predecessor hashes**,
the hashes of updates that causally precede it. Updates plus predecessor hashes
form a DAG — *"essentially the Hasse diagram of the partial order representing
the causality relation"*. Transitively-reachable dependencies are omitted, so
the set stays small. The **heads** are updates that nothing depends on.

The telling detail: **"sequence number" appears nowhere in the paper's own
construction.** It appears only in the description of what does not work.

Two properties follow that we do not have today:

- If two peers exchange head hashes and they match, their histories are
  *provably* identical — the hashes transitively cover everything.
- Equivocation stops being harmful. Two conflicting updates are simply two
  nodes in the DAG with different hashes. There is no shared position to
  contend for, so there is nothing to resolve.

## 4. Everyone else who hit this wall

**Secure Scuttlebutt** is the closest analogue to our design: signed,
single-writer, append-only logs with `seq` and backlinks. They never solved
multi-device. Two attempts, and both split identity away from the log:

- [Meta-feeds](https://github.com/ssbc/ssb-meta-feeds-spec): each subfeed is its
  own log with its own sequence numbers and its own keypair. But *"a metafeed is
  tied to a single identity and thus should only be used on a single device."*
- [Fusion identity](https://github.com/ssb-ngi-pointer/fusion-identity-spec):
  shares the secret key across devices — and each device still keeps a
  **separate feed**. How simultaneous writes are handled is left as an
  implementation detail.

Their fork handling is worse than ours: a forked feed cannot be appended to at
all, freezing the identity.

**Automerge** moved *away* from `(actorId, seq)` dependencies to hash-DAG
dependencies, keeping actor+seq only as an internal change identifier.

**Keyhive** (Ink & Switch) keeps authorisation entirely separate from causality
— signed capability delegations over Automerge's existing DAG, with no
sequential signing chain.

**Weidner's CRDT survey** is stricter than we would have guessed: replica IDs
must be unique per *session*, not per device, and it explicitly warns against
*"reuse a replica ID across replicas on the same device, e.g. by storing it in
`window.localStorage`"* — which is our two-tabs case, named as an anti-pattern.
It also notes version vectors grow *without bound* under this rule, since every
tab and every refresh is a new replica.

Three independent systems, one conclusion: **signing and identity are one layer;
causal structure is another.** We fused them, and the constraint is the seam.

## 5. What it would cost

Not free, and the Merkle-CRDT report (Protocol Labs, 2019) is the most honest
about the costs, since it is written by people who shipped it:

- **Comparing diverged DAGs is expensive.** *"Merging two Merkle-Clocks requires
  comparing them to see if they are included in one another and finding
  differences. This may be a costly operation if DAGs have diverged
  significantly (or long ago)."* Our version-vector comparison is O(writers) and
  cheap.
- **Cold sync gets slower.** A thin DAG cannot be fetched in parallel branches;
  *"cold-syncs may take significantly longer than it would take to ship a
  snapshot"*.
- **Garbage collection becomes a real need.** The report explicitly flags
  *"the need of exploring garbage collection and DAG compaction mechanisms."*

Automerge's answer to the sync problem is **Bloom filters plus heads**: a sync
message carries heads, a Bloom filter summarising what the sender has, and
explicit needs. That is more machinery than `frontiersOf` and is a genuine
increase in protocol complexity.

Against that, what gets *deleted* if this direction is taken:

- the store lock, as a correctness requirement
- the control API for writes (writes become ordinary sync again)
- §7.3's fork resolution — nothing to resolve
- the one-key-one-device constraint, and the caveat it forces onto §5.6
- one field from the event body

So it is not obviously a complexity increase. It moves complexity from *the data
model and every consumer of it* into *the sync protocol*.

## 6. What this does not settle

Two questions the review could not answer, both specific to our design:

**Does §7.2.1's root authority survive?** Root events are admitted on a
signature from the space key alone — `incremental.ts` does a bare identity
check, `hex(e.writer) !== this.spaceHex`. This exists to break a circularity:
the writer set lives in the root, so something must write the root without
consulting the writer set.

That is *authority*, not *position*, so it looks orthogonal to `seq` — but it
interacts with `writerSetFrom` and the deferred-event retry, and the interaction
is not obvious. p2panda's
[access-control CRDT notes](https://p2panda.org/2025/08/27/notes-convergent-access-control-crdt.html)
describe the same bootstrap over a DAG (creator holds initial admin, authority
traced back through the DAG to the group's origin), which suggests it is
workable — and also that concurrent authorisation changes are an unsolved design
space: *"which conflict resolution strategies are working well for Authorisation
CRDTs and their users is still to be explored."*

**What does sync actually cost?** This is the real trade and it is *measurable*
against our existing `sync.ts` rather than arguable. Nobody should decide this
from prose.

## 7. Honest assessment

The direction is more attractive than expected, for a reason worth stating
plainly: **the fold is already right.** Convergence never used `seq`. What would
change is the integrity layer and the sync protocol, not the CRDT.

But three cautions:

1. **This is the core.** §2.1, §2.2, §2.3, §7.3 and the event format all move.
   Everything else in this repo is built on them.
2. **The costs land on sync, which is where our current design is strongest.**
   Version vectors with tip hashes are compact, cheap to compare, and
   understood. Trading that for Bloom filters and DAG traversal is a real
   sacrifice, not a free win.
3. **Nothing here is measured.** Every cost above is quoted from someone else's
   system.

The one thing this review does settle: the constraint is **not** intrinsic to
combining CRDTs with signing. Those are compatible. It is intrinsic to
combining CRDTs with *dense per-writer sequence numbers*, which we chose for gap
detection and which brought the constraint along uninvited.

## Sources

- Kleppmann, [*Making CRDTs Byzantine Fault Tolerant*](https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf), PaPoC 2022
- Weidner, [*CRDT Survey, Part 3: Algorithmic Techniques*](https://mattweidner.com/2023/09/26/crdt-survey-3.html)
- Sanjuán, Pöyhtäri, Teixeira, [*Merkle-CRDTs*](https://research.protocol.ai/blog/2019/a-new-lab-for-resilient-networks-research/PL-TechRep-merkleCRDT-v0.1-Dec30.pdf), Protocol Labs 2019
- [ssb-meta-feeds-spec](https://github.com/ssbc/ssb-meta-feeds-spec) and [fusion-identity-spec](https://github.com/ssb-ngi-pointer/fusion-identity-spec)
- [Keyhive: Local-first access control](https://www.inkandswitch.com/keyhive/notebook/01/), Ink & Switch
- [Notes on building a convergent, offline-first Access Control CRDT](https://p2panda.org/2025/08/27/notes-convergent-access-control-crdt.html), p2panda
- Jacob et al., [*On CRDTs and Equivocation in Byzantine Setups*](https://arxiv.org/pdf/2109.10554)
- [Automerge sync protocol](https://automerge.org/automerge/automerge/sync/index.html)
