# Administering a running peer

**Status: a design, not yet built.** Nothing here exists. It is written down
because the shape needs deciding before code, and because the problem it solves
is currently a correctness bug rather than an inconvenience.

---

## The problem, precisely

`thing serve` holds spaces in memory: a `Space` with its folded state, a
`ChainSet` tracking each writer's frontier and tip, and open sessions. `thing
put` is a **separate process** that opens the same directory, appends to the
log, and exits.

They share a directory and nothing else. Two consequences, and the second is
the serious one:

**A write does not reach a running server.** The server's in-memory fold never
learns about it, so connected peers do not either, until someone restarts the
server. Observed directly: adding a file to a served space required a restart,
which dropped every connected client.

**Two processes append to one log with no coordination.** `FileStore.append`
is a bare `appendFile`. The web client already recognises this hazard and
solves it — `writelock.ts` takes a Web Lock so two tabs cannot both write a
space, because both would resume from the same `seq` and `prev` and produce
**two different events at the same sequence number, both validly signed**.
Signing cannot catch it; the key genuinely signed both.

The CLI has the same hazard one layer down and no equivalent. `thing put`
running against a live `thing serve` is a race that can fork a chain on a
single machine. §7.3 makes the network converge afterwards, but one branch's
writes are dropped — silently.

So this is not "the server should notice file changes". It is "there must be
one writer per space, and everything else must go through it".

## Why not a directory watcher

The tempting fix is `inotify` on the space directory: the server sees the log
grow and re-folds. It is wrong, for a reason worth stating plainly.

A watcher makes the *notification* problem go away while leaving the *race*
untouched. Both processes still hold independent `ChainSet`s, still resume from
whatever they last read, and still append concurrently. The window narrows; it
does not close. And it would narrow enough to make the remaining corruption
rare, which is worse than frequent — a race that fires once a month is one
nobody can reproduce.

The architecture already says what to do instead. A peer that holds a space
serves it to other peers over a protocol built for exactly this. **The CLI
should be a peer, not a second writer.**

## The shape

Three pieces, in dependency order.

### 1. A single-writer guarantee in the store

The precondition for everything else, and worth having even alone: it converts
a silent corruption into a clear error.

`FileStore.open` acquires an exclusive lock on the space directory — a
`lock` file opened `O_EXCL`, holding the owning pid and start time. A second
process opening the same space fails with "held by pid N", rather than
appending alongside it.

Two details the web lock taught us, both of which apply here:

- **Release must be reliable on abnormal exit.** A Web Lock is released when
  the tab closes, with no cleanup path that can leak. A lock file has no such
  guarantee, so the pid and start time are both recorded: a lock whose pid is
  gone, or whose pid was reused by a process that started later, is stale and
  may be broken. Recording only the pid would eventually lock someone out of
  their own space after a reboot.
- **A held lock is not an error to route around.** The CLI should not break a
  live lock because the write is inconvenient — it should route the write to
  the holder, which is piece 3.

This belongs behind the `SpaceStore` interface, so the conformance suite covers
it and any future backend inherits the requirement.

### 2. A control channel to a running peer

`serve` listens on a Unix domain socket in the data directory — `control.sock`,
alongside the spaces. A socket, not a TCP port, because the access-control
question answers itself: filesystem permissions on the data directory already
say who may administer this peer, and a port would need an authentication story
of its own for no gain.

The wire format is the protocol that already exists. `TAG_CONTROL` frames carry
sync and blobs; administration is a fourth frame tag alongside the three
channels of §10, or — likely better — a small request/response JSON protocol on
its own socket, since these are operator commands rather than replication and
conflating them would put administrative verbs into the peer-to-peer protocol
where they do not belong.

**Decide before building:** whether the control socket speaks the sync protocol
(so `thing put` is literally a peer that connects, writes, and disconnects) or
a separate operator protocol (so administration is not something a remote peer
could ever ask for). These pull in opposite directions and the second is
probably right — a remote peer must never be able to send `shutdown` — but it
means two protocols to maintain.

### 3. The CLI as a client of its own server

Every command that touches a space follows one rule:

> If a peer holds this space, ask it. Otherwise open the store directly.

`thing put` connects to `control.sock`, sends the write, and the running server
appends it, folds it, and pushes it to connected peers — which is the behaviour
that was missing. With no server running, it takes the lock and writes
directly, exactly as it does today.

This makes the current bug structurally impossible rather than fixed: there is
no path where two processes append to one log.

## What operators actually need

The commands worth having, roughly in order of how often they are wanted. The
first group is the reason to build this at all; the rest are cheap once the
channel exists.

**Seeing state**

- `thing status` — what this peer is serving, uptime, listen addresses, and
  the control socket it answers on.
- `thing peers` — who is connected, to which space, direct or introduced, and
  for how long. The debug panel's peers view, in a terminal.
- `thing spaces` — held spaces with writability, event count, blob count, and
  disk footprint. Answers "what is this server actually holding", which
  currently requires reading a directory listing.
- `thing sync <space>` — version vector, per-writer frontier and tip, and any
  detected forks. The one command that answers "are we converged".

**Changing what is served**

- `thing hold <key>` / `thing drop <key>` — start or stop serving a space
  without a restart. Today this means editing a directory and restarting,
  which drops every connected client.
- `thing connect <space> <url>` — dial another peer at runtime.
- `thing disconnect <peer>` — drop one connection.

**Writing**

- `thing put` / `thing rm` / `thing mv`, routed through the holder as above.

**Operational**

- `thing log [--follow]` — the activity log the server already prints,
  available to a process that did not start it. Currently the log exists only
  on the terminal that launched `serve`, which is why diagnosing the retry loop
  meant reading a redirected file.
- `thing shutdown` — clean close: finish in-flight writes, close sessions,
  release locks. Distinct from SIGTERM in that it is refusable if something is
  mid-append.

## What this is not

**Not a remote administration protocol.** A Unix socket is deliberately local.
Administering a peer on another machine means SSH to that machine, which is a
solved problem with an existing security model. Building a networked admin API
would mean authentication, authorisation, and transport security for a
capability nobody has asked for.

**Not a daemon manager.** No start/stop/restart supervision, no pidfile
conventions beyond the lock, no init integration. systemd and its equivalents
do this; `serve` should be a well-behaved foreground process and nothing more.

**Not a general query interface.** `thing sync` and `thing spaces` answer
specific operational questions. Arbitrary queries over the log belong in
`thing inspect`, which reads the store directly and does not need a running
server.

## Open questions

1. **Which protocol does the control socket speak?** The central decision above.
   Leaning toward a separate operator protocol, so that administrative verbs are
   unreachable from the peer-to-peer surface.

2. **What happens to a lock held by a hung process?** The pid is alive, so the
   lock is not stale, but the peer is not responding on the control socket
   either. A `--force` that breaks the lock is easy to add and easy to misuse.

3. **Does `thing put` block until the write is replicated, or until it is
   durable locally?** Local durability is the honest default — the server cannot
   promise anything about peers it does not control — but "wrote it" reading as
   "everyone has it" is a natural misreading worth wording against.

4. **Does the lock cover a space or the whole directory?** Per-space allows one
   process to write space A while a server serves B, which sounds useful and may
   be a complication with no real demand behind it.
