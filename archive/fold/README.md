# Fold

Stage 1 of [docs/PLAN.md](../../docs/PLAN.md). Pure function from an event *set*
to state, per [docs/SPEC.md](../../docs/SPEC.md) §1–§4.

No networking, no storage, no DOM. WebCrypto is the only platform dependency.

## Files

| File | What |
|---|---|
| `types.ts` | The event envelope (§2) and attribute values (§4) |
| `encode.ts` | Canonical encoding (§2.1) — fixed field order, length-prefixed |
| `hash.ts` | SHA-256, EventId, hex, byte comparison |
| `key.ts` | The `(lamport, writer)` comparison key (§2.2) |
| `state.ts` | What a folded event set means |
| `fold.ts` | The fold itself, plus cycle-breaking and path derivation |
| `validate.ts` | Creator-side obligations; deliberately *not* called by `fold` |
| `testkit.ts` | Test helpers, not shipped |

## The property that matters

Any peer applying the same event set holds the same state, regardless of order
(§1.3). `fold.test.ts` checks this by shuffling, with fast-check.

Two places are easy to get wrong, and both are covered:

- **`:deleted` (§4.5)** is a derived predicate over the whole event set, not an
  LWW slot. The naive incremental version — clear the tombstone when a live-attr
  event beats it — is order-dependent. See the test named "THE order-dependence
  trap".
- **Cycle-breaking (§4.1)** picks the lexicographically smallest UUID in each
  cycle. Depth is unusable: inside a cycle no node has one.

## The invariant nothing enforces

`(lamport, writer)` is a total order **only because a writer's own lamports are
strictly increasing** (§2.2). Two events from the same writer sharing a stamp
cannot be ordered by any peer, and every LWW resolution silently falls back to
arrival order.

Nothing on the wire prevents this. `checkWriterLamports` catches it; run it over
any log loaded from storage or received from a peer.

The property test found this the hard way — its first generator produced
same-writer lamport ties and failed within 500 runs.

## Totality

The fold never rejects an event set (§3.5). Unknown parents are materialised as
bare objects, absent blobs are just hashes, malformed values are skipped. All
validation lives in `validate.ts` and is the *creator's* job.
