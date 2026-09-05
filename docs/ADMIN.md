# Holders, clients, and administering a peer

**Status: a design, not yet built.** Nothing here exists.

---

## The distinction everything follows from

Not "CLI versus server". The real split is:

> A **holder** owns a space's log — it has the write lock, the `ChainSet`, the
> fold. Exactly one per space.
>
> A **client** asks a holder to do things. It may be a browser, a terminal, or
> another peer.

These are roles, not programs. `thing serve` is a holder with no interface. The
browser is a client that also holds its own spaces locally — which is why
`writelock.ts` had to exist there first: two tabs are two would-be holders of
one space, and something had to arbitrate.

Editing a space is what *clients* do, and every client already does it the same
way: over the sync protocol, by appending signed events. The browser does this
today. There is no reason for a second mechanism.

## The problem, precisely

The current CLI is an **offline editor**. `thing put` opens a store, appends,
and exits. That is a legitimate mode — no server running, seeding a space,
inspecting a log, recovering something. It is the exceptional mode, not the
normal one.

The bug is that it behaves identically when a space is *live*, and two things
go wrong:

**The write does not reach the holder.** `serve` keeps its own folded state and
sessions in memory. It never learns of the append, so neither do connected
peers, until a restart — which drops every client.

**Two processes append to one log with no coordination.** `FileStore.append`
is a bare `appendFile`. This is precisely the hazard `writelock.ts` documents:
both writers resume from the same `seq` and `prev`, both write, and **both
events are validly signed at the same sequence number**. Signing cannot catch
it; the key genuinely signed both. §7.3 makes the network converge afterwards,
but one branch's writes are dropped silently.

So this is not "the server should notice file changes". It is "there is one
holder per space, and clients go through it".

## Why not a directory watcher

The tempting fix is `inotify`: the server sees the log grow and re-folds. It is
wrong, and worth being explicit about why.

A watcher closes the *notification* gap and leaves the *race* untouched. Both
processes still hold independent `ChainSet`s and still append concurrently. The
window narrows; it does not close. And narrowing it makes corruption rare rather
than absent, which is worse — a race that fires once a month is one nobody can
reproduce.

## Two surfaces, and the test that separates them

**Editing** — `put`, `rm`, `mv`, reads, blob fetches — goes over the sync
protocol, exactly as the browser does. No new verbs, no new protocol. `thing
put` connects to the holder, writes, disconnects.

**Administration** — `shutdown`, `hold`, `drop`, `peers`, `log --follow` — is
the small set a remote peer must never be able to invoke. This gets a local-only
control socket.

The test for which side something falls on:

> *Would a browser client be allowed to do this?*

If yes, it is editing, and it needs no new design. If no, it is administration.
`put` passes — a browser writes files. `shutdown` fails — no remote peer should
ever stop your server.

## The shape

Four pieces, in dependency order.

### 1. A single-writer guarantee in the store

The precondition for everything else, and worth having alone: it converts a
silent corruption into a clear error.

`FileStore.open` takes an exclusive lock on the space — a `lock` file holding
the owning pid and start time. A second process opening the same space fails
with "held by pid N" rather than appending beside it.

Both details the web lock taught us apply here:

- **Release must survive abnormal exit.** A Web Lock is released when the tab
  closes, with no path that leaks. A lock file has no such guarantee, so pid
  *and start time* are recorded: a lock whose pid is gone, or whose pid was
  reused by a later-started process, is stale and may be broken. Recording the
  pid alone would eventually lock someone out of their own space after a reboot.
- **A held lock is not an error to route around.** The CLI must not break a
  live lock because a write is inconvenient — it routes to the holder instead.

Behind the `SpaceStore` interface, so the conformance suite covers it and every
backend inherits the requirement.

### 2. The CLI as an ordinary client

Every space-touching command follows one rule:

> If a holder has this space, connect to it. Otherwise take the lock and open
> the store directly.

With a server running, `thing put` is a peer: it connects, appends, and the
holder folds and pushes to everyone connected — the behaviour that was missing.
With no server, it is the offline editor it is today.

This makes the bug structurally impossible rather than fixed. There is no path
where two processes append to one log.

**The writing key.** A client that edits must sign, so it needs the space's
keypair. The key file sits next to the store, which the holder has locked — but
locks cover the log, and keys are never appended to, so a client reads the key
directly. The alternative, having the holder sign on a client's behalf, is worse
in every way: it makes the holder a signing oracle for anyone who can reach the
socket.

### 3. A control socket for administration

`serve` listens on a Unix domain socket in the data directory —
`control.sock`, beside the spaces. A socket rather than a TCP port because the
access-control question then answers itself: filesystem permissions on the data
directory already say who may administer this peer. A port would need an
authentication story of its own, for no gain.

A small request/response protocol, deliberately separate from the sync protocol.
Keeping them apart is the point: administrative verbs stay unreachable from the
peer-to-peer surface, so there is no version of `shutdown` a remote peer can
send.

### 4. A shared client core

`Client` in `packages/web` is already close to portable. Its cross-package
imports — `core`, `net`, `peer`, `store` — are all platform-neutral. Everything
browser-specific is an *injected dependency* rather than logic:

| dependency | browser | terminal |
| --- | --- | --- |
| store | `IdbStore` | `FileStore` |
| keystore | `LocalKeystore` | key files |
| lock | Web Locks | the lock file above |
| transport | WebSocket / WebRTC | TCP / Unix socket |
| signalling | `WebSocketSignalling` | same, or none |

Lifting it into a package both can use — with those five as constructor
arguments — costs little and is what makes the TUI below cheap rather than a
second implementation of everything.

Its status types are already renderer-agnostic: `SpaceStatus`, `PeerStatus`,
`Activity` describe what to show without saying how.

## A terminal client

Wanted, and it falls out of the above rather than needing its own design: **a
TUI that feels like the web client but runs in a terminal.**

A TUI is a client with a different renderer. It needs what the browser needs —
the folded tree, blobs on demand, live updates as events arrive, peer state for
a footer — and with a shared `Client` it is that same loop drawing to a
terminal instead of to Svelte.

"Hooking into a server instance" then has a precise meaning: **the TUI connects
to a holder**, the same way the browser does, over the same protocol. Two useful
modes fall out, and they need no extra machinery:

- **Attached** — connect to a running `serve` over the control socket. The
  server holds the spaces; the TUI is a view onto them. This is the case where a
  terminal and a browser are looking at the same live peer.
- **Standalone** — hold spaces itself, taking the locks, connecting out to other
  peers. `thing serve` with a face on it.

Not scheduled, and it should not be started before the shared client exists —
building it against the web client directly would fork the logic, which is the
one outcome worth avoiding.

## What this is not

**Not a remote administration protocol.** The Unix socket is deliberately local.
Administering a peer on another machine means SSH to that machine — a solved
problem with an existing security model. A networked admin API would need
authentication, authorisation, and transport security for a capability nobody
has asked for.

**Not a daemon manager.** No supervision, no init integration. systemd and its
equivalents do this; `serve` should be a well-behaved foreground process.

**Not a general query interface.** Arbitrary queries over a log belong in
`thing inspect`, which reads the store directly and needs no running server.

## The commands

**Editing** (sync protocol, or direct when nothing holds the space)

`put`, `get`, `rm`, `mv`, `ls` — as today, but routed to the holder when there
is one.

**Reading state** (control socket)

- `thing status` — what this peer serves, uptime, listen addresses.
- `thing peers` — who is connected, to which space, direct or introduced, how
  long. The debug panel's peers view, in a terminal.
- `thing spaces` — held spaces with writability, event and blob counts, disk
  footprint.
- `thing sync <space>` — version vector, per-writer frontier and tip, detected
  forks. Answers "are we converged".
- `thing log [--follow]` — the activity log `serve` already prints, available to
  a process that did not launch it. Today that log exists only on the launching
  terminal, which is why diagnosing a retry loop meant reading a redirected file.

**Changing what is served** (control socket)

- `thing hold <key>` / `thing drop <key>` — start or stop serving without a
  restart. Today this means editing a directory and restarting, dropping every
  connected client.
- `thing connect <space> <url>` / `thing disconnect <peer>` — manage connections
  at runtime.
- `thing shutdown` — clean close: finish in-flight writes, close sessions,
  release locks. Distinct from SIGTERM in being refusable mid-append.

## Open questions

1. **Does `thing put` return on local durability or on replication?** Local
   durability is the honest default — a holder cannot promise anything about
   peers it does not control — but "wrote it" reading as "everyone has it" is a
   natural misreading worth wording against.

2. **What about a lock held by a hung process?** The pid is alive, so the lock
   is not stale, but the peer answers nothing on the control socket. A `--force`
   that breaks it is easy to add and easy to misuse.

3. **Per-space lock or per-directory?** Per-space lets one process write space A
   while a server serves B. Sounds useful; may be a complication with no demand
   behind it.

4. **Does an attached TUI proxy its sync through the holder, or hold nothing and
   read over the control socket?** The first makes it a peer like any other; the
   second makes it a thin view. The second is simpler and probably right, but it
   means the control socket grows read verbs that overlap what sync already does.
