# thing

A namespaced, append-only event log replicated between browser peers over
WebRTC, folded into a filesystem.

Throwaway proof of concept. See [docs/SPEC.md](docs/SPEC.md) for the design,
[docs/PLAN.md](docs/PLAN.md) for the build order, and
[docs/FINDINGS.md](docs/FINDINGS.md) for what has actually been learned.

## Running

```
npm install
npm run dev      # the app          → /
                 # transport harness → /transport.html
npm test         # 145 tests
npm run check    # tsc + svelte-check
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
other directly unless a relay is unavailable — whether they can is exactly what
POC question 1 is measuring, so try it across different networks (one on wifi,
one on a phone hotspot) rather than only on the same LAN.

The app is served over HTTPS, which WebRTC requires; `localhost` is exempt but a
LAN IP is not, so the deployed URL is the easier path for a real test.

**Use Chromium.** Firefox 99 in this environment gathers no UDP ICE candidates
and cannot connect at all (FINDINGS F1).

## Layout

| Path | What |
|---|---|
| `src/fold/` | The fold: event set → state. Pure, no I/O (§1–§4) |
| `src/app/` | Storage, spaces, tree derivation, replication wiring |
| `src/net/` | Protocol, framing, blob transfer, sync, signalling |
| `src/ui/` | Svelte two-pane browser, debug log view, transport harness |
