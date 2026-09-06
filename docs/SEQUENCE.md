# The sequence rule: canonical form, before any code

**Status: built** (PLAN.md stage 11). Written as a specification first, per
§3.6, and kept as one — the canonical form below is the contract.

**Originally:** §3.6 requires this to be written *before* the rule is
coded — *"a rule is not finished until its serialisation is pinned, including
the metadata a reader never sees"* — and the plan repeats it for stage 11.

This is the bet (§3.8, OPEN.md 1): does "merge rule" stay a small vocabulary, or
does it become "arbitrary code with private state"? A sequence is the rule most
likely to break it, which is why it is scheduled last and why it is worth
building carefully.

---

## What it must be

An **ordered list that two writers can edit concurrently**, folding to the same
state on every peer under every arrival order. `archive/proto/` implemented one
against this architecture and it held, so this is a port with corrections rather
than a new design.

Events are operations, not assertions:

```
{ op: 'ins', after: ElementId | null, body: … }
{ op: 'del', target: ElementId }
```

Ordering is RGA's: among elements sharing an anchor, the later `(lamport,
writer)` sorts first. Deterministic from the events alone, which is what keeps
the fold order-independent.

## Element identity — corrected

The prototype derives an element's id from `(writer, seq)`:

```ts
// archive/proto/types.ts
export function elementIdOf(e: Event): ElementId {
  return `${e.writer}:${e.seq}`;
}
```

**That is no longer unique.** Per-process append points (§2.1) mean one writer
has several chains, each starting at `seq 0` — so two of your own processes
inserting produce *the same element id for different elements*. Every anchor
would then be ambiguous, and a delete could target the wrong element.

The id is now **`writer/eventId`** — the event that created the element, named
by its own hash. That is unique by construction and needs no reasoning about
chains at all, which is better than the `(writer, point, seq)` this document
first proposed: an event id already distinguishes everything an event can be. The prototype's reasoning survives intact and is worth keeping:

> Element ids derive from the event, not minted by the rule. That is what makes
> a missing anchor an ordinary chain gap rather than a new kind of lookup — the
> id names the event that created it.

Recorded because it is a real defect the append-point work introduced into a
design that had been checked, and it would have been silent: two ids colliding
produces a plausible-looking sequence with elements in the wrong places.

## Canonical form

§3.6 asks for two things: the serialisation pinned, and observable state
separated from representation.

### What a reader sees

An ordered list of live elements. Tombstones are **not** part of it — a deleted
element is not in the list, and its position is not observable.

### What the accumulator holds

Tombstones live in the fold output (they must: a concurrent insert may still
anchor to a deleted element), plus each element's anchor and comparison key.
None of that is observable, and all of it has representation freedom — which is
precisely the trap §3.6 describes.

### The pinned form

**The accumulator serialises as a flat array of nodes, sorted by element id
(byte order on `writer‖point‖seq`).**

Not in list order. Sorting by id rather than by position is the point: two
implementations may build the list by different traversals and disagree about
the intermediate structure while agreeing exactly on the set of nodes. Sorting
by an intrinsic, unambiguous key removes that freedom.

Each node:

| field | encoding |
| --- | --- |
| `id` | writer (32) ‖ point (16) ‖ seq (u32) |
| `after` | presence byte, then an id, or absent for the head |
| `deleted` | one byte |
| `lamport` | u64 |
| `body` | length-prefixed bytes, opaque |

No floating point anywhere, per §3.6's third rule.

**Deletes do not appear as nodes.** A delete sets `deleted` on the node it
targets. A delete whose target has not arrived is *pending*, not a node — and
pending entries are not part of the canonical form, because they are a property
of what a peer has received rather than of the state.

### Hashing

Hash the **observable list**: the live elements' bodies in order, nothing else.
Two peers that agree on what the sequence *is* must hash identically even if one
still holds a tombstone the other has collected. That is §3.6's second rule
applied literally, and it is what stops garbage collection from forking a hash.

## Totality (§3.4)

Three cases, none fatal:

- **A missing anchor.** The insert is held pending; the rest of the slice
  resolves. It applies when the anchor arrives, which is an ordinary chain gap
  (§2.5), not a new mechanism.
- **A delete for an unknown target.** Also pending. It cannot be discarded — the
  target may arrive later, and dropping it would make state depend on arrival
  order.
- **A malformed operation.** Ignored. `decode` must never throw (§3.2's codec
  contract), so a value the rule cannot read is a value it does not apply.

## What this will not answer

Stage 11 answers **the bet** — whether the rule fits the contract — and that is
fully testable without a UI: convergence under every arrival order, the
homomorphism, and byte-identical serialisation are properties of the code.

It does **not** answer whether the merge results are *acceptable*. Two people
typing at one position converge; whether they converge to something a person
would accept is a judgement made by looking, and needs the interface. Tests are
written as scenario transcripts ("A types `hello`, B concurrently types `world`
at position 0") so the expected values are legible enough to disagree with, but
legible is not the same as tried.

## Open

- **Tombstone growth.** They cannot be collected while any concurrent insert
  could still anchor to one, and nothing here bounds that. §9.2's compaction is
  where it belongs, and this rule should not invent its own answer.
- **What `body` is.** Opaque bytes here. A text sequence wants a character or a
  run; a list of blocks wants a reference. Deciding it in the rule would make
  the rule less general, so it stays opaque and the caller decides — which is
  itself part of the bet.
