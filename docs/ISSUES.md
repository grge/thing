# Known Issues — v0 POC

Collected from SPEC.md, FINDINGS.md, and code review. Not all are v0 obligations; some are input to the rewrite.

---

## Data Model

### 1. Truncated 16-byte hashes for `prev` / `EventId` (§2.1, FINDINGS F6)
- Birthday bound at ~2^64 events — fine for POC scale.
- **Not collision-resistant against an adversary.** A malicious peer could craft colliding events to silently drop or reorder history. SPEC §10.6 acknowledges this but the envelope uses truncated hashes everywhere.

### 2. `:deleted` predicate is O(n) per object per fold (§4.5)
- Requires scanning *all* events for an object to compute `kill` and `live` maxima.
- Testkit generates small sets; real workloads with many events per object may see performance issues.

### 3. Cycle breaking picks arbitrary victim (§4.1, FINDINGS F10.3)
- Smallest UUID re-parented to ROOT. Deterministic but **user-hostile** — the "wrong" object gets detached.
- In concurrent move (Alice moves A→B, Bob moves B→A), victim is lexicographically smaller UUID, not the intended structure.

### 4. No causal metadata on events (§2)
- Only `prev` (per-writer) and `lamport` (global). No vector clock or dotted version vector.
- **No way to detect concurrent writes to same attribute** — LWW just picks one.
- For `:parent` this is visible (cycle); for `:content` it's **silent data loss** (losing blob still in log but unreachable).

### 5. Lamport clock is unenforced — malicious actor always wins conflicts (§2.2)
- Each peer increments its own counter on create, and `counter = max(counter, event.lamport)` on receive.
- **Nothing on the wire enforces this.** A malicious peer can:
  - Set arbitrarily high `lamport` on every event it creates
  - Never increment, just observe peers' lamports and jump ahead
- Since LWW comparison key is `(lamport, writer)` with lexicographic `writer` tiebreak, a malicious peer can **guarantee it wins every conflict** by stamping `MAX_INT` (or just higher than any observed).
- SPEC §2.2 calls this "an obligation on the event creator" with "nothing on the wire enforces this" and suggests an assertion at creation — but a malicious creator ignores assertions.

---

## Transport / Sync

### 6. Star topology = writer is SPOF for blobs (§3.4, FINDINGS F7)
- Readers only connect to writer. Writer tab closed → **no blob fetches work for any reader**, even for blobs other readers hold.
- SPEC §7.2 admits this: "the gap the hosted pinning peer fills."

### 7. Gap-fill retries forever with no resolution (§3.3, FINDINGS F10.2)
- A permanently missing event stalls that writer's chain *indefinitely*.
- In mode 2 (one writer), **the entire space stops**.
- The 5-second re-issue on backoff makes the stall noisy, not resolved.

### 8. Version vectors don't express "I have event X but not its predecessor" (§3.1)
- VV reports highest *contiguous* seq. Holding 0,1,2,4 → reports 2.
- Peer sends 3. But **you already have 4** — no way to tell peer "skip 4, I have it."
- Wastes bandwidth on replay.

### 9. `HELLO` has no authentication (§3.4, FINDINGS F10.1)
- Any peer can claim any `writer` ID.
- A reader could forge writer events and the space would accept them.
- SPEC calls this "convention only" (§7.2).

### 10. Blob transfer has no per-chunk integrity (§6, FINDINGS F10.4)
- Whole-blob hash only. A 50 MB photo failing on last chunk = **full 50 MB retry**.
- Chunk size (16 KiB) and retry granularity are untuned (FINDINGS F10.4).

---

## Cross-Space / Multi-Space

### 11. Shared blob store leaks existence across spaces (§8.5, FINDINGS F10.9)
- Space A learns whether Space B holds a given blob (by timing `hasBlob`).
- Harmless for trusted peers, **breaks encryption** (§9) — a peer holding ciphertext can't be trusted to filter.

### 12. Cross-space move loses all history (§8.5)
- New UUID, new events, tombstone old. **Not a move — a copy + delete.**
- SPEC is honest: "the UUID changes and no source history follows" but it's a semantic gap.

---

## Architectural Tension (FINDINGS F12–F13)

### 13. Two selective-fetch mechanisms with incompatible completeness models
- **Blobs:** `WANT`/`BLOB`/`NOBLOB` — fetched on demand, no completeness tracking
- **Future Yjs updates:** would need equivalent selective fetch for log payload
- **Snapshots (§5) assume complete VV knowledge** — selective sync breaks snapshot identity because "same VV ≠ same state" anymore.

This isn't a bug yet — v0 works because "all metadata to every peer" holds. Mode 3 breaks it.

---

## Most Likely to Bite in Real Use

| # | Issue | Impact |
|---|-------|--------|
| 5 | Lamport unenforced | Malicious peer wins all conflicts silently |
| 6 | Writer SPOF for blobs | Writer offline = readers can't fetch any new blobs |
| 7 | Permanent stall = dead space | One missing event stops entire mode 2 space forever |
| 10 | No per-chunk integrity | Large blob failure = full retransmit |
| 11 | Blob store sharing prevents encryption | Can't add encryption without redesigning blob layer |

---

## Notes

- FINDINGS F10–F13 are explicitly "design pressure found by building" — not v0 bugs, but known-insufficient for where the project is heading.
- The rewrite should address the envelope (§2), handshake (§3.4), and blob/log boundary (§6) together, since they're the expensive things to change later.