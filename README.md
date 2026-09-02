# thing

A namespaced, append-only event log replicated between browser peers over
WebRTC, folded into a filesystem.

Throwaway proof of concept. v0 is built and working; v1 is in progress.

**Start with [DESIGN.md](docs/DESIGN.md).**

| Doc | What it is |
|---|---|
| [DESIGN.md](docs/DESIGN.md) | **The design** — model, addressing, transport, crypto |
| [V1.md](docs/V1.md) | Why v1 is not a rewrite, and the sequence it goes in |
| [ISSUES.md](docs/ISSUES.md) | State — what is currently wrong. Mutable |
| [FINDINGS.md](docs/FINDINGS.md) | Evidence — what was learned. Append-only |
| [NEXT.md](docs/NEXT.md) | Product reasoning behind the design. Pre-spec |
| [ADDRESSING.md](docs/ADDRESSING.md) | The addressing argument in full |
| [RESOLUTION.md](docs/RESOLUTION.md) | Hubs, locators and gossip — proposal, for decision |
| [docs/v0/](docs/v0/) | Archived — what the proof of concept was |

## Running

```
npm install
npm run dev      # the app          → /
                 # transport harness → /transport.html
npm test         # 297 tests
npm run check    # tsc --noEmit
```

## Live

**<https://grge.github.io/thing/>** — deployed from `master` on every push.
The stage 4 transport harness is at
[`/thing/transport.html`](https://grge.github.io/thing/transport.html).

## Testing sync across two devices

No clone needed — open the deployed app on both.

1. Device A: **+** → *Shared — you write*, add a file. The tree header shows an
   8-character **share code**.
2. Device B: open the app, **+** → *Join someone's space*, and type that code —
   no need to transcribe a URL. **Copy link** on device A gives a full URL if
   pasting is easier.

Delete a space with the **×** on its tab. That clears its log and writer identity
and frees any blobs no other space still references.

Both devices need to reach the PeerJS broker. They do **not** need to reach each
other directly — a TURN relay (`turn/`) carries the traffic when they cannot, which
is the usual case for a phone on cellular. Worth trying across different networks
(one on wifi, one on a phone hotspot) rather than only on the same LAN.

The app is served over HTTPS, which WebRTC requires; `localhost` is exempt but a
LAN IP is not, so the deployed URL is the easier path for a real test.

**Use the deployed HTTPS build for any peer testing.** Firefox will not gather
usable ICE candidates over plain `http://`, including a LAN IP — so
`npm run dev -- --host` cannot be used for a two-device test (FINDINGS F1).
`http://localhost` is fine for single-machine work in Chromium.

## Layout

| Path | What |
|---|---|
| `src/fold/` | The fold: event set → state. Pure, no I/O (DESIGN §1–§3) |
| `src/app/` | Storage, spaces, tree derivation, replication wiring |
| `src/net/` | Protocol, framing, blob transfer, sync, signalling |
| `src/ui/` | Svelte two-pane browser, debug log view, transport harness |
| `turn/` | coturn TURN relay — HMAC ephemeral credentials, deploy config |
