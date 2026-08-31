# TURN server

A coturn deployment with HMAC-derived ephemeral credentials, plus a credential
service small enough to run anywhere.

**Staged in this repo temporarily.** This is meant to be its own project; it
lives here so the work is not lost while the name is being settled. Extracting
it later is `git subtree split -P turn` into a fresh repo, or simply copying the
directory. Nothing in it depends on the parent repo.

## Why it exists

v0 configured STUN and deliberately no TURN, so that POC question 1 could
measure how often peers fail *without* a relay (`src/net/peerjs-signalling.ts`
says so in a comment). That measurement has been taken informally and the
answer looks like "phones mostly fail", which is what carrier-grade NAT does.
The next iteration assumes a relay instead of measuring its absence.

## Current state: a managed provider

**A Metered free-tier server is in use** while the question is simply *does a
relay fix phone-to-phone at all*.

**The credentials are entered in the app, not built into it.** Settings →
Relay takes either a Metered subdomain and API key or a custom credentials URL,
and stores it in `localStorage` on that device only (`src/app/settings.ts`). It
never enters a space, never replicates, and is never committed.

That is a deliberate consequence of having no server: a key baked into the
bundle would be published to everyone who loads the page, and they would spend
the quota. Keeping it device-local means the key belongs to whoever entered it
— the same shape as everything else in a local-first app.

**The cost, stated plainly:** a deployment where the visitor has entered no
credentials has no relay, and is exactly as unreachable for them as it is
today. That is correct for an experiment and has an expiry — a public app
cannot ask visitors to bring their own TURN server. The eventual answer is
either a shipped default relay, which costs money, or a credential service like
the one in `auth/`, which needs somewhere to run.

The custom-URL option is what makes the coturn deployment below reachable
without a code change: `src/net/iceservers.ts` accepts both the bare array a
managed provider returns and the `{ iceServers }` that `auth/` returns.

## Shape

| | |
|---|---|
| `Dockerfile`, `entrypoint.sh`, `turnserver.conf.tmpl` | coturn, configured entirely from the environment |
| `auth/worker.js`, `auth/wrangler.toml` | credential service as a Cloudflare Worker (recommended) |
| `auth/server.mjs` | the same service as dependency-free Node, if you would rather not add Cloudflare |
| `fly.toml` | Fly deployment — read the caveat below first |
| `test/ice.html` | open in a browser; says whether a **relay** candidate actually appears |

## Credentials are HMAC, never static

The app is a static site with no backend, so there is nowhere in it that can
hold a TURN secret. That is not an inconvenience to work around — it is the
reason static credentials are unusable: anything shipped in a public bundle is
an open relay with your name on the bandwidth bill.

Instead, coturn runs with `use-auth-secret`, and the credential service mints
short-lived pairs from the shared secret:

```
username   = <unix expiry>:<label>
credential = base64( HMAC-SHA1( secret, username ) )
```

coturn recomputes the same HMAC and accepts the pair until the expiry passes.
Nothing is stored on either side; the username carries its own expiry. Rotating
the secret invalidates every outstanding credential without a redeploy of the
app.

## Where this should run — not Fly

Fly was the original plan and is the wrong tool. It is a port-mapped platform,
and TURN wants a machine with a public IP and a UDP port range: each concurrent
allocation consumes one relay port, and Fly wants every port declared rather
than handed a range. `fly.toml` is kept here as a working-but-capped
configuration and a record of why the approach was abandoned; it is **not the
recommended path**.

**A small VPS with a real public IPv4 is the boring correct answer** — full UDP
range, no port declarations, straightforward Let's Encrypt for the TLS on
5349/443. Bandwidth is what should drive the choice rather than CPU, because
relayed traffic is doubled and this workload is multi-megabyte blobs rather
than voice; Hetzner's included allowance is an order of magnitude past the
usual $5 tier.

It is also the same box a future always-on peer would live on. A peer with a
public address needs no NAT traversal at all — browsers open a websocket
straight to it — so one machine covers both the relay and the persistence
problem that "keep a tab open" is currently standing in for.

## The Fly caveat, in detail

**coturn wants a public IP with a wide UDP port range. Fly's port model fights
that.** Each concurrent TURN allocation consumes one relay port, and Fly wants
every port declared in `fly.toml` rather than handed a range at the host level.

The compromise here is a deliberately narrow relay range (41 ports, 49160–49200),
which is fine for a POC and caps concurrent relayed connections at roughly that
number. Fly also requires a **dedicated IPv4** for UDP — shared IPv4 will not
carry it — which is about $2/month.

Three honest options:

1. **Fly, as configured here.** Works, with the concurrency cap above. Fine
   while the question is "does a relay fix phone-to-phone at all".
2. **A small VPS with a real public IP** (Hetzner, DigitalOcean, Vultr — €4-ish
   a month). The boring correct answer: full UDP range, no port declarations,
   nothing to work around. If the port cap ever bites, move here rather than
   growing the list in `fly.toml`.
3. **A managed TURN provider** (Cloudflare, Twilio, Metered). Zero ops, and the
   fastest way to find out whether TURN is what was missing — worth considering
   purely as a diagnostic before running any of this.

The config is the same for 1 and 2; only the wrapper differs.

## Deploying to Fly (kept for reference)

```sh
fly launch --no-deploy                  # or: fly apps create <name>
fly ips allocate-v4                     # dedicated — UDP will not work without it
fly secrets set TURN_SECRET="$(openssl rand -hex 32)"
```

Set `TURN_REALM` in `fly.toml` to the hostname you will point at the app, and
`TURN_EXTERNAL_IP` to the address `fly ips list` reports. The entrypoint will
try to discover it if unset, but on Fly it is better to be explicit.

```sh
fly deploy
```

For TLS on 5349/443, mount a certificate and add `cert`/`pkey` to the config.
Until then those ports will refuse connections — which is worth knowing, since
443 is the port that matters most for restrictive networks.

## Deploying the credential service

```sh
cd auth
wrangler secret put TURN_SECRET        # same value as coturn's
wrangler deploy
```

Set `TURN_URLS` and `ALLOW_ORIGIN` in `wrangler.toml`. `ALLOW_ORIGIN` should be
the app's real origin before this is anything but a test.

Node equivalent:

```sh
TURN_SECRET=... TURN_URLS=turn:turn.example.com:3478 node auth/server.mjs
```

## Checking it works

Open `test/ice.html`, point it at the credential endpoint, run the check.

It forces `iceTransportPolicy: 'relay'`, which discards host and srflx
candidates outright — so anything that arrives had to come through the TURN
server. That distinction is the whole point: **a `srflx` candidate only proves
STUN works, which it already did.** Only a `relay` candidate proves TURN does.

Run it from a phone on cellular data, not just a laptop, since the phone case is
what prompted all of this.
