/**
 * Ephemeral TURN credentials, as a Cloudflare Worker.
 *
 * The app is a static site with no backend, so there is nowhere in it that can
 * hold the TURN secret — which is exactly why credentials cannot be static.
 * This is the smallest thing that can hold one: it mints a short-lived
 * username/password pair and never reveals the secret itself.
 *
 * The scheme is coturn's `use-auth-secret` (the "TURN REST API" convention):
 *
 *   username   = <unix expiry>:<label>
 *   credential = base64( HMAC-SHA1( secret, username ) )
 *
 * coturn recomputes the same HMAC and accepts the pair until the expiry passes.
 * Nothing is stored on either side — the username carries its own expiry.
 *
 * Secrets, via `wrangler secret put`:
 *   TURN_SECRET  — must match the coturn static-auth-secret
 * Vars, via wrangler.toml:
 *   TURN_URLS    — comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:443"
 *   ALLOW_ORIGIN — the app's origin, or "*" while developing
 *   TTL_SECONDS  — optional, default 3600
 */

const encoder = new TextEncoder();

async function hmacSha1Base64(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOW_ORIGIN ?? '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(allowOrigin) });
    }
    if (request.method !== 'GET') {
      return new Response('method not allowed', { status: 405, headers: cors(allowOrigin) });
    }
    if (!env.TURN_SECRET) {
      // Fail loudly rather than handing out credentials nothing will accept.
      return new Response('server misconfigured: TURN_SECRET unset', { status: 500, headers: cors(allowOrigin) });
    }

    const ttl = Number(env.TTL_SECONDS ?? 3600);
    const expiry = Math.floor(Date.now() / 1000) + ttl;

    // The label is opaque to coturn — it exists only to make one credential
    // distinguishable from another in logs. Never trust it for identity.
    const label = crypto.randomUUID().slice(0, 8);
    const username = `${expiry}:${label}`;
    const credential = await hmacSha1Base64(env.TURN_SECRET, username);

    const urls = (env.TURN_URLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const body = JSON.stringify({
      username,
      credential,
      urls,
      // What RTCPeerConnection wants is `iceServers`; handing back the whole
      // shape saves every caller from reassembling it.
      iceServers: [{ urls, username, credential }],
      ttl,
      expiresAt: expiry,
    });

    return new Response(body, {
      headers: {
        'content-type': 'application/json',
        // Credentials are per-request and short-lived; caching them anywhere
        // shared would hand one user's window to the next.
        'cache-control': 'no-store',
        ...cors(allowOrigin),
      },
    });
  },
};
