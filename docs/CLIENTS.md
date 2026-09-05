# Clients, holders, and how the pieces fit

**Status: a proposal.** Nothing here is built. It supersedes the earlier drafts
of `ADMIN.md`, which framed the terminal as a client of a server and got the
default backwards.

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

### Three ways to run it

```
thing              holder + TUI, one process       the default
thing serve        holder, no interface            headless
thing attach       TUI over a running holder       remote control
```

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

The test for what belongs on it:

> *Would a remote peer be allowed to do this?*

`put` would — a browser writes files, over the sync protocol, and needs nothing
new. `shutdown` would not. So the socket carries **administration and the view
model**, not editing.

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

With a peer running, `thing put` connects and the holder folds and pushes to
everyone connected. With nothing running, it is the offline editor it is today —
which remains legitimate for seeding, recovery and inspection.

**The writing key.** A client that edits must sign, so it needs the keypair. The
key file sits beside the store, which the holder has locked — but locks cover the
log, and keys are never appended to, so a client reads it directly. Having the
holder sign for clients would make it a signing oracle for anyone who can reach
the socket.

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
path instead of two, which is genuinely attractive. But it means the common case
pays a serialisation round trip for state it could read directly, and it forces
every future TUI feature through a socket protocol — the constraint would leak
into the design of things that have no reason to be constrained.

**Why not Ink (React for terminals)?** The whole repo has four runtime
dependencies: two crypto, one WebSocket, one types package. Ink brings React and
a reconciler to redraw text. The TUI should render the view model with ANSI
escapes directly, or take one small library — the leanness is a property worth
keeping, and the view model means the drawing code is small either way.

---

## Build order

Each step is useful on its own, which is the test that the decomposition is
right.

1. **The store lock.** Independent of everything else. Turns today's silent
   corruption into an error. Conformance-suite covered.
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
5. **Route the CLI through the holder.** `thing put` against a running peer
   reaches connected clients without a restart. This is the bug that started all
   of it.
6. **The control socket,** carrying the view model and the admin verbs.
7. **The TUI,** in-process first. `attach` after, once there is something to
   attach to.

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

5. **What does `attach` do that the in-process TUI cannot?** Worth deciding
   deliberately rather than discovering. Large blob previews and anything
   streaming are the obvious candidates for "in-process only".
