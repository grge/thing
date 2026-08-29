# Spec — v0 (mode 1 + mode 2 POC)

Status: draft. Scoped to a throwaway proof of concept. The POC exists to answer
three questions; everything else is deliberately deferred.

## 0. Purpose

A namespaced, append-only event log replicated between browser peers over WebRTC.
The log is folded into state by a pluggable interpreter; the default
interpretation is a filesystem.

The view of that filesystem is a **two-pane tree browser** (§8). An infinite
canvas over the same objects is the intended eventual view and is the *last*
thing v0 builds (§11.5) — the tree exercises the model first, on the attributes
that carry the most weight.

Three intended modes:

1. **Local only** — one user, no peers, log in localStorage.
2. **One writer, many readers** — pastebin-shaped. Writer shares a URL.
3. **Collaborative** — concurrent writers, CRDT text objects, chat. *Not in v0.*

This document specifies modes 1 and 2 only.

### What the POC must answer

1. Does WebRTC blob transfer work well enough in practice? Chunking,
   backpressure, resume, and what fraction of peer pairs fail to connect
   without a TURN relay. Highest risk, least dependent on the rest of the design.
2. Does the UUID + LWW-attribute model survive real filesystem operations?
   Only discoverable by folding real event sequences.
3. Does paste-then-share-a-URL feel good? Answered in two parts: the tree view
   answers it for paste-and-share (§11.2, §11.4), and the canvas answers the
   spatial half only if v0 gets that far (§11.5).

The POC is expected to be rewritten. Its value is making these three questions
answerable with evidence.

---

## 1. Core model

### 1.1 Objects

Every object has a **UUID**, assigned at creation and never reused. The UUID is
the only identity. Paths are *derived*, never stored.

An object's state is a set of **attributes**. Each attribute is independently
resolved. Two writers touching different attributes of the same object do not
conflict.

### 1.2 Events

An event is a single assertion: *this attribute of this object now has this value.*

Events are never mutated or deleted (except by compaction, §5, out of scope for v0).

### 1.3 Commutativity

The log is a **set**, not a sequence. Any peer that has applied the same set of
events holds the same state, regardless of arrival order.

This is the load-bearing property. It is what makes sync a set-reconciliation
problem rather than a consensus problem, and it is what lets an offline peer
reconnect without replaying history in order.

Ordering *within a single writer* is enforced by hash chaining (§3.2). There is
no ordering between writers, and none is needed.

---

## 2. Event envelope

The piece least likely to survive a change cheaply. Everything else reads it.

```
Event {
  writer:  WriterId      // 16 bytes, random, generated per browser profile per space
  seq:     u32           // per-writer, starts at 0, strictly +1
  prev:    Hash | null    // hash of this writer's event seq-1; null iff seq == 0
  lamport: u64           // see 2.2
  target:  Uuid          // 16 bytes, the object being asserted about
  attr:    AttrName      // short ASCII, see 4
  value:   Value         // attribute-specific, see 4
  wall:    u64           // ms since epoch, DISPLAY ONLY — never used to resolve
}
```

`EventId` = hash of the canonical encoding of all fields above.

There is no `space` field. Spaces are keyed **externally by the storage and
transport layers** — one localStorage/IndexedDB keyspace per space, and `space`
carried once in `HELLO` (§3.4) rather than on every event. A browser profile in
two spaces therefore holds two independent logs and two `WriterId`s, which is
what "per browser profile per space" above means.

### 2.1 Canonical encoding

Two peers must produce byte-identical encodings of the same event, or hashing
and dedup break. v0 uses a fixed field order and length-prefixed values. No maps,
no optional field reordering, no floats in hashed positions (`:pos` is stored as
two i32s in fixed-point, see §4.4).

Hash is SHA-256, truncated to 16 bytes for `prev` and `EventId`. Full 32 bytes
for content hashes (§4.3).

Dedup is by `EventId`, so a collision between two genuinely different events
would silently drop one. 16 bytes puts the birthday bound at ~2^64 events, which
a POC will not approach by many orders of magnitude — that, not the trust model,
is why truncation is safe here. §10.6 covers the adversarial case, which is
different and not addressed by size alone.

### 2.2 Lamport clocks

Wall clocks are not usable for conflict resolution — peers disagree, sometimes by
hours. A peer whose clock runs fast would win every conflict forever.

Each peer keeps a counter:

- On creating an event: `counter += 1`, stamp with the new value.
- On receiving an event: `counter = max(counter, event.lamport)`.

The two rules together give the standard guarantee: a peer that receives lamport
100 and then creates an event stamps 101. So "later" means *later in terms of
information flow*. If Bob had seen Alice's event before writing his own, Bob's
stamp is strictly higher.

Ties (genuinely concurrent writes) break on `writer` bytes, lexicographically.
Arbitrary, but identical everywhere, which is the only requirement.

**Comparison key throughout this spec:** `(lamport, writer)`.

**This key is a total order only because a writer's own lamports are strictly
increasing.** Two events from the *same* writer can never share a stamp — the
create rule increments unconditionally — so `(lamport, writer)` ties arise only
between different writers, where the `writer` bytes separate them. A writer that
ever reused a lamport would produce two events its peers could not order, and
every LWW resolution in §4 would fall back to arrival order, silently breaking
§1.3. Nothing on the wire enforces this; it is an obligation on the event
*creator*, and it is worth an assertion at the point of creation.

---

## 3. Log structure and sync

### 3.1 Version vectors

A peer's knowledge is summarised as a map `writer -> highest contiguous seq held`.

```
VV { "a3f2..": 47, "91bc..": 12 }
```

"Contiguous" matters: if a peer holds writer A's events 0–47 and also 49, its VV
reports 47. Event 49 is held but not counted (see §3.3).

### 3.2 Per-writer hash chains

Each writer's events form a chain via `prev`. This gives:

- **Gap detection.** Holding A@47 and receiving A@49 with `prev` unmatched tells
  you 48 is missing, precisely.
- **Tamper evidence.** A relaying peer cannot alter or reorder a writer's history
  without breaking the chain. It can *withhold* events — unavoidable — but not
  forge them.
- **Compact identity.** `(writer, seq, hash)` identifies an entire history.

Chains are strictly per-writer. They never merge. There is no global chain and no
consensus mechanism: peers are invited by URL and already trust each other, so
there are no competing histories to choose between.

### 3.3 Out-of-order arrival within a writer

An event whose `prev` is not yet held is **held aside, not applied**. This is the
one place v0 buffers.

This is nearly free — the hash chain already tells you what's missing — and it
means the fold never sees a writer's history with holes in it.

Buffered events are requested by gap-fill (§3.4). A peer that still holds a gap
after 5 seconds re-issues `GAP` and logs the stall loudly; it keeps re-issuing on
a backoff rather than giving up. There is no timeout that *abandons* the gap — a
permanently missing event stalls that writer's chain from that seq onward, and in
mode 2 that is the whole space, so the failure must be noisy rather than silent.
The stall log is also the instrumentation for POC question 1: a reader that goes
quiet is exactly the WebRTC reliability signal we are trying to measure.

### 3.4 Sync handshake

On connection, peers exchange VVs and each sends what the other lacks.

```
-> HELLO   { space, protocol_version, vv }
<- HELLO   { space, protocol_version, vv }
-> EVENTS  [ Event, ... ]        // everything peer lacks, ascending seq per writer
<- EVENTS  [ Event, ... ]
```

**A `protocol_version` mismatch closes the connection**, with the mismatch
reported to the user. v0 has no negotiation and no backward compatibility: a
half-spoken protocol between two builds of a POC would produce failures far
harder to read than a refusal. This is cheap to relax later and expensive to
debug if it is left implicit.

Then both stay connected and stream new events as they are created.

- Sends are per-writer ascending, so `prev` chains resolve without buffering in
  the common case.
- A peer with a *lower* VV for some writer receives the difference. A peer with a
  *higher* VV sends it. Both directions happen in one exchange.
- `GAP { writer, from, to }` requests a specific range, used when §3.3 buffering
  detects a hole.

Fresh join is the same handshake with an empty VV.

**Topology in v0 is a star: every peer connects to the writer, and readers do not
connect to each other.** This keeps `GAP` and `WANT` (§6) trivially routed —
there is only ever one peer to ask — at the cost of making the writer a single
point of failure for readers, which §7.2 already accepts. The protocol itself is
peer-symmetric and does not depend on this; a reader-to-reader mesh would need a
blob-availability exchange (a peer's VV says which *events* it holds, never which
*blobs*), and that is deferred with the pinning peer.

### 3.5 Cross-writer ordering: there is none

**The fold must be total.** It must produce sensible state for *any* event set,
including one referencing an absent blob, an unknown parent UUID, or an object
with no `:kind`. There is no event set the fold may reject.

Events from different writers are applied on arrival, in any order. The folded
state may therefore transiently reference things not yet present — most commonly
a `:content` hash whose blob has not arrived.

That gap is closed at the **view** layer, not the log layer: an object whose blob
is missing renders as a placeholder. Large blobs are slow regardless of protocol
correctness, so the UI needs loading states anyway; causal buffering across
writers would solve the same problem a second time, in a place where bugs are far
less visible.

---

## 4. Attributes (v0)

The fold resolves each `(target, attr)` independently by max `(lamport, writer)`.
The one exception is `:deleted`, which is a derived predicate over several
attributes' events rather than a max over its own slot — see §4.5.

### 4.1 `:parent` — `Uuid | ROOT`

The containing directory. `ROOT` is a reserved all-zero UUID.

**`ROOT` is a sentinel, not an object.** No event ever targets it and it has no
attributes. A total fold (§3.5) will nonetheless materialise it the moment
anything is parented to it, since an unknown parent becomes a bare object — and
because its own `:parent` defaults to `ROOT`, it then appears as its own child.
Consumers of the folded state must skip it. Cheaper than special-casing it
inside the fold, but it has to be written down or every consumer rediscovers it.

Paths are **derived** by walking `:parent` to root, joining `:name`. Never stored,
never sent. A path is a UI convenience and nothing more; making it storage would
make rename a structural operation instead of a one-attribute write.

**Cycles are possible.** Alice moves A into B while Bob moves B into A; both
resolutions are individually valid, together they detach a subtree.

The fold resolves every `:parent` first, then breaks cycles in the resulting
parent map: **within each cycle, the object with the lexicographically smallest
UUID is re-parented to `ROOT`.** Repeat until no cycle remains.

Depth is not usable as the tiebreak — inside a cycle no node has a depth, which
is what a cycle means — and any rule referring to prior state would let peers
that folded different event orders disagree. The UUID rule is a function of the
resolved parent map alone, so every peer computes the same victim.

The re-parenting is **fold-local state, not an event.** No peer writes a
`cycle-broken` event; if they did, every peer would write its own and the log
would amplify. The fold marks the object `cycle-broken` in the state it returns,
the UI surfaces it, and the user fixes it with an ordinary `:parent` write.

Not elegant; sufficient.

### 4.2 `:name` — `string`

Display name. Not unique, not a key. Siblings with identical names are legal and
the UI disambiguates. Enforcing uniqueness would require coordination.

### 4.3 `:content` — `Hash | null`

SHA-256 of the **plaintext** blob (§6). Null means "object exists, no content" —
a directory, or a card holding only a position.

Concurrent writes: LWW picks one. The losing blob is *not lost* — it is
content-addressed and still referenced by its event. Recovering it is a UI
feature, not a data-recovery operation.

### 4.4 `:pos` — `(i32, i32)`

Canvas coordinates, fixed-point (1 unit = 1/1000 canvas unit) so encoding is
exact and hashing is stable. Floats are not permitted in hashed positions.

The canvas is "infinite" in the UI sense — no walls, no fixed extent — but i32 at
1/1000 bounds it at ±2.1M canvas units. Panning past that is not reachable by
hand at POC scale; if it ever is, the fix is i64, which is an envelope change.

**`:pos` has no consumer until §11.5.** The tree view does not render
coordinates. It stays defined and stays covered by the §11.1 commutativity tests
regardless, because §2 is the piece least likely to survive a change cheaply and
adding an attribute later is exactly the change worth avoiding. It also remains
the clearest illustration of where LWW is unambiguously right.

LWW is ideal here: two people dragging the same card, one wins, nobody minds.

### 4.5 `:deleted` — `bool`

Tombstone. Objects are never removed from the log.

**`:deleted` is not resolved like the other attributes.** It is a *derived
predicate* over the object's whole event set, not a max over the
`(target, ":deleted")` slot. Define, for an object:

```
kill  = max{ (lamport, writer) : event asserts :deleted = true }   or  ⊥
live  = max{ (lamport, writer) : event asserts :content, :name,
                                 :parent, :pos, or :deleted = false }   or  ⊥

deleted := kill ≠ ⊥ and (live = ⊥ or kill > live)
```

`⊥` is less than every key. `:deleted = false` counts as a live-attr event; it is
the explicit undelete, and it is the only way to revive an object without also
changing one of its other attributes.

**This must be computed over the whole set, not incrementally.** The obvious
imperative implementation — "on receiving a live-attr event, clear the tombstone
if it beats the tombstone" — is order-dependent and therefore wrong. With a
tombstone at lamport 5, a `:pos` write at 7, and a second delete at 9, that
implementation yields *alive* if the events arrive 5, 9, 7 and *deleted* if they
arrive 5, 7, 9. Both `kill` and `live` are themselves maxima over sets, so the
definition above is commutative; the incremental one is not. This is the single
easiest place in v0 to silently break §1.3.

Rationale for undelete-wins: with plain LWW, Alice deleting while Bob writes can
hide Bob's content behind a tombstone. Nothing is lost — the content is in the
log, addressable — but it *looks* like data loss, which is worse than a
resurrected file. Undelete is recoverable by re-deleting; apparent data loss
erodes trust immediately.

### 4.6 `:kind` — `"file" | "dir"`

Structural rather than descriptive: it tells the tree what is expandable. What
an object *is* — its format — is `:type` (§4.7), kept separate so one attribute
answers one question (§1.1).

LWW like everything else, and advisory. A `dir` with content or a `file` with children is legal and rendered
sensibly rather than rejected.

### 4.7 `:type` — `string | null`

The object's **format**, as a MIME type. Asserted at creation and replicated
like any other attribute.

This names a format, never a renderer. `text/markdown`, not `todo-list`. A
client is free to have a renderer the sender has never heard of, and a TUI
client, a web client, and a client with a bespoke renderer must all be able to
do something sensible with the same object.

**Why it cannot be derived.** Extension and content both fail for the same
reason: a todo list whose content is markdown has markdown bytes and a `.md`
name, and only an assertion distinguishes it from a plain note. Content
addressing would call the two identical. §7.3's Yjs objects go further — they
have no blob at all, so there is nothing to inspect, and two byte-identical
update streams can be different applications.

**Degradation.** A client with no renderer for a type walks the type itself,
most specific first:

```
application/vnd.thing.board+json; schema=kanban
application/vnd.thing.board+json
application/json                  ← the +suffix fallback
application/*
```

Each step is a real MIME mechanism, and each degrades rather than fails. The
`+suffix` form is what lets an unknown specialised type stay readable.

**Absent means unknown.** The fold is total (§3.5), so an object with no
`:type` is legal. The UI falls back to the filename extension and then to the
not-renderable state (§8.2); it never guesses from content.

**The format belongs to the object, not the blob.** Blobs are content-addressed
and shared across spaces (§8.5), so the same bytes may legitimately be plain
markdown in one object and a todo list in another. Storing format beside the
bytes also meant it was never replicated, so a reader disagreed with the writer
about what a file was (FINDINGS F10).

Like `:kind`, `:type` is **not** a live-attr event: asserting a format does not
revive a tombstoned object (§4.5).

---

## 5. Snapshots and compaction — deferred

Not in v0. Mode 2 spaces are small enough to replay from event zero.

Noted so v0 does not design them out:

- A snapshot is `{ vv, state }` — the fold of a known event set, identified by the
  VV it covers. A peer holding it can apply any event *not covered* by that VV
  directly, with no replay. This works **because** of commutativity; without it,
  reconciling a snapshot with an offline peer's local edits would be an ordering
  crisis.
- An offline peer holding `{A: 20}` that reconnects after truncation to `{A: 47}`
  applies the snapshot, then re-applies its own unsent events — which are under
  its own writer ID and therefore covered by no snapshot.
- Truncation must never drop below the minimum VV of any peer still being served.
  The pinning peer tracks known-peer VVs and holds a floor. Policy, not
  correctness.
- Under encryption (§6), compaction requires the fold, which requires plaintext.
  So **compaction is client-side only**; a hosted peer stores snapshot blobs
  blindly. This preserves the property that makes a hosted peer trustworthy.

---

## 6. Blobs

Content-addressed, immutable, transferred out of band from events.

- Addressed by SHA-256 of **plaintext**, so two peers with the same file agree
  they have the same file, and (later) an encrypting peer can serve a blob by
  hash without decrypting it.
- Immutable, therefore trivially commutative and free to dedup.
- Fetched **on demand**, never pushed with events.

```
-> WANT     { hash }
<- BLOB     { hash, total_len, chunk_index, bytes }   // repeated
<- NOBLOB   { hash }                                  // peer does not hold it
```

`NOBLOB` exists so the lazy-fetch UI can say "nobody has this yet" instead of
spinning forever. Without it, a `WANT` for a blob the peer never received is
indistinguishable from a slow transfer.

Chunk size 16 KiB, sized against the SCTP message limit, which makes chunking
mandatory rather than optional. Blob chunks travel as **raw bytes on the data
channel**, behind a one-byte frame tag that distinguishes them from JSON control
messages; they are never wrapped in a text encoding. A library messaging layer
between this protocol and the channel would impose its own limit and its own
chunking, and any measurement taken through it would describe that library
rather than WebRTC.
Backpressure via `bufferedAmount` watermarks on the data channel. Resume by
re-requesting from a chunk index. Integrity verified by hashing the reassembled
blob before it is accepted.

Integrity is whole-blob only: there are no per-chunk hashes, so a failed check
means re-fetching the entire blob. That is the simplest thing that is correct,
but it makes **retry granularity**, not chunk size, the interesting untuned knob
— a 50 MB photo failing on its last chunk costs 50 MB. The POC should record how
often whole-blob retries actually fire before anyone tunes either number (§10.4).

### 6.1 Materialization policy

**All metadata is replicated to every peer. Blob fetching is selective.**

Metadata is small — thousands of events at a few hundred bytes is single-digit
megabytes, nothing beside one photo. Holding all of it lets every peer compute
any path, resolve renames, detect cycles, render the full tree, and know exactly
which blobs it lacks. Sync stays one simple protocol instead of N filtered
variants.

Selectivity is therefore a **local policy over complete metadata**, not a network
subscription:

- *Full mirror* (pinning peer, later) — fetch every blob.
- *Lazy* (default) — fetch when the user opens something.
- *Prefetch by subtree* — "keep `/photos/**` warm", evaluated locally.

This is why path-based selection is robust here: it is evaluated against state the
peer already holds, so a rename automatically moves an object in or out of scope.
A sender-side filter could not do this — the sender may not agree with the
receiver about what the paths are, and an object could be renamed *into* scope by
an event the receiver was not subscribed to.

The user-facing concept from the original design ("I care about this subtree")
survives intact. Only its implementation moves, from the wire to the client.

**Where this stops working:** millions of events makes "everyone holds all
metadata" expensive, and the fix is subtree snapshots. Access control
(`/public/**` visible, `/private/**` not) *forces* selective metadata, and must be
enforced by per-subtree encryption rather than filtering, since a peer holding
ciphertext cannot be trusted to filter. Both are out of scope; both are the
reason §6.1 is written down.

---

## 7. Modes

### 7.1 Mode 1 — local

One writer, log in localStorage, no networking. The fold and canvas run
unchanged. This is the development harness and the first-run experience.

### 7.2 Mode 2 — one writer, many readers

Writer owns the space and is its only permitted writer. Readers replicate and
fold, and their UI is read-only.

- URL carries `space_id` and a `role` hint.
- Readers with no writer connected show the last state they hold, marked stale.
- Writer closing the tab makes the space unreachable to new readers, and — since
  the topology is a star (§3.4) — also stops existing readers from fetching any
  blob they do not already hold. A reader keeps its metadata and its cached
  blobs; everything else becomes a permanent placeholder until the writer
  returns. **This is the gap the hosted pinning peer fills**, and the clearest
  thing to charge for.

Enforcement in v0 is by convention: readers do not generate events. There is no
signing, so a reader could forge writer events. Acceptable for a POC among
trusted peers; §10 notes the fix.

### 7.3 Mode 3 — not in v0

Yjs updates wrapped as opaque payloads: `{ target, attr: ":yjs", value: <bytes> }`.
The outer log delivers them; Yjs merges them. The outer log needs no ordering
knowledge, because Yjs updates are already commutative among themselves.

The envelope in §2 accommodates this without change. Two things noted as unsolved:
Yjs update accumulation needs compaction (§5), and compaction of an encrypted
space must be client-side.

---

## 8. UI (v0)

The POC's view is a **two-pane file browser**: tree on the left, preview on the
right. The canvas (§0) is built last (§11.5) or not at all; the tree is what
tests the model.

This section is deliberately shallow. It specifies what the UI must *handle*,
because §3.5 requires the fold to be total and the UI is where totality becomes
visible. It does not specify how any of it looks. POC UX does not need to be
good, it needs to be complete enough that questions 2 and 3 are answerable.

### 8.1 Two-pane layout

- **Left: tree.** The `:parent`/`:name` hierarchy of one space, derived per
  §4.1. Expand, collapse, select, rename, drag to re-parent.
- **Right: preview** of the selected object.

The tree is the first real consumer of derived paths, sibling name collisions
(§4.2), advisory `:kind` (§4.6), and `cycle-broken` objects (§4.1). Every one of
those is a case the tree must render rather than reject.

### 8.2 Preview states

The preview pane is also the **fetch trigger**: §6.1 makes blob fetching lazy by
default, so selecting an object is what issues `WANT`. It therefore needs five
distinct states, not two:

| State | Cause |
|---|---|
| Rendered | text now; images and other types later |
| Not renderable | blob held, no renderer for its type |
| Fetching | `WANT` issued, `BLOB` chunks arriving (§6) |
| Unavailable | `NOBLOB` from every connected peer |
| No content | `:content` is null — a directory, or an empty object (§4.3) |

*Fetching* and *Unavailable* are distinct and both common in mode 2. Collapsing
them into one "can't show this" state would hide exactly the failure that POC
question 1 exists to measure.

### 8.3 Spaces

Spaces are presented as **tabs**. Each is an independent filesystem: its own
event log, its own `WriterId`, its own storage keyspace (§2). Switching tabs
switches both panes.

- The default space is mode 1, local, in localStorage.
- A tab arrives one of **two ways**: *created* locally, as mode 1 or mode 2, or
  *joined* by opening a mode 2 URL. Only creation offers a choice of mode;
  joining is always as a reader. **Mode is fixed at creation.** Promoting a local
  space to a shared one is not in v0 — it is nearly free (mode 2 is mode 1 plus a
  connection over the same log and writer) and it is the obvious next thing users
  will want, but it is not needed to answer any of the three questions. See
  §10.8.
- Tab kind must be **visually distinct** — three kinds, not two (§8.6).
- Multiple spaces are **live simultaneously**: N logs folded, N storage
  keyspaces, and in mode 2 up to N concurrent WebRTC connections. §3.4's
  handshake is per-space and per-connection; nothing in it assumes one.

### 8.4 Getting content in

Three gestures, all producing the same events — `:kind`, `:name`, `:content`,
`:parent` — on a freshly minted UUID:

- **Drag files into the window** → uploaded to the selected directory.
- **Paste from clipboard.** Text becomes a plaintext file. `:name` is derived
  from the first line, truncated, falling back to a timestamp when the text is
  empty or unusable. Names are not unique (§4.2), so collisions need no
  resolution.
- **Drag onto a tab** → cross-space move (§8.5).

### 8.5 Cross-space moves

Dragging a file onto another space's tab moves it there. **This is not a
`:parent` write.** Spaces share no log, no UUID space, and no writer identity, so
a cross-space move is:

1. Copy the blob into the destination's blob store (free if the store is shared —
   see below).
2. Mint a **new UUID** in the destination.
3. Write `:kind`, `:name`, `:content`, `:parent` under the destination's writer.
4. Write `:deleted` in the source, if the gesture was a move rather than a copy.

The UUID changes and no source history follows. That is a real difference from an
in-space move, which is one attribute write (§4.1), and the POC should not
pretend otherwise.

**The gesture is asymmetric.** You can move *out of* a reader tab (§8.6) — you
are writing only to the destination, which you own — but never *into* one. A
mode 2 *writer* tab accepts drops like any local space; it is reader tabs
specifically that cannot. The UI must not offer a drop target it cannot honour.

**Blob store is shared across spaces in v0.** Blobs are content-addressed by
plaintext hash (§6), so one store dedups across spaces and makes step 1 free.
This leaks existence between spaces — a space can learn whether you hold a given
blob — which is harmless among trusted peers and unacceptable once §9's
encryption arrives. Noted, not solved.

### 8.6 Tab kinds: mode 2 is two different things

"Mode 2" names a *space*, but it describes two quite different tabs. The
protocol does not care — §3.4's handshake is symmetric and a reader is simply a
peer that never authors events — but the UI cares a great deal, because the
distinction decides what the user can do.

| Tab kind | Origin | Writes | Blob source | Accepts drops |
|---|---|---|---|---|
| **Mode 1** | Created locally | Yes | Self only | Yes |
| **Mode 2 writer** | Created locally, shares a URL | Yes | Self only | Yes |
| **Mode 2 reader** | Joined by opening a URL | No | The writer (§3.4) | No |

Mode 1 and mode 2 writer feel identical to use; the meaningful split is
**writer vs reader**, and that is the one the tab must show. A reader who does
not know they are a reader will try to rename something and be silently ignored.

**Reader tabs must actually disable the write gestures**, not merely discard the
resulting events: rename, delete, drag-to-reparent, drag-in upload, and paste all
go inert, and drops onto the tab from other spaces (§8.5) are refused. §7.2's
"enforcement is by convention" is about the *protocol* — nothing stops a modified
client from forging writer events (§10.1) — but the shipped UI should still make
the honest path the only reachable one.

**A reader does not mint a `WriterId`.** §2 assigns one per browser profile per
space; a reader has no use for one and should not have one sitting unused, since
the only thing it could ever be used for is forging events under a chain the
reader does not own. If a reader tab is ever promoted to a writer, that is the
moment to mint one.

**A joined space derives its storage keyspace from the `space_id` in the URL**
(§2), not from a locally generated one. This is what makes reopening the same
link cheap: the reader finds its existing log and blob cache, and its `HELLO`
carries a non-empty VV (§3.4) instead of re-fetching the space from zero. A
reader that re-downloads every blob on each visit would also badly distort the
transfer measurements POC question 1 depends on.

**A reader with no writer connected** shows its last held state, marked stale
(§7.2), and every blob it does not already hold is *Unavailable* (§8.2) rather
than *Fetching* — there is no peer to ask.

---

## 9. Out of scope for v0

Listed so they are deferred rather than designed out:

- **Encryption.** Orthogonal, well-understood, and it slows every debugging
  session. The envelope boundary is: `value` and blob bytes are ciphertext;
  `writer`, `seq`, `prev`, `lamport`, `target`, `attr` stay plaintext so a
  hosted peer can reconcile without reading. Nonces must derive from
  `(writer, seq)`, not random, or identical events encrypt differently on
  different peers and dedup-by-ciphertext breaks.
- **Signing.** Needed before an untrusted hosted peer or mode 2 enforcement.
- **Compaction / snapshots** (§5).
- **Yjs objects** (§7.3).
- **Pinning peer.** Should be *just another peer* — same protocol, no privileged
  role — so it can be self-hosted, tested headlessly, and cannot become a
  dependency for correctness.
- **TURN.** The POC measures how badly it is needed rather than assuming.

---

## 10. Known-provisional decisions

Things chosen for POC speed that the rewrite should revisit:

1. **No signing** — mode 2 write restriction is convention only.
2. **Gap-fill retries forever (§3.3)** — a permanently missing event stalls that
   writer's chain indefinitely, loudly. In mode 2 that is the whole space.
3. **Cycle handling re-parents the smallest UUID to ROOT** — deterministic and
   cheap to compute, but it picks an arbitrary victim rather than the one the
   user would.
4. **16 KiB chunks, whole-blob retry** — neither tuned against real transfers.
5. **`:kind` advisory** — may need to be structural if the directory view grows.
6. **Truncated 16-byte hashes for `prev`/`EventId`** — collision-safe at POC
   scale (§2.1), not against an adversary.
7. **Star topology (§3.4)** — makes the writer a single point of failure for
   reader blob fetches, and defers the blob-availability exchange a mesh needs.
8. **Space mode fixed at creation (§8.3)** — no promoting a local space to a
   shared one, though the log and writer would carry over unchanged. Users will
   fill a local space and then want to share it.
9. **Blob store shared across spaces (§8.5)** — dedups and makes cross-space
   moves free, at the cost of leaking blob existence between spaces.

---

## 11. Build order

Deliberately sequenced so each stage is testable without the next.

1. **Fold, in isolation.** Pure function from event set to state. No networking,
   no storage. Tested by shuffling event orders and asserting the results are
   *equal*, not merely non-crashing — this is the commutativity property from
   §1.3, and it is the single most valuable test in the project. The shuffle must
   cover delete/undelete races specifically (§4.5 is where a naive incremental
   fold breaks, and shuffling is the only thing that catches it), plus absent
   blobs, unknown parents, and cycles.
2. **Mode 1, tree view.** Two-pane browser + localStorage + fold (§8). A real
   app with no peers. Delivers drag/paste-anything and shakes out the attribute
   model (question 2) — the tree stresses `:parent` and `:name` harder than a
   canvas would, since paths, renames, and sibling collisions are all visible in
   it.
3. **Spaces.** Tabs, multiple live logs, cross-space moves (§8.3, §8.5). Still no
   networking. Worth doing before transport: it is where a second independent log
   first exists, which is a cheaper place to find storage-keying mistakes than
   over a data channel.
4. **Transport, in isolation.** Two tabs, PeerJS, bytes moving reliably. Chunking
   and backpressure built here where they are visible (question 1).
5. **Mode 2.** Join 3 and 4. Measure connection failure rate (question 1), the
   stall rate from §3.3, and whether the URL-share flow feels good (question 3).
6. **Canvas.** Only if 1–5 land and time remains. `:pos` already exists (§4.4)
   and the fold already resolves it, so this is a view, not a model change —
   which is the point of holding it until last.
