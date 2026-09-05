# Running a peer: the TUI, the daemon, and the CLI

**Status: a design, not yet built.** Nothing here exists.

---

## Three ways to run one thing

```
thing              holder + TUI, one process       the default
thing serve        holder, no interface            headless
thing attach       TUI over a running holder       remote control
```

The first is the important one, and it is where the earlier draft of this
document was wrong. It framed the TUI as a client of a server. It is not:

> **The TUI is a renderer over a holder, not a client of one.**

Running `thing` starts a peer that holds spaces, serves them, and draws itself.
There is no protocol between the interface and the peer, because they are the
same process — the TUI reads `Peer`'s in-memory state directly and redraws when
it changes.

`serve` is that same peer with the drawing omitted. `attach` is the drawing
without the peer, over a socket to one running elsewhere. Only `attach` needs a
wire format, which is what makes it the mode that can afford to be limited.

## Roles, not programs

Underneath, one distinction:

> A **holder** owns a space's log — it has the write lock, the `ChainSet`, the
> fold. Exactly one per space, machine-wide.
>
> A **client** asks a holder to do things.

`thing` and `thing serve` are holders. `thing attach` and the browser are
clients. The browser is *also* a holder for its own spaces, which is why
`writelock.ts` had to exist there first: two tabs are two would-be holders of
one space, and something had to arbitrate.

## The problem this fixes

Today's CLI is an **offline editor**. `thing put` opens a store, appends, and
exits. That is legitimate when nothing else is running — seeding a space,
recovering something, inspecting a log. It is the exceptional mode.

The bug is that it behaves identically when a space is *live*:

**The write does not reach the holder.** `serve` keeps its folded state and
sessions in memory. It never learns of the append, so neither do connected
peers, until a restart — which drops every client.

**Two processes append to one log with no coordination.** `FileStore.append` is
a bare `appendFile`. This is exactly the hazard `writelock.ts` documents: both
writers resume from the same `seq` and `prev`, both write, and **both events are
validly signed at the same sequence number**. Signing cannot catch it; the key
genuinely signed both. §7.3 makes the network converge afterwards, but one
branch's writes are dropped silently.

### Why not a directory watcher

The tempting fix is `inotify`: the server sees the log grow and re-folds. It
closes the *notification* gap and leaves the *race* untouched — both processes
still hold independent `ChainSet`s and still append concurrently. The window
narrows without closing, which makes corruption rare rather than absent. A race
that fires once a month is one nobody can reproduce.

## Two surfaces

**Editing** — `put`, `rm`, `mv`, reads, blob fetches — is what clients do, over
the sync protocol, exactly as the browser does today. No new verbs.

**Administration** — `shutdown`, `hold`, `drop`, `peers`, `log` — is the small
set a remote peer must never invoke. Local control socket only.

The test:

> *Would a browser client be allowed to do this?*

`put` passes — a browser writes files. `shutdown` fails — no remote peer should
stop your server. Editing needs no new design; administration is the socket.

## The pieces

### 1. A single-writer guarantee in the store

The precondition for everything else, and worth having alone: it turns a silent
corruption into a clear error.

`FileStore.open` takes an exclusive lock on the space — a `lock` file holding
the owning pid and start time. A second process opening the same space fails
with "held by pid N" rather than appending beside it.

Both details the web lock taught us apply:

- **Release must survive abnormal exit.** A Web Lock is released when the tab
  closes, with no path that leaks. A lock file has no such guarantee, so pid
  *and start time* are recorded: a lock whose pid is gone, or whose pid was
  reused by a later-started process, is stale and may be broken. Recording the
  pid alone would lock someone out of their own space after a reboot.
- **A held lock is not an error to route around.** The CLI must not break a live
  lock because a write is inconvenient — it routes to the holder instead.

Behind the `SpaceStore` interface, so the conformance suite covers it and every
backend inherits the requirement.

### 2. A control socket

`thing` and `thing serve` both listen on a Unix domain socket in the data
directory — `control.sock`, beside the spaces. A socket rather than a TCP port
because the access-control question then answers itself: filesystem permissions
on the data directory already say who may administer this peer. A port would
need an authentication story of its own, for no gain.

A small request/response protocol, deliberately separate from the sync protocol,
so administrative verbs stay unreachable from the peer-to-peer surface. There is
no version of `shutdown` a remote peer can send.

Both `thing attach` and the one-shot CLI commands speak it. It is the *only*
wire between an interface and a holder — the default mode has none.

### 3. The CLI as an ordinary client

Every space-touching command follows one rule:

> If a holder has this space, ask it. Otherwise take the lock and open the store
> directly.

With a peer running, `thing put` connects, appends, and the holder folds and
pushes to everyone connected. With nothing running, it is the offline editor it
is today.

This makes the bug structurally impossible rather than fixed: no path exists
where two processes append to one log.

**The writing key.** A client that edits must sign, so it needs the keypair. The
key file sits beside the store, which the holder has locked — but locks cover
the log, and keys are never appended to, so a client reads it directly. The
alternative, having the holder sign for clients, makes it a signing oracle for
anyone who can reach the socket.

### 4. A view model both interfaces render

`Peer` already holds what an interface needs: `spaces`, `sessions`, per-space
connections, and `space.onChange` for live updates. `PeerOptions`' callbacks —
`onConnect`, `onEvents`, `onFork`, `onBlob` — are already an activity feed;
`serve` prints them to stdout today, and a TUI would draw them instead.

What is missing is a *named shape* for that state, so the TUI does not reach
into `Peer`'s internals. The web client already has one — `SpaceStatus`,
`PeerStatus`, `Activity` describe what to show without saying how. Those types
are renderer-agnostic and platform-neutral; the work is to define them once and
have `Peer` expose them.

Then a TUI attached to a local `Peer` and a TUI attached over the control socket
render the same structures, and the socket's job is simply to carry them.

The web `Client` is close to portable for the same reason — its cross-package
imports are all platform-neutral, and everything browser-specific is an injected
dependency:

| dependency | browser | terminal |
| --- | --- | --- |
| store | `IdbStore` | `FileStore` |
| keystore | `LocalKeystore` | key files |
| lock | Web Locks | the lock file above |
| transport | WebSocket / WebRTC | TCP / Unix socket |
| signalling | `WebSocketSignalling` | same, or none |

Whether the TUI shares that `Client` or renders `Peer` directly is open —
see question 4.

### 5. The TUI

What the web client shows, in a terminal: a space list, a tree, a preview, peer
state, and the activity log. The web client is the design reference; the layout
is settled there and worth not re-deciding.

`attach` is the constrained mode, and it is worth being honest that some things
will not be available over a socket that are trivial in-process — streaming a
large blob preview, for one. The default mode should not be designed down to
what `attach` can do.

## What this is not

**Not a remote administration protocol.** The Unix socket is deliberately local.
Administering a peer on another machine means SSH to that machine — a solved
problem with an existing security model. A networked admin API would need
authentication, authorisation, and transport security for a capability nobody
has asked for. `thing attach` is for a peer on *this* machine.

**Not a daemon manager.** No supervision, no init integration. systemd and its
equivalents do this; `serve` should be a well-behaved foreground process.

**Not a general query interface.** Arbitrary queries over a log belong in `thing
inspect`, which reads the store directly and needs no running peer.

## The commands

**Running**

- `thing` — hold and draw.
- `thing serve` — hold, headless.
- `thing attach` — draw over a running holder.

**Editing** (sync protocol, or direct when nothing holds the space)

`put`, `get`, `rm`, `mv`, `ls` — as today, routed to the holder when there is one.

**Reading state** (control socket)

- `thing status` — what this peer serves, uptime, listen addresses.
- `thing peers` — who is connected, to which space, direct or introduced, how
  long.
- `thing spaces` — held spaces with writability, event and blob counts, disk
  footprint.
- `thing sync <space>` — version vector, per-writer frontier and tip, detected
  forks. Answers "are we converged".
- `thing log [--follow]` — the activity log `serve` already prints, available to
  a process that did not launch it. Today it exists only on the launching
  terminal, which is why diagnosing a retry loop meant reading a redirected file.

**Changing what is served** (control socket)

- `thing hold <key>` / `thing drop <key>` — start or stop serving without a
  restart. Today this means editing a directory and restarting, dropping every
  connected client.
- `thing connect <space> <url>` / `thing disconnect <peer>` — manage connections
  at runtime.
- `thing shutdown` — clean close: finish in-flight writes, close sessions,
  release locks. Distinct from SIGTERM in being refusable mid-append.

Every one of these is a one-shot print-and-exit command. The TUI is for watching;
the CLI is for scripts, SSH sessions, and anything that does not want a
full-screen program.

## Open questions

1. **Does `thing` start a holder if one is already running?** It cannot hold the
   same spaces — the lock forbids it. Attaching automatically is convenient and
   surprising; failing with "already running, use `thing attach`" is clear and
   annoying. Leaning toward attaching automatically with a visible indicator of
   which mode is live.

2. **Does `thing put` return on local durability or on replication?** Local
   durability is the honest default — a holder cannot promise anything about
   peers it does not control — but "wrote it" reading as "everyone has it" is a
   natural misreading worth wording against.

3. **What about a lock held by a hung process?** The pid is alive, so the lock
   is not stale, but nothing answers on the control socket. A `--force` that
   breaks it is easy to add and easy to misuse.

4. **Does the TUI share the web `Client`, or render `Peer` directly?** Sharing
   means one implementation of connection and blob logic, at the cost of an
   abstraction that has to fit two runtimes. Rendering `Peer` directly is
   simpler for the default mode and duplicates work for `attach`. This is the
   decision that most shapes how much code stage 7.6 is.

5. **Per-space lock or per-directory?** Per-space lets one process write space A
   while a peer serves B. Sounds useful; may be a complication with no demand
   behind it.
