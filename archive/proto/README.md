# proto — is the model coherent?

A throwaway prototype of [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §3, built
to answer one question: **can a filesystem, a chat and a co-edited document live
in one space, folded by one algorithm, with no type-specific code in the fold?**

Not production code and not a starting point for the rewrite. No signing, no
networking, no storage, no canonical encoding — the substrate is assumed (§2 is
Proven) and only the fold is under test.

```
npx vitest run proto/
```

## What it implements

| File | What |
|---|---|
| `types.ts` | Events, slice keys, the `(lamport, writer)` comparison |
| `rules.ts` | The merge-rule vocabulary — register, blob, flag, sequence |
| `fold.ts` | The three-phase kernel (§3.1) |
| `writer.ts` | A minimal event producer, so tests read as intentions |
| `model.test.ts` | The claims, checked |

## What it establishes

**The model holds, and it simplified.** All three fold in one space with one
kernel. `fold.ts` contains no mention of files, chats or documents — it
partitions by slice key, looks up each slice's rule, and collects.

The simplification is what §4.1 now records: **spaces do not need types.**
Attribute slices are always registers, so every space has the same structural
model, and the only thing that varies is what an object's body means — declared
by that object's `:kind`. A chat is a folder whose children are messages; a
document is an object whose body folds by the sequence rule.

**A sequence CRDT fits the rule contract** — this was §3.8's open question and
the reason for the exercise. The rule's signature is
`(events for one slice) -> value`, identical to the register's; it is asserted in
the tests rather than left implicit. Three predictions from §3.8 held:

- Element ids derive from `(writer, seq)`, so they need no minting and a missing
  anchor is an ordinary chain gap.
- Tombstones live in the rule's fold output and keep their positions, so an
  insert anchored to a concurrently-deleted element still lands correctly.
- An insert whose anchor has not arrived is *pending* — held, not discarded, and
  folded when the anchor does. The rest of the slice resolves meanwhile.

**Convergence is structural.** Generated multi-writer histories — random
interleavings of attribute writes, concurrent inserts, deletes and chat messages
across three writers — fold identically under every arrival order, and are
idempotent under duplicate delivery. That is §1.1's load-bearing property tested
against the sequence rule rather than only against LWW.

**Damage stays in one slice.** An object whose `:type` names a rule the client
does not have still folds its structure: correct name, correct parent, content
marked unreadable. Its siblings are unaffected, and so is the rest of the tree.
This is §3.1's central claim and the reason the tiering exists.

**Phase 1 closes the circularity.** Root events are admitted on the space key
alone, so a stranger writing `:writers` to add themselves is inert — the test for
it is the attack §7.2 describes.

## What it does not establish

- **Canonical serialisation** (§3.6). Nothing here is byte-identical across
  implementations; the sequence rule's output has real representation freedom
  (run splitting, tombstone encoding) that a real implementation must pin down.
- **Performance.** The fold is O(n) over the whole log every time and the
  sequence rule rebuilds its tree from scratch. Incremental folding is the
  obvious next thing and is not attempted.
- **That the vocabulary stays small** (§3.8). One sequence rule fits. Whether a
  block-structured document needs a rule large enough to be "arbitrary code with
  private state" is untested, and remains the real form of the bet.
- **Anything about the substrate**, which is assumed rather than modelled. Two
  defects found by review live there and could not have surfaced here: events
  need the space key in their signed preimage or they are portable between
  spaces (§2.1), and version vectors cannot express that a chain has forked, so
  §7.3's resolution has no way to obtain both branches (§2.3).
- **Cycle-breaking**, which §3.4 requires and which is the one part of the fold
  that is not per-slice. Its absence here is why the prototype makes incremental
  folding look more bag-local than it is.
