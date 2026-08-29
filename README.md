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
npm test         # 129 tests
npm run check    # tsc + svelte-check
```

## Testing sync across two machines

1. `npm run dev -- --host` and note the network URL.
2. Machine A: create a space with mode `writer`, add a file, click **Share**.
3. Machine B: open the copied URL. It joins as a reader and replicates.

Both machines need to reach the PeerJS broker; they do not need to reach each
other directly unless a relay is unavailable — which is the thing POC question 1
is measuring.

**Use Chromium.** Firefox 99 in this environment gathers no UDP ICE candidates
and cannot connect at all (FINDINGS F1).

## Layout

| Path | What |
|---|---|
| `src/fold/` | The fold: event set → state. Pure, no I/O (§1–§4) |
| `src/app/` | Storage, spaces, tree derivation, replication wiring |
| `src/net/` | Protocol, framing, blob transfer, sync, signalling |
| `src/ui/` | Svelte two-pane browser, debug log view, transport harness |
