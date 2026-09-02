# Build plan — v0 POC

> **Archived — the v0 record.** Every stage below is finished; this is history,
> not a work list. The sequence for the next round is in
> [../V1.md](../V1.md).
>
> One status note that outlived the plan: the real-network measurements stages 4
> and 5 ask for were never taken, and are now **not going to be** —
> [../NEXT.md](../NEXT.md) settled that TURN is in rather than measuring how
> often peers fail without it. See [../DESIGN.md](../DESIGN.md) §7.

Companion to [SPEC.md](SPEC.md). The spec says *what* v0 is; this says what gets
built in what order, what proves each stage done, and where the work stops for a
decision. Evidence gathered along the way goes in [FINDINGS.md](../FINDINGS.md) —
the POC's actual output.

Section references (§) point into SPEC.md throughout.

## The rule

**Each stage is testable without the next.** Nothing below needs a later stage to
demonstrate. A stage that cannot be shown working on its own has been scoped
wrong.

## Sequence at a glance

| Stage | Answers | Risk retired | Gate |
|---|---|---|---|
| 0 Transport spike | — | Is WebRTC viable at all | throwaway |
| 1 Fold | — | Commutativity (§1.3) | |
| 2 Mode 1, tree view | Q2 | Attribute model vs. real operations | **design system** |
| 3 Spaces | — | Storage keying, multi-log isolation | |
| 4 Transport | Q1 (partly) | Blob transfer, chunking, backpressure | |
| 5 Mode 2 | Q1, Q3 (partly) | Sync protocol, connection failure rate | |
| 6 Canvas | Q3 (rest) | — | |

"Q1/Q2/Q3" are the three POC questions in §0.

---

## Stage 0 — Transport spike (throwaway)

An afternoon. Two tabs, PeerJS, no chunking, no correctness, no integration:
*do two browsers connect, and can a megabyte cross?*

**Why before anything else:** Q1 is the highest-risk question and it is otherwise
not answered until stage 5. If WebRTC turns out to be unworkable without a TURN
relay, that changes the shape of the project, and finding out in week one is
worth an afternoon.

**Deliberately throwaway.** Nothing here survives into stage 4. Resist making it
good; the point is a number, not a foundation.

**Serve it over HTTPS.** Firefox will not gather usable ICE candidates on a
plain `http://` origin other than `localhost`, so a spike served from a LAN IP
reports a failure that is about the test setup rather than about WebRTC
(FINDINGS F1).

**Output:** a rough connection success rate across whatever machines and networks
are to hand, and a note on whether TURN looks mandatory.

---

## Stage 1 — Fold, in isolation

Pure function, event set → state. No networking, no storage, no UI, no browser.

**Build**
- Canonical encoding (§2.1) and hashing — fixed field order, length-prefixed
  values, no floats in hashed positions.
- The `Event` type (§2) and `EventId`.
- The fold: per-`(target, attr)` LWW by `(lamport, writer)`.
- The `:deleted` predicate (§4.5) — computed over the whole event set, never
  incrementally.
- Cycle-breaking over the resolved parent map (§4.1) — smallest UUID in each
  cycle re-parented to `ROOT`, as fold-local state rather than an event.
- Path derivation by walking `:parent` (§4.1).

**Done when**

Shuffling event orders yields **equal results**, not merely absence of crashes.
This is §1.3, and it is the single most valuable test in the project. The shuffle
must cover:
- delete/undelete races (§4.5 is where a naive incremental fold breaks, and
  shuffling is the only thing that catches it)
- absent blobs
- unknown parents
- cycles, including multi-object ones

**Why first:** the only stage with a mechanically checkable correctness property,
and everything downstream assumes it holds.

**Not here:** persistence, `WriterId` generation, anything async.

---

## Stage 2 — Mode 1, tree view

The first real app. One space, one writer, localStorage, no peers.

> **Gate: design system — CLEARED 2026-08-29.** Direction approved from a static
> mockup: greyscale convivial core, TUI-tight rows, mono for data with sans for
> chrome, preview states as a status line plus detail block. Tokens live in
> `src/ui/tokens.css`, which documents the three departures from the convivial
> common core. The gate reopens at stage 6 — see [Design gate](#design-gate).

**Build**
- Event creation: the writer's `seq` / `prev` / `lamport` bookkeeping (§2, §2.2).
- localStorage persistence for events; IndexedDB, content-addressed, for blobs.
- Two-pane browser (§8.1): tree left, preview right. Expand, collapse, select,
  rename, drag to re-parent, delete.
- Preview states (§8.2) reachable at this stage: **rendered** (text),
  **not renderable**, **no content**.
- Getting content in (§8.4): drag files into the window; paste text as a
  plaintext file, named from its first line with a timestamp fallback.

**Done when**

Drag in files, paste text, rename, re-parent, delete, undelete, reload the tab,
find it all intact. Sibling name collisions render without complaint (§4.2). A
`dir` with content and a `file` with children both render sensibly (§4.6).

**Why here:** this answers **Q2** — does the UUID + LWW model survive real
filesystem operations? Only discoverable by folding real event sequences, and
this is the first stage that produces them. The tree stresses `:parent` and
`:name` harder than a canvas would, because paths, renames, and sibling
collisions are all visible in it.

**Not here:** `Fetching` and `Unavailable` preview states — there is no peer to
fetch from, so every blob is local.

---

## Stage 3 — Spaces

Tabs, multiple live logs, cross-space moves. Still no networking.

**Build**
- Per-space storage keyspaces (§2) — one per space, externally keyed.
- Tab UI with visual distinction (§8.6), minus the reader kind, which does not
  exist until stage 5.
- N simultaneous folds, one per open space.
- Shared blob store across spaces (§8.5), content-addressed so it dedups.
- Cross-space move (§8.5): copy blob, mint a **new UUID**, write fresh
  `:kind` / `:name` / `:content` / `:parent` under the destination's writer,
  tombstone the source. Not a `:parent` write.

**Done when**

Two mode 1 spaces coexist in tabs. Dragging a file from one to the other gives
the destination a new UUID and the source a tombstone. Reloading restores both
spaces independently.

**Status: done 2026-08-29.** `src/app/spaces.ts` holds every registered space
open at once; `Space.adopt` recreates an object (with its subtree) under a new
UUID in the destination. Reader tabs refuse inbound drops and their write
gestures are inert. 73 tests pass, including keyspace isolation — that neither
space's localStorage log contains the other's content, and that seq counters
advance independently from zero.

**Why before transport:** this is where a second independent log first exists.
Storage-keying mistakes — logs bleeding into each other, `WriterId` collisions,
blob store confusion — are far cheaper to find locally than over a data channel,
where they present as sync bugs.

---

## Stage 4 — Transport, in isolation

Two tabs, PeerJS, bytes moving reliably. No fold, no UI integration.

**Build**
- PeerJS connection setup and signaling.
- Chunking at 16 KiB (§6) — SCTP message limits make this mandatory.
- Backpressure via `bufferedAmount` watermarks on the data channel.
- `WANT` / `BLOB` / `NOBLOB` (§6).
- Whole-blob integrity verification by hashing the reassembly before accepting.
- Resume by re-requesting from a chunk index.

**Done when**

A multi-megabyte blob crosses between two tabs, verifies, survives a mid-transfer
disconnect, and resumes without starting over.

**Status: working 2026-08-29, real-network measurement outstanding.** A 4 MB
blob transfers between two Chromium tabs and verifies (FINDINGS F3). `src/net/` holds
the protocol, the transfer engine, metrics, and a thin PeerJS binding; the
harness is `src/ui/transport.html`. 18 transfer tests cover chunking, out-of-order
and duplicate chunks, whole-blob integrity, resume without re-sending, and
backpressure — all against a fake channel, no network needed. **The numbers POC
question 1 asks for require two real browsers and have not been collected.**

**Why isolated:** this is **Q1**, the highest-risk item and the least dependent
on the rest of the design. Standalone means chunking and backpressure bugs
present as transport bugs rather than as mysteriously missing files.

**Instrument from the first commit.** Connection success rate, time-to-connect,
whether TURN would have been needed, whole-blob retry frequency. These numbers
are the deliverable, not a side effect.

---

## Stage 5 — Mode 2

Join stages 3 and 4. The largest stage, and the one most likely to expose gaps in
the spec.

**Build**
- `HELLO` / `EVENTS` / `GAP` handshake (§3.4).
- Version vectors (§3.1), including the contiguity rule — a peer holding 0–47 and
  49 reports 47.
- Hold-aside buffer for out-of-order arrival within a writer (§3.3), with the
  5-second `GAP` re-issue on backoff and loud stall logging.
- URL generation and the join flow; `space_id` and `role` hint (§7.2).
- Joined-space keyspace derived from `space_id` (§8.6), so reopening a link finds
  the existing log and blob cache and sends a non-empty VV.
- Reader tabs (§8.6): no `WriterId` minted; rename, delete, drag-to-reparent,
  upload, paste and inbound drops all inert.
- Preview states **Fetching** and **Unavailable** (§8.2), distinct from each
  other.
- Stale-state display for a reader with no writer connected (§7.2).

**Done when**

A writer shares a URL. A reader opens it in a different browser, sees the tree,
selects a file and watches the blob arrive, and sees the writer's subsequent
edits appear live. Closing the writer's tab leaves the reader with its held state
marked stale and unfetched blobs marked unavailable.

**Status: working 2026-08-29.** Two Chrome sessions replicate end to end
(FINDINGS F8). The measurements below still need two machines on two networks.

**Measure** — this stage produces the POC's evidence:
- peer-pair connection failure rate without TURN (**Q1**)
- §3.3 stall frequency
- whole-blob retry frequency
- whether the URL-share flow feels good (**Q3**, paste-and-share half)

Write these into [FINDINGS.md](../FINDINGS.md). A number in a console log is not a
finding.

**The UI built for this stage is desktop-only.** The README's own two-device
test asks for a phone on a hotspot, and Q3 is best tested on whatever device a
shared link actually gets opened on — usually a phone. [MOBILE.md](MOBILE.md)
plans what that needs and in what order; it is not gated on this stage
finishing, but its Stage B (touch-safe reader) is where the phone half of this
stage's own measurements come from.

---

## Stage 6 — Canvas

Only if 1–5 land and time remains.

`:pos` already exists (§4.4) and the fold already resolves it, so this is a
**view, not a model change** — which is the whole reason it is held until last.
Answers the spatial half of **Q3**.

Expect the design gate to reopen here: a canvas is a different visual problem
from a tree, and the design system from stage 2 will not simply extend to it.

---

## Design gate

**The UI design system is not a decision to make in passing, and not one to make
alone.** Stage 2 builds the first interface in the project; everything visual
downstream inherits from it.

The work pauses before styling. Behaviour gets built against unstyled markup —
the tree expands, the preview switches states, drag-and-drop works — and the
visual language is settled separately, iteratively, before any of it is dressed.

What needs deciding at the gate, at minimum:
- typography, spacing scale, colour
- density — a file tree is an information-dense control, and this is the choice
  that most shapes how the thing feels
- how the five preview states (§8.2) are distinguished
- how the three tab kinds (§8.6) are distinguished, given that writer-vs-reader
  is the split that changes what the user can do
- how `cycle-broken` objects (§4.1) and stale state (§7.2) are surfaced

The last three are not decoration. They are the UI's share of making the fold's
totality (§3.5) visible, and getting them wrong hides exactly the conditions the
POC is trying to observe.

---

## Risks

**The three questions are answered late.** Q1 and Q3 both land in stage 5, fifth
of six. A project that runs out of time at stage 4 has built a pleasant local
file browser and learned nothing about WebRTC. Stage 0 exists to blunt this, and
it is the reason it is worth an afternoon on something disposable.

**Stage 5 is the biggest stage by some margin.** It is the only one combining two
prior stages, and the only one where a bug can plausibly originate in either. If
it needs splitting, the seam is: handshake and event sync first, blobs second.

**The design gate is a real pause.** It is placed at stage 2 deliberately —
early, where the cost of iterating is markup and not a codebase. Treating it as a
formality reintroduces the cost later, at stage 6, on a larger surface.
