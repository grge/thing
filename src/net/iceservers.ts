/**
 * ICE server configuration (§9, POC question 1).
 *
 * v0 configured STUN and deliberately no TURN, so question 1 could measure what
 * fraction of peer pairs fail *without* a relay. That measurement has been
 * taken: pairs involving a phone mostly fail, which is what carrier-grade NAT
 * does. So the question changes rather than disappears — not "do pairs fail
 * without a relay" but "how often is the relay actually needed", which
 * `metrics.ts` already records per connection through `usedRelay()`.
 *
 * The credentials come from an endpoint rather than the bundle. A TURN username
 * and password baked into a public web app is an open relay with someone else's
 * name on the bandwidth bill, so the server mints short-lived pairs instead.
 * With a managed provider the API key is still public — it ships in this bundle
 * and anyone can read it out — so treat it as a rotatable throwaway rather than
 * a secret. Self-hosting (see `turn/`) is what removes that property.
 */

/**
 * STUN only, and used when no credential endpoint is configured or the fetch
 * fails. A relay is an improvement on this, never a prerequisite: local and
 * same-network peers connect perfectly well without one, and a credential
 * service being down must not take the whole app with it.
 */
const FALLBACK: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Resolved once per session. Credentials carry a TTL comfortably longer than a
 * tab's life at POC scale, and re-fetching per connection would multiply
 * requests by the number of open spaces for no benefit.
 */
let cached: RTCIceServer[] | null = null;
/** Deduplicates the burst of concurrent calls N open spaces produce at startup. */
let inflight: Promise<RTCIceServer[]> | null = null;

function configuredUrl(): string | null {
  // Read defensively rather than depending on Vite's client types.
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const url = env['VITE_TURN_CREDENTIALS_URL']?.trim();
  return url !== undefined && url !== '' ? url : null;
}

/**
 * Accepts both shapes seen in the wild: a bare array (what Metered returns) and
 * `{ iceServers: [...] }` (what `turn/auth/` returns). Supporting both means
 * moving from a managed provider to the self-hosted one is a config change
 * rather than a code change.
 */
export function parseIceResponse(body: unknown): RTCIceServer[] | null {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { iceServers?: unknown }).iceServers)
      ? ((body as { iceServers: unknown[] }).iceServers)
      : null;
  if (list === null) return null;

  // A server with no `urls` is unusable and would be silently ignored by the
  // browser; dropping it here keeps the count honest for logging.
  const servers = list.filter(
    (s): s is RTCIceServer =>
      typeof s === 'object' && s !== null && (s as RTCIceServer).urls !== undefined,
  );
  return servers.length > 0 ? servers : null;
}

/** Reset between tests; not used by the app. */
export function resetIceServersCache(): void {
  cached = null;
  inflight = null;
}

export async function iceServers(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RTCIceServer[]> {
  if (cached !== null) return cached;
  if (inflight !== null) return inflight;

  const url = configuredUrl();
  if (url === null) {
    cached = FALLBACK;
    return cached;
  }

  inflight = (async () => {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`credential endpoint returned ${res.status}`);
      const parsed = parseIceResponse(await res.json());
      if (parsed === null) throw new Error('credential endpoint returned no usable ICE servers');
      // STUN stays in the list alongside the relay: a direct path is always
      // preferable, and relaying every connection would be both slower and,
      // on a metered plan, needlessly expensive.
      cached = [...FALLBACK, ...parsed];
      return cached;
    } catch (err) {
      // Loud, but not fatal — see FALLBACK above.
      console.warn(`ICE credentials unavailable, falling back to STUN only: ${String(err)}`);
      cached = FALLBACK;
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
