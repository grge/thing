/**
 * Does the relay actually work, and if not, why?
 *
 * POC question 1 is "how often is a relay needed and does it work", so a check
 * that answers only yes/no is half a tool. The failures worth telling apart:
 *
 *   - credentials never fetched          → endpoint or key wrong
 *   - fetched, but no TURN url in them   → provider returned STUN only
 *   - TURN url present, allocation 401   → credentials rejected by the relay
 *   - TURN url present, allocation 701   → relay unreachable (port blocked, DNS)
 *   - relay fails but STUN works         → the relay specifically is the problem
 *   - nothing works at all               → the network, not the relay
 *
 * The last two need a second pass, because a relay-only gather that returns
 * nothing cannot distinguish "TURN is broken" from "this network blocks
 * everything".
 */

export interface IceError {
  readonly url: string;
  readonly code: number;
  readonly text: string;
}

export interface RelayCheck {
  /** Hostnames offered, so a wrong-tier or wrong-region endpoint is visible. */
  readonly servers: readonly string[];
  /** Whether each TURN entry actually carried a username and credential. */
  readonly credentialed: boolean;
  readonly relayCandidates: number;
  /** Candidate types seen in the unrestricted pass: host, srflx, relay. */
  readonly otherCandidates: readonly string[];
  readonly errors: readonly IceError[];
  readonly ms: number;
}

export type Verdict = 'ok' | 'rejected' | 'unreachable' | 'no-turn-url' | 'network' | 'unknown';

export interface Summary {
  readonly verdict: Verdict;
  readonly text: string;
}

/** Flatten `urls`, which may be a string or an array, into hostnames-with-scheme. */
export function serverUrls(servers: readonly RTCIceServer[]): string[] {
  return servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
}

export function turnUrls(servers: readonly RTCIceServer[]): string[] {
  return serverUrls(servers).filter((u) => u.startsWith('turn:') || u.startsWith('turns:'));
}

/**
 * Turn a completed check into a verdict and a sentence that says what to do.
 *
 * Pure, so the interesting part is testable without a browser.
 */
export function summarise(check: RelayCheck): Summary {
  if (check.relayCandidates > 0) {
    return { verdict: 'ok', text: `Relay candidate found in ${check.ms} ms — TURN works.` };
  }

  const turn = check.servers.filter((u) => u.startsWith('turn:') || u.startsWith('turns:'));
  if (turn.length === 0) {
    return {
      verdict: 'no-turn-url',
      text: 'The credential endpoint returned no TURN url — STUN only, so phones will still fail.',
    };
  }

  // 401 is unambiguous and actionable: the relay was reached and said no.
  const auth = check.errors.find((e) => e.code === 401 || e.code === 403);
  if (auth !== undefined) {
    return {
      verdict: 'rejected',
      text:
        `The relay rejected the credentials (${auth.code} ${auth.text}). The key that fetches ` +
        'credentials is not the same thing as a credential: check it is the credential-scoped ' +
        'apiKey, and that the credential is enabled and unexpired.',
    };
  }

  if (!check.credentialed) {
    return {
      verdict: 'rejected',
      text: 'A TURN url was returned with no username or credential attached, so allocation could never succeed.',
    };
  }

  // 701 means the browser could not reach the server at all.
  const unreachable = check.errors.find((e) => e.code === 701);
  if (unreachable !== undefined) {
    return {
      verdict: 'unreachable',
      text:
        `The relay could not be reached (${unreachable.code} ${unreachable.text} at ${unreachable.url}). ` +
        'Either the host is wrong for this account tier, or this network blocks that port.',
    };
  }

  if (check.otherCandidates.length === 0) {
    return {
      verdict: 'network',
      text:
        'No candidates of any kind were gathered, not even host — the problem is this network or ' +
        'browser, not the relay.',
    };
  }

  return {
    verdict: 'unknown',
    text:
      `No relay candidate after ${check.ms} ms, and the relay reported no error. STUN worked ` +
      `(${check.otherCandidates.join(', ')}), so the relay specifically is failing — most often an ` +
      'endpoint the account tier is not entitled to.',
  };
}

/**
 * Gather twice: relay-only, then unrestricted.
 *
 * The relay-only pass is the actual test — it discards host and srflx outright,
 * so anything arriving had to come through TURN. The unrestricted pass exists
 * only to tell a broken relay apart from a broken network.
 */
export async function runRelayCheck(
  servers: readonly RTCIceServer[],
  timeoutMs = 12000,
): Promise<RelayCheck> {
  const started = performance.now();
  const errors: IceError[] = [];

  const gather = (policy: RTCIceTransportPolicy): Promise<string[]> =>
    new Promise((resolve) => {
      const types: string[] = [];
      const pc = new RTCPeerConnection({ iceServers: [...servers], iceTransportPolicy: policy });
      const done = (): void => {
        pc.close();
        resolve(types);
      };
      pc.addEventListener('icecandidate', (e) => {
        if (e.candidate === null) {
          done();
          return;
        }
        if (e.candidate.type != null) types.push(e.candidate.type);
      });
      pc.addEventListener('icecandidateerror', (e) => {
        const ev = e as RTCPeerConnectionIceErrorEvent;
        errors.push({ url: ev.url ?? '?', code: ev.errorCode, text: ev.errorText ?? '' });
      });
      pc.createDataChannel('probe');
      void pc.createOffer().then((o) => pc.setLocalDescription(o));
      setTimeout(done, timeoutMs);
    });

  const relayTypes = await gather('relay');
  const relayCandidates = relayTypes.filter((t) => t === 'relay').length;

  // Only worth the second pass if the first found nothing — otherwise it works.
  const otherCandidates = relayCandidates > 0 ? [] : await gather('all');

  const urls = serverUrls(servers);
  const credentialed = servers
    .filter((s) => turnUrls([s]).length > 0)
    .every((s) => s.username !== undefined && s.credential !== undefined);

  return {
    servers: urls,
    credentialed,
    relayCandidates,
    otherCandidates: [...new Set(otherCandidates)],
    errors,
    ms: Math.round(performance.now() - started),
  };
}
