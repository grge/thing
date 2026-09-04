# archive — the previous implementation

**Not built, not tested, not imported.** This is the working system that existed
before the rewrite, kept because it is a useful reference and because several
pieces of it are worth borrowing rather than reinventing.

It implements the design in [docs/v1/](../docs/v1/), which
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) supersedes. The substrate is
largely carried forward; everything above it is not.

| Path | What | Worth borrowing? |
|---|---|---|
| `net/blobtransfer.ts` | Chunking, backpressure, resume, integrity | **Yes** — its whole dependency is a two-method `Channel` |
| `net/protocol.ts` | Frame encoding, the tag byte, chunk headers | **Yes** — the framing, not the message set |
| `net/sync.ts` | Version vectors, gap detection, hold-aside buffer | **Yes** — pure, no I/O; needs the tip hash adding |
| `net/signalling.ts` | Discovery as an interface | **Yes** — the interface shape |
| `net/peerjs-signalling.ts` | PeerJS behind that interface | Reference |
| `fold/sign.ts` | Ed25519 with WebCrypto and noble backends | **Yes** — the dual-backend probe |
| `fold/encode.ts` | Canonical encoding | **Yes** — the writer; the layout changes |
| `fold/fold.ts` | The fold | No — a hardcoded switch, which the rewrite replaces |
| `app/storage.ts` | localStorage + IndexedDB | No — rewrites the whole log per commit |
| `ui/` | Svelte two-pane browser | Reference for interaction, not code |
| `proto/` | The tiered-fold prototype | **Yes** — the fold's reference implementation |

`proto/` is the odd one out: it is newer than the rest, it was written against
the *current* architecture, and its tests carry over to stage 2 nearly
unchanged. It lives here because it is a prototype rather than because it is
superseded.

## Why it is not deleted

Nothing here is owed compatibility — no data migrates, no wire format is shared,
and old share links are not resolved. But the reasoning that produced this code
is recorded in [docs/v1/](../docs/v1/), and the code is the evidence for it. A
claim in an archived document is easier to trust when the implementation it
describes is still readable.
