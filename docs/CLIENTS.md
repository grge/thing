# Clients, holders, and how the pieces fit

**Status: partly built, and partly superseded.** `engine/client/` exists and
both consumers are built on it (steps 2–4 below). The lock, the socket and the
TUI are not.

**Read §"What append points change" at the end first.** The decision recorded in
`APPEND-POINTS.md` removes the reason for two of this document's conclusions —
the store lock as a correctness requirement, and writes going through the
holder. The reasoning that led here is kept because it is what surfaced the
constraint; the conclusions it reached under that constraint are marked.

**PLAN.md owns the build order.** The one at the end of this document is the
original decomposition, kept for its reasoning.

This document supersedes the earlier drafts of `ADMIN.md`, which framed the
terminal as a client of a server and got the default backwards.

Sections marked with what an earlier draft claimed are kept that way
deliberately: three of the wrong answers here were arrived at honestly and
discarded for specific reasons, and those reasons are load-bearing.

---

## What the code already says

Before proposing anything, what is actually there. Four findings, each of which
moved the design.

### 1. `Client` and `Peer` have already converged

`packages/web/src/client.ts` (566 lines) and `packages/node/src/peer.ts` (295)
were written separately, months apart, and arrived at the same structure:
`hold`, `attach`, `pushNew`, `requestBlob`, `close`, holding a map of spaces to
sessions and connections.

`pushNew` is the same function in both, down to the reasoning:

> Recomputed from the store rather than tracked, because what a session has sent
> is exactly what the store holds that the peer's vector does not.

`attach` carries the same `absorb` comment in both files, because the same
non-obvious thing had to be discovered twice. `Client`'s own header already
says it: *"the browser's counterpart to `@thing/node`'s `Peer`, and deliberately
the same shape."*

This is not an opportunity for reuse. It is **duplication that already exists**
and is already costing — the fix for hub convergence had to be understood in one
file and mirrored in the other.

### 2. `Client` is 566 lines of which five are browser-specific

Every use of a browser global:

```
 21  import { WebSocketSignalling }
 71  readonly iceServers?: readonly RTCIceServer[]
 96  private signalling: WebSocketSignalling | null
279  const socket = new WebSocket(url)
343  const signalling = new WebSocketSignalling(url)
```

Five lines, in two methods, all of it *transport construction*. The other 561
lines — holding, folding, sessions, activity, retries, blob requests, fork
reporting, backoff — are platform-neutral today and would compile in Node
unchanged.

The store, keystore and lock are already injected or trivially injectable.

### 3. The seam already exists, named on one side

`Session` takes a `Channel` — `send` plus `bufferedAmount` — so the protocol
layer is already transport-agnostic. `node/transport.ts` names the next layer
up as `Connection` (`onFrame`, `onClose`, `close`). The web client builds that
same shape inline, anonymously, in `connectTo` and `adopt`.

So the abstraction that would let one client serve both runtimes is not
speculative. It exists in `node`, and `web` reimplements it without a name.

### 4. `peer` is already on the platform-free side of an enforced boundary

`boundary.test.ts` asserts that `core`, `net`, `store` and `peer` compile with
`"types": []` and an ES2022 `lib`. A stray `localStorage` in `peer` is a
compile error today, guarded by a test that exists precisely because widening
`types` to fix one import silently loses the property everywhere.

**A shared client belongs in the engine.** No new boundary rule, and the test
that protects it is already written.

*(Since written: `core`, `store`, `net` and `peer` merged into
`packages/engine`. Nothing imported a subset of them, nothing was published,
and the four-way split had hidden the missing layer — `packages/peer` looked
like a real boundary, so nobody noticed it had stopped one level short of its
own doc comment. The platform boundary survives intact, since what matters is
the line between platform-free and platform-bound, not the lines between
`core` and `net`.)*

### 5. One stale comment, found while reading

`peer.ts:231` claims the push is "suppressed while a session is delivering".
No such flag exists. It is a survivor of the reverted hub-convergence change —
suppressing that push broke two peers converging through a hub, which is exactly
what forwarding is for (§5.6). The comment describes code that was correctly
removed. It should go with the work below rather than be left to mislead.

---

## The proposal

### One client, two transports

Move `Client` into `packages/engine` as the single implementation of *being a
peer*: holding spaces, folding, syncing, tracking connections and activity.

It takes its platform as constructor arguments:

| dependency | browser | terminal |
| --- | --- | --- |
| store | `IdbStore` | `FileStore` |
| keystore | `LocalKeystore` | key files |
| lock | Web Locks | lock file (below) |
| dial | `WebSocket` | `net.Socket` |
| listen | *(cannot)* | `PeerServer` |
| signalling | `WebSocketSignalling` | same, or none |

Two of these deserve comment.

**`listen` is optional, and that asymmetry is the design.** A browser cannot be
dialled (§5.6). It is not a lesser peer for it — it dials, or is introduced.
Modelling reachability as a capability a peer may or may not have is more honest
than two classes that differ by it, and it is what makes a browser and a headless
server the same kind of thing.

**`Peer` becomes this client with `listen` supplied.** `packages/node`'s `Peer`
does not survive as a parallel implementation; it becomes a thin construction of
the shared one. That is the whole point — one `attach`, one `pushNew`, one place
where the `absorb` subtlety lives.

### The client's API is the only way in

Everything above holds a `Client` and calls it. The next question is what
happens when the caller is not in the same process — a CLI command, a TUI, a
browser pointed at a server — and the answer that survived three wrong turns is
the plainest one: **the client's public surface is the API, and every mode is a
transport to it.**

Three earlier attempts, and why each failed, because the failures are what
argue for this:

1. **A remote `SpaceStore`.** Appealing because the interface exists and the
   conformance suite would cover it. Wrong because `append` is *verify*-then-
   write: `ChainSet.admit` checks signatures, and §2.3's "nothing enters a store
   unverified" would come to mean "unless my own socket sent it". `admit` is
   also stateful against a live `ChainSet`, so two clients through one remote
   store interleave into one chain. The conformance suite would have caught
   neither — it is single-client throughout.

2. **The CLI as an ephemeral peer**, syncing a replica and pushing writes back.
   Wrong because the CLI and the holder are not two peers: they contend for
   *one writer identity*. Both compute `seq` from the tip they last saw, both
   sign, and the second is refused as a `fork`. Silent write loss, and a
   fork-rejection retry loop to paper over it.

3. **Splitting reads from writes** — replica for reads, a write verb for
   writes, an admin channel for the rest. Three relationships with one object,
   which is one more than the object has.

What all three miss: **administration was always going to need an API.**
`shutdown`, `peers`, `hold`, `forget` have no expression in the sync protocol,
because sync is how two holders reconcile — never a vocabulary for telling a
holder what to do. Once that API exists, routing reads and writes through it too
is not extra machinery. It deletes the second mechanism.

And the API already exists. It is `Client`, essentially unchanged:

```
hold / release / forget      which spaces this peer holds
list / holding / space       what is here
join / adopt / peers         connections
requestBlob / availability   blobs
recent / observe             activity, and the view model
close                        lifecycle
```

plus `Space.write` for the write path. Admin verbs and data verbs in one object,
because it was one object all along.

**The write problem dissolves.** `write` is an API call, so the holder allocates
`seq` against the tip it authoritatively owns, signs, appends, and pushes. One
process advances a chain because only one process ever calls `append`. That is
the §7.3 hazard closed by construction rather than by a lock — the lock is left
guarding the case where there is no holder at all.

**Constraint, recorded now rather than discovered later: the control socket is
local only.** A caller that can reach it can write to every space the holder
holds. That is *fine* for a Unix socket in a permission-gated data directory —
anyone past that gate can read the key files anyway, so the holder is no more an
oracle than the filesystem is. It stops being fine the moment the socket is a
TCP port, and a `--port` flag is an obvious thing to want. No network transport
until there is an authentication story, and the API should distinguish `write`
from `shutdown` before it grows one.

### Three ways to run it

```
thing              holder + TUI, one process       the default
thing serve        holder, no interface            headless
thing attach       TUI over a running holder       remote control
thing <verb>       one-shot, print and exit        scripts and SSH
```

Four transports to one API. The browser is a fifth (above), and the fact that it
fits without a new vocabulary is the argument that the API is the right one.

**`thing` is one process.** The TUI is a renderer over a holder, not a client of
one. There is no protocol between the interface and the peer because there is
nothing between them — the TUI reads the client's state directly and redraws on
`subscribe`.

This is already how `serve` works. `activityLog` turns `Peer`'s callbacks into
printed lines; a TUI draws them instead. The default mode is not new machinery,
it is the existing peer with a screen.

**Only `attach` needs a wire**, and that is what lets it be the constrained
mode. Some things are cheap in-process and awkward over a socket — streaming a
large blob preview, for one. The default must not be designed down to what the
socket can carry.

### The web interface is a fourth transport

If the API is the only way in, the browser gets the same choice everything else
does: hold a client, or talk to one. Today `web/client.ts` assumes the first —
IndexedDB, `localStorage` keys, Web Locks — and that assumption is baked into
the class rather than chosen.

It should be chosen. The same UI, two ways:

```
browser + own storage    IndexedDB, its own keys, its own log      today
browser + a server       a window onto a peer that runs elsewhere  new
```

The second is worth having for reasons the first cannot cover: a phone that
should not hold a copy of everything, a shared machine where the log should not
land in browser storage, and — most practically — *looking at a running server
from a browser* instead of a terminal.

**What makes this a real test of the API rather than a restatement.** The
terminal cases can cheat: `thing` is in-process, and `thing attach` is a local
socket with the same trust as the process itself. A browser can do neither. If
the API survives a caller that is genuinely remote, genuinely untrusted, and
cannot read the key files, it is the right API. If it only works locally, it was
a function call wearing a protocol.

Which surfaces the one thing that does not travel. The UI already reaches into
the fold directly:

```
Tree.svelte      list(space.state, id)
Preview.svelte   entry(space.state, id), contentHash(space.state, id)
```

Those are pure functions over `State`, and today they are free — the fold is in
the same heap. Over a socket they are not, and this is the decision the remote
web client turns on:

- **Ship the fold.** The browser holds `State` and keeps calling `list` and
  `entry` locally. The UI does not change at all; the transport syncs state
  rather than answering queries. Costs a copy of the folded state in the
  browser, which is much smaller than the log.
- **Ship the answers.** `list` and `entry` become API calls. Nothing large is
  held, but every navigation is a round trip and the UI has to become
  async-aware throughout.

**Ship the fold.** The state is derived and disposable, the UI stays
synchronous, and it keeps the property that makes this design work elsewhere —
one vocabulary, and the remote case differs only in where the state came from.
"Ship the answers" is the browser equivalent of the remote-`SpaceStore` mistake:
moving a boundary to a place where every read pays for it.

Note this makes the remote browser a **replica of the fold, not of the log** —
it holds derived state and no events, so it cannot sign, cannot write directly,
and sends writes to the holder like any other client. Which is the same shape as
the CLI, arrived at from the opposite direction.

**What has to change in `web/`, and what does not.** The UI itself does not: it
already talks to `spaces()`, `subscribe`, `space()` and a handful of verbs, and
reaches into `state` for the rest. What changes is that `web/client.ts` stops
*being* the client and starts *choosing* one — local capabilities, or a
connection to a holder. That is the same refactor `node/peer.ts` already went
through, and for the same reason.

Not proposed for now. Recorded because it is what the API has to be able to
support, and because designing the socket without it in view is how it ends up
local-only by accident.

### The view model is the shared vocabulary

`SpaceStatus`, `PeerStatus`, `Activity` already exist in `client.ts` and are
already renderer-agnostic: they say *what to show* without saying how. They move
with the client into `peer`.

Then three things render the same structures:

- the web UI, in Svelte
- the TUI, in-process, drawing them to a terminal
- the TUI attached, drawing them after a socket round trip

and the control socket's only job is to carry that view model. It does not need
a vocabulary of its own, which is what open question 4 in the old draft was
really asking.

### The control socket, and what belongs on it

`thing` and `thing serve` listen on `control.sock` in the data directory. A Unix
socket, not a port: filesystem permissions on the data directory already say who
may administer this peer, so the access-control question answers itself. A port
would need authentication of its own for no gain.

It carries **the client's API** — every verb above, including writes, plus the
view model coming back. The earlier draft of this document said it should carry
administration and the view model but *not* editing, on the grounds that a
remote peer would not be allowed to edit. That test was the wrong one: it asks
what a *peer* may do, and a caller on this socket is not a peer. It is the
holder's own control surface, gated by the permissions on the data directory.

The right test is the one recorded above — local socket, full authority, and no
network transport until authentication exists.

### The single-writer guarantee

The precondition for all of it, and worth having alone: it turns a silent
corruption into a clear error.

`FileStore.open` takes an exclusive lock per space — a `lock` file holding pid
and start time. A second process opening a held space fails with "held by pid N"
rather than appending beside it.

This is the hazard `writelock.ts` already documents for browser tabs: two
writers resume from the same `seq` and `prev`, and **both events are validly
signed at the same sequence number.** Signing cannot catch it. §7.3 makes the
network converge, but one branch's writes are dropped silently.

Both lessons from the web lock carry over:

- **Release must survive abnormal exit.** A Web Lock is released when the tab
  closes with no path that leaks; a lock file has no such guarantee. Recording
  pid *and start time* makes a stale lock detectable — pid alone would lock
  someone out of their own space after a reboot reused the number.
- **A held lock is not an error to route around.** The CLI routes the write to
  the holder rather than breaking the lock.

Behind the `SpaceStore` interface, so the conformance suite covers it and every
backend inherits it.

### The CLI stays, and stays one-shot

`thing peers`, `thing put`, `thing shutdown` — print and exit. For scripts, SSH
sessions, and anyone who does not want a full-screen program. Same socket
`attach` uses.

Every space-touching command follows one rule:

> If a holder has this space, ask it. Otherwise take the lock and open the store
> directly.

Both sides of that are the *same client*; only the transport differs. With a
peer running, the command holds a client that is a socket to the holder. With
nothing running, it constructs one over local capabilities and becomes the
holder for its own lifetime — today's offline editor, still legitimate for
seeding, recovery and inspection.

So the two branches are one line of construction, not two implementations of
each command. That distinction is the whole reason for routing everything
through the API: the alternative was five commands each written twice, which is
the shape we just finished deleting from `Client` and `Peer`.

**The writing key stays with the holder.** An earlier draft had clients read the
key file and sign for themselves, reasoning that a signing holder would be an
oracle for anyone who can reach the socket. Both halves were wrong. The oracle
concern is empty for a local socket — anyone who can reach it can read the key
file anyway — and signing locally does not work regardless: `seq` and `prev`
come from the chain tip, and a client that signs against a tip the holder has
already advanced produces a second event at one sequence number, which `admit`
refuses as a `fork`. Only the process that owns the chain can allocate a
position in it.

---

## Why not the alternatives

**Why not leave `Client` and `Peer` separate?** They have already converged by
accident, and the duplication has already cost: the hub-convergence fix had to
be understood twice. Two implementations of `attach` means the next subtle
discovery gets fixed in one and not the other. The five browser-specific lines
are not enough divergence to justify it.

**Why not a directory watcher instead of the lock?** It closes the notification
gap and leaves the race untouched — both processes still hold independent
`ChainSet`s and still append concurrently. The window narrows without closing,
making corruption rare rather than absent. A race that fires monthly is one
nobody can reproduce.

**Why not make the TUI always attach, even locally?** It would make one code
path instead of two, which is genuinely attractive — and the API decision above
weakens the case against it, since both modes now call the same surface and no
feature is available to one and not the other.

What survives is cost, not capability. The default mode would pay serialisation
on every redraw for state sitting in the same heap, and `thing` on a laptop
would need a socket to talk to itself. Keeping the in-process path is a
performance choice with the interface held constant, which is a much smaller
claim than the one this paragraph used to make.

It is worth revisiting if the two paths ever drift. Sharing an interface but not
an implementation is exactly the setup that let `Client` and `Peer` diverge, and
the mitigation is the same: the in-process path should be a thin construction of
the API, not a shortcut around it.

**Why not Ink (React for terminals)?** The whole repo has four runtime
dependencies: two crypto, one WebSocket, one types package. Ink brings React and
a reconciler to redraw text. The TUI should render the view model with ANSI
escapes directly, or take one small library — the leanness is a property worth
keeping, and the view model means the drawing code is small either way.

---

## Build order

Each step is useful on its own, which is the test that the decomposition is
right.

1. ~~**The store lock.**~~ **Superseded** — see the end of this document. It was
   independent of everything else and turned silent corruption into an error;
   append points remove the corruption instead.
2. ~~**Name `Connection` in the web client.**~~ **Done.** The shape is now
   `engine/client/types.ts`'s `Connection`, and the web client builds one in
   `socketConnection`/`rtcConnection` instead of inline objects.
3. ~~**Move `Client` into the engine.**~~ **Done.** `engine/client/` holds it,
   taking store, keystore and lock as capabilities. `listen` stayed out: a
   browser cannot accept connections, so accepting is not part of *being a
   peer* — whoever has an address feeds connections to `Client.adopt`.
4. ~~**Rebuild `Peer` on it.**~~ **Done.** `node/peer.ts` went from 292 lines to
   151 and now holds only a directory, an address, and the callback shapes the
   CLI wants. The duplicate `attach`/`pushNew` are gone, and the stale comment
   at `peer.ts:231` went with them.
5. **Route the CLI through the holder.** *Superseded in mechanism, not in goal:
   with append points the CLI writes its own chain and syncs, rather than asking
   the holder to write.* `thing put` against a running peer
   reaches connected clients without a restart. This is the bug that started all
   of it.
6. **The control socket,** carrying the client's API. Local only.
7. **The TUI,** in-process first. `attach` after, once there is something to
   attach to.
8. **The browser as a client of a holder** — the fold shipped over the socket,
   the UI unchanged. Not soon, but the API is designed so this needs no new
   vocabulary, and that is the test of whether step 6 got it right.

Steps 1–5 close a correctness bug and delete a duplicated implementation. They
are worth doing whether or not the TUI is ever built.

### What the merge turned up

Three things, none of which the type checker or the existing tests would have
found:

- **A duplicate frame handler**, introduced and caught in the same sitting. Both
  ways into a connection wired delivery, so every frame on an adopted connection
  was processed twice — invisible from outside, because the store deduplicates
  what it causes. Two real processes syncing showed it as a doubling of the
  delivery count against the pre-merge baseline. `attach` no longer owns
  delivery: `adopt` reads frames itself to find the space, so it registers the
  handler, and `join` registers its own.

- **A race in `adopt`, pre-existing.** `attach` is asynchronous, and the guard
  was `session === null`, so several frames arriving while it ran could each
  start another session. The guard is now the *promise*, and frames that arrive
  while a session is opening await it in order. The same shape was in the
  original `Peer.adopt`; carrying it into one place is what made it worth
  fixing once.

- **A missing lock means unlocked, not locked.** The first cut opened a space
  read-only whenever no lock was supplied, which silently stripped write access
  from every peer without a lock mechanism. Caught by `peer.test.ts`.

One thing deliberately *not* changed: a peer may send the same range more than
once (reconciliation on HELLO, then answering a WANT), and `receive` is
fire-and-forget, so two applications of one range can overlap and report the
same event twice. That is pre-existing, harmless — the store deduplicates — and
belongs to the protocol rather than to this class.

---

## Open questions

1. **Does `thing` auto-attach when a peer is already running?** It cannot hold
   the same spaces — the lock forbids it. Auto-attaching is convenient and
   slightly surprising; failing with "already running, use `thing attach`" is
   clear and annoying. Leaning toward auto-attach with the mode visible on
   screen, since the alternative makes the default command fail for a reason the
   user did not cause.

2. **Does `thing put` return on local durability or replication?** Local
   durability is the honest answer — a holder cannot promise anything about peers
   it does not control — but "wrote it" reading as "everyone has it" is a natural
   misreading worth wording against.

3. **A lock held by a hung process.** Pid alive, so not stale, but nothing
   answers on the socket. A `--force` is easy to add and easy to misuse.

4. **Does the browser get `listen` when WebTransport allows it?** Not today. The
   capability model above means the answer is "supply the argument", which is the
   reason to model it that way now.

5. ~~**What does `attach` do that the in-process TUI cannot?**~~ **Answered by
   the API being the only way in:** nothing. Both modes call the same surface,
   so a feature that works in one works in the other. What remains is a
   *performance* question rather than a capability one — a large blob preview
   over a socket is slow, not impossible — and the fold-shipping decision in the
   browser section is the same question in its sharpest form.

6. **What is the API's transport encoding?** Unresolved and deliberately not
   decided here. It must carry method calls, async iterables (`readAll`,
   `blobHashes`), streamed bytes with backpressure, and a subscription for the
   view model. The existing framing in `net/protocol.ts` solves the last three
   for the sync protocol already, and is the obvious thing to look at first —
   but sync frames are not method calls, and forcing one into the other is how
   the remote-`SpaceStore` mistake happened.

7. **Does the view model push or pull?** `observe` is a callback in-process. Over
   a socket that is a subscription, and a client that redraws on every event of
   a busy sync is a client that spends its time redrawing. Some coalescing
   belongs in the protocol.

---

## What append points change

Written after the fact. `APPEND-POINTS.md` decides that the event envelope gains
a per-process `point`, so two processes of one identity extend separate chains.
Three of this document's conclusions do not survive that.

**The store lock stops being a correctness requirement.** Step 1 exists because
two processes sharing a writer key produce two validly signed events at one
sequence number. With separate chains they do not, so nothing is corrupted by a
second process writing. A lock may still be wanted — to stop two holders
competing for one address, or as a "something is already running here" signal —
but that is operational, not integrity.

**Writes stop having to go through the holder.** The argument was that `seq` and
`prev` come from the chain tip, so only the process owning the chain can allocate
a position. With per-process points, a CLI owns its own chain and can write
directly, then sync. The CLI becomes an ordinary peer again — which is what §5.6
always claimed and what this document had to carve an exception to.

**The socket's contents narrow, for a better reason.** It still carries the
client's API. But editing is no longer *on* it because editing does not need to
be: administration and the view model are what is left, rather than what was
selected.

**What survives, and is the part worth keeping:** the client's API is the only
way in, every interface is a transport to it, the socket is local-only until
authentication exists, and the browser is the real test of whether the API is
right. Those did not depend on the constraint.

`writelock.ts` also stops being needed for correctness — two tabs get two
points — though it may survive as a UX choice about which tab is editing.
