/**
 * ICE server resolution (§9, POC question 1).
 *
 * v0 configured STUN and deliberately no TURN, so question 1 could measure what
 * fraction of peer pairs fail *without* a relay. That measurement has been
 * taken: pairs involving a phone mostly fail, which is what carrier-grade NAT
 * does. The question changes rather than disappears — not "do pairs fail
 * without a relay" but "how often is the relay needed", which `metrics.ts`
 * already records per connection through `usedRelay()`.
 *
 * Takes a URL rather than reading configuration itself. Where credentials come
 * from is an application concern (`app/settings.ts`), and `net/` deliberately
 * knows nothing about storage — the same reason `BlobStore` and `EventLog` are
 * interfaces rather than imports.
 */

/**
 * STUN only: used when no endpoint is configured, and when one fails.
 *
 * A relay is an improvement, never a prerequisite. Local and same-network peers
 * connect perfectly well without one, so a missing or broken credential service
 * must degrade rather than take the app with it.
 */
const FALLBACK: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Resolved once per URL per session. Credentials outlive a tab at POC scale,
 * and re-fetching per connection would multiply requests by the number of open
 * spaces — which all start replicating at once — for no benefit.
 */
const cache = new Map<string, RTCIceServer[]>();
const inflight = new Map<string, Promise<RTCIceServer[]>>();

export function stunOnly(): RTCIceServer[] {
  return FALLBACK;
}

export function resetIceServersCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Accepts both shapes in circulation: a bare array (what Metered returns) and
 * `{ iceServers: [...] }` (what `turn/auth/` returns). Supporting both makes
 * moving between a managed provider and the self-hosted relay a settings
 * change rather than a code change.
 */
export function parseIceResponse(body: unknown): RTCIceServer[] | null {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { iceServers?: unknown }).iceServers)
      ? ((body as { iceServers: unknown[] }).iceServers)
      : null;
  if (list === null) return null;

  // An entry with no `urls` is unusable, and the browser would ignore it
  // silently; dropping it here keeps any reported count honest.
  const servers = list.filter(
    (s): s is RTCIceServer =>
      typeof s === 'object' && s !== null && (s as RTCIceServer).urls !== undefined,
  );
  return servers.length > 0 ? servers : null;
}

/** True if any entry actually offers a relay, rather than just more STUN. */
export function hasRelay(servers: readonly RTCIceServer[]): boolean {
  return servers.some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn:') || u.startsWith('turns:')),
  );
}

export async function iceServers(
  credentialsUrl: string | null,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RTCIceServer[]> {
  if (credentialsUrl === null) return FALLBACK;

  const hit = cache.get(credentialsUrl);
  if (hit !== undefined) return hit;
  const pending = inflight.get(credentialsUrl);
  if (pending !== undefined) return pending;

  const task = (async () => {
    try {
      const res = await fetchImpl(credentialsUrl);
      if (!res.ok) throw new Error(`credential endpoint returned ${res.status}`);
      const parsed = parseIceResponse(await res.json());
      if (parsed === null) throw new Error('credential endpoint returned no usable ICE servers');
      // STUN stays alongside the relay: a direct path is preferable, and
      // relaying every connection would be slower and — on a metered plan —
      // needlessly expensive.
      const servers = [...FALLBACK, ...parsed];
      cache.set(credentialsUrl, servers);
      return servers;
    } catch (err) {
      // Loud, but not fatal — see FALLBACK.
      console.warn(`ICE credentials unavailable, falling back to STUN only: ${String(err)}`);
      return FALLBACK;
    } finally {
      inflight.delete(credentialsUrl);
    }
  })();

  inflight.set(credentialsUrl, task);
  return task;
}
