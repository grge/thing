# Findings — v0 POC

Evidence gathered while building the POC, against the three questions in
[SPEC.md](SPEC.md) §0. Companion to [PLAN.md](PLAN.md), which says *what* to
build; this records *what was learned*.

The POC exists to make three questions answerable with evidence. Anything here
that is a guess is labelled a guess.

## Status

| Question | Status |
|---|---|
| 1. Does WebRTC blob transfer work in practice? | works in Chromium and Firefox over HTTPS; **real networks unmeasured** |
| 2. Does the UUID + LWW-attribute model survive real filesystem operations? | yes, so far — including concurrent writers |
| 3. Does paste-then-share-a-URL feel good? | flow works end to end; judgement pending |

---

## Q1 — WebRTC

### F1. Firefox needs a secure context to gather usable ICE candidates

**2026-08-29, stages 4 and 5.** Two observations, and the second corrects the
first.

**What was seen at stage 4.** Over `http://localhost:5177`, Firefox 99 failed
every connection while Chromium on the same machine connected in 330 ms. The one
candidate Firefox gathered was:

```
candidate:0 1 TCP 2105524479 e1fc1710-….local 9 typ host tcptype active
```

TCP only, no UDP candidates at all — and port 9 with `tcptype active` means "I
dial out, I cannot be dialled". A TCP pair needs one `passive` side; both peers
offered `active`, so no candidate pair was ever checkable, and
`iceConnectionState` went straight to `closed` without entering `checking`.
Signalling was never implicated: offer, answer, and candidate exchange all
completed.

**What was seen at stage 5.** The same Firefox, against the HTTPS deployment at
`grge.github.io`, **works** — sync and blob transfer both.

**Corrected diagnosis.** The variable is the *secure context*, not the browser
version. `http://localhost` is treated as secure by Chromium but Firefox is
stricter about what ICE gathering it permits on a non-HTTPS origin, and the
symptom matches: obfuscated `.local` hostnames and no UDP host candidates.

The stage 4 write-up blamed a stale browser plus
`media.peerconnection.ice.proxy_only_if_behind_proxy = true`, the profile's only
WebRTC pref. **That was wrong** — or at least unnecessary. The pref was never
cleared and retested, and the HTTPS result explains the behaviour without it.

**Consequences:**

1. **Test over HTTPS.** This is why the app is deployed to GitHub Pages rather
   than served from a LAN IP: `http://<lan-ip>` is not a secure context either,
   so the obvious `npm run dev -- --host` route would have hit the same wall on
   a second machine.
2. **The earlier "browser incompatibility" was an artifact of the test setup**,
   not a property of WebRTC or of Firefox. Worth stating plainly, because a POC
   measuring viability could easily have recorded a false negative here and
   concluded something quite wrong about browser support.
3. Nothing in stage 4's *protocol* findings is affected — the framing work and
   F3's transfer numbers stand.

**Method note.** The stage 4 diagnosis reasoned carefully from real evidence and
still reached the wrong cause, because it never varied the one thing that
mattered. Reading the ICE candidate closely made the mechanism obvious in
hindsight — `.local` obfuscation is itself a secure-context-adjacent behaviour —
but the conclusion was fixed before that connection was made.

### F2. PeerJS is two products, and using both makes Q1 unmeasurable

**2026-08-29, stage 4.** PeerJS does two separable jobs:

1. **Signalling** — broker a peer id, relay offer/answer SDP and ICE candidates.
   Once the connection is up it is out of the path entirely.
2. **A messaging layer over the data channel** — `conn.send()` applies its own
   serialization (BinaryPack or JSON), its own chunking at 16300 bytes, and its
   own reassembly.

Only the first was wanted. Using the second put a second chunking protocol
underneath ours — the one §6 introduced chunking to control — and meant every
number for Q1 would describe PeerJS-over-WebRTC rather than WebRTC.

Symptom that exposed it: `Message too big for JSON channel`, one error per
chunk. The chunk size had been set to 16 KiB against the SCTP limit, but the
payload was base64 inside a JSON envelope, so the encoded message was ~21.9 KB
against a **library** cap of 16300 — a limit that has nothing to do with SCTP
and would not exist in a direct implementation.

**Fixed by narrowing PeerJS to job 1.** `Signalling`/`PeerLink` (signalling.ts)
is now the interface; `PeerJsSignalling` implements it and reaches through to
`conn.dataChannel` — the real `RTCDataChannel` — with `serialization: 'none'`.
`conn.send()` is never called. Framing is one tag byte: `0x01` for UTF-8 JSON
control messages, `0x02` for `[tag][32-byte hash][u32 index][u32 chunks][u32
total][raw bytes]`.

Consequences:

- base64 is gone; a chunk costs a fixed 45-byte header instead of +34%
- chunk size is back to 16 KiB, sized against SCTP as §6 intends
- `bufferedAmount` is the data channel's own, not a wrapper's
- a self-hosted signal server can replace `PeerJsSignalling` with no change above
  it — no hard dependency on PeerJS remains

**The lesson worth carrying:** a library that bundles discovery with transport
will silently become the thing you are measuring. The `Channel` interface meant
the swap touched one implementation and left the 21 transfer tests untouched —
they now decode real wire frames, so they assert against bytes that would
actually be sent.

### F3. First successful transfer: 4 MB, hash-verified, ~1.6 MB/s on loopback

**2026-08-29, stage 4.** Chromium, two tabs, one machine.

```
00:14:20.437  dialling 11e78dee…
00:14:21.145  connected                    (708 ms)
00:14:38.834  WANT c20274c7…
00:14:41.353  received 4194304 bytes, hash verified
```

| | |
|---|---|
| Payload | 4,194,304 bytes (4.00 MiB) |
| Chunks | 256 × 16 KiB |
| Wire bytes | 4,205,824 (**+0.27%** framing overhead) |
| Transfer | 2.519 s → **1.59 MB/s**, 13.3 Mbit/s |
| Connect | 708 ms, no relay (loopback) |
| Integrity | passed first attempt, no retries |

The framing overhead is worth contrasting with what it replaced: base64 would
have put **5.36 MB** on the wire for the same 4 MB payload. The binary frame
costs 45 bytes per chunk — 11.5 KB total.

**What this does and does not establish.** It establishes that the protocol
works: chunking, framing, reassembly, backpressure, and whole-blob integrity all
function against a real `RTCDataChannel`, and 4 MB arrives byte-exact. It does
**not** answer Q1, which asks about peer pairs across real networks. Loopback has
no NAT, no packet loss, and no bandwidth ceiling worth the name — 1.59 MB/s here
is a floor set by our own chunking and hashing, not by the network.

### F4. Still to measure

The numbers §11.4 of PLAN.md calls for — peer-pair connection failure rate
without TURN, relay usage fraction across real networks, throughput off
loopback, whole-blob retry frequency under loss — **have not been collected.**
The harness records all of them (`src/net/metrics.ts`, "Copy JSON"), and F3
shows the instrument works. What is missing is two machines on two networks.

---

## Q2 — the attribute model

### F5. `(lamport, writer)` is only a total order because a writer's own lamports strictly increase

**2026-08-29, stage 1.** Found by the commutativity property test on its first
run, which shrank to a three-event counterexample: two `:parent` events from the
**same writer at the same lamport**. The fold picked whichever arrived last.

The generator was wrong, not the fold — a writer increments unconditionally on
create, so same-writer ties cannot occur. But the spec never said so, and every
LWW resolution in §4 silently depends on it. A writer that reused a stamp would
degrade the whole model to arrival order while still appearing to work.

Written into SPEC §2.2, with `checkWriterLamports()` to catch violations in any
log loaded from storage or received from a peer.

**The general lesson:** the property test earned its cost immediately, and it
found a *specification* gap rather than a coding error. Shuffling is the only
thing that catches this class of bug.

### F6. `ROOT` is materialised as an object by a total fold

**2026-08-29, stage 2.** The fold must be total (§3.5), so an unknown parent
becomes a bare object — and `ROOT` is an unknown parent the moment anything is
parented to it. Because its own `:parent` defaults to `ROOT`, it then appears as
its own child, and the tree rendered a stray unnamed row at top level.

Every consumer of folded state has to skip `ROOT`. Cheaper than special-casing
it inside the fold, but it had to be written down (SPEC §4.1) or each consumer
rediscovers it.

### F7. The model has survived ordinary filesystem operations so far

Create, rename, move, delete, undelete, nested directories, duplicate sibling
names, and cross-space moves all fold correctly, and 97 tests pass including
property-based shuffling.

**This is not yet an answer to Q2.** Everything so far is a single writer. The
attribute model's interesting cases — concurrent writes to different attributes
of one object, delete racing a write, two peers moving the same subtree — need
stage 5 and a second real writer. What can be said is that nothing has gone
wrong in the easy half.

---

### F8. Sync works between two browsers; one bug class was transmission, not model

**2026-08-29, stage 5.** Two Chrome sessions, writer and reader, same machine.

Working: a reader opens a share URL and replicates the space; the writer's
creates and renames appear immediately; blobs fetch on demand when the reader
selects a file.

One bug found in testing, and its shape is the interesting part. Dragging a file
*into* the writer's space did not reach the reader — but **reloading the reader
fixed it**. The events were correct and already in the log; only the broadcast
was missing, because a cross-space move writes to two logs (fresh events in the
destination, a tombstone in the source) and the UI flushed only the visible one.

That the fold produced correct state from a late, out-of-order batch is §1.3
behaving exactly as specified. The failure was in transmission, and the model
absorbed it without special handling. This is weak evidence *for* the design:
the class of bug that remains possible is "we forgot to send something", not "we
sent it and the state diverged".

## Q3 — does it feel good?

**Reachable now, not yet judged.** The full loop works: create a writer space,
add files, copy the share URL, open it elsewhere, watch it replicate. Whether it
*feels* good is a judgement that needs more than a first run, and unlike Q1 and
Q2 it cannot be settled by a test.

The spatial half — paste onto a canvas — needs stage 6 and may not be built.

---

## Method notes

- **Transport is testable without a network.** `blobtransfer.ts` depends only on
  a two-member `Channel` interface, so chunking, backpressure, resume, and
  integrity have 18 tests that need no browser. This was worth the indirection:
  when PeerJS failed, none of those tests were implicated, which localised the
  problem in one step.
- **PeerJS's error messages discard the underlying cause.** "Negotiation of
  connection failed" is what surfaces; the real reason only appears in the
  browser console at `debug: 3`. The harness now logs ICE state transitions
  directly for this reason.
