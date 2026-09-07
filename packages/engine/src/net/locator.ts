/**
 * Where a space can be reached right now (ARCHITECTURE.md §5.2, §5.3).
 *
 * **A locator is not an identity.** The space's public key says *what* it is
 * and never changes; a locator says where it answered a moment ago and is
 * expected to rot. Verification is against the key, so a wrong locator costs a
 * wasted dial and nothing else — which is the property that lets resolution be
 * casual, and why nothing here is signed or authoritative.
 *
 * **Two shapes, both flat.** A locator is never expressed in terms of another,
 * so one learned third-hand is exactly as usable as one learned directly.
 *
 * **No locator is stored in a space** (§5.3). An earlier design had a signed
 * list on the root; it was dropped because the peer that knows a serving
 * address usually cannot write the root, and because reachability is a fact
 * about a *pair* of peers rather than about the space. Locators live in a
 * client-side cache, on the ephemeral channel, and in share links.
 */

/** Open a socket here. The endpoint *is* the peer. Long-lived: a real address. */
export interface WsLocator {
  readonly kind: 'ws';
  readonly url: string;
}

/**
 * Signal through this server and ask for this session.
 *
 * How a peer with no address of its own is reached — a browser, or anything
 * behind NAT. Short-lived: it dies with the session, which is why a cache that
 * keeps one has to expect it to fail.
 */
export interface ViaLocator {
  readonly kind: 'via';
  readonly url: string;
  readonly peer: string;
}

export type Locator = WsLocator | ViaLocator;

/**
 * A stable string for one locator, for deduplication.
 *
 * Two peers describing the same endpoint must produce the same key, or a merged
 * list holds it twice and one entry's failures never inform the other's.
 */
export function locatorKey(l: Locator): string {
  return l.kind === 'ws' ? `ws:${l.url}` : `via:${l.url}|${l.peer}`;
}

/**
 * Parse the compact form used in share links and on the wire.
 *
 * `ws://host:port` or `wss://…` for a direct address; `via:<url>#<peer>` for a
 * session. Returns null rather than throwing: a locator arrives from strangers,
 * and an unparseable one is an ordinary thing to ignore.
 */
export function parseLocator(s: string): Locator | null {
  const text = s.trim();
  if (text === '') return null;

  if (text.startsWith('via:')) {
    const rest = text.slice(4);
    const hash = rest.lastIndexOf('#');
    if (hash <= 0 || hash === rest.length - 1) return null;
    return { kind: 'via', url: rest.slice(0, hash), peer: rest.slice(hash + 1) };
  }

  if (text.startsWith('ws://') || text.startsWith('wss://')) {
    return { kind: 'ws', url: text };
  }
  return null;
}

/** The inverse of `parseLocator`. */
export function formatLocator(l: Locator): string {
  return l.kind === 'ws' ? l.url : `via:${l.url}#${l.peer}`;
}
