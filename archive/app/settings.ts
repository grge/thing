/**
 * Device-local application settings.
 *
 * Deliberately *not* space data: these never enter an event log, never
 * replicate, and never leave this browser. A space is shared; how this device
 * reaches the network is nobody else's business.
 *
 * The TURN credentials live here rather than in the build because there is no
 * server to hold them. Baking a provider key into the bundle would publish it
 * to everyone who loads the page, and they would spend the quota. Keeping it
 * on the device means the key is the user's own — which is the same shape as
 * everything else in a local-first app.
 *
 * The cost, stated plainly: a deployment with no relay configured is, for
 * anyone who has not entered credentials, exactly as unreachable as it is
 * today. That is correct for an experiment and has an expiry — a public app
 * cannot ask visitors to bring their own TURN server.
 */

const SETTINGS_KEY = 'thing:settings';

export type TurnSettings =
  | { readonly provider: 'none' }
  /** Metered's REST credentials, the free tier used while measuring. */
  | { readonly provider: 'metered'; readonly subdomain: string; readonly apiKey: string }
  /** Any endpoint returning ICE servers — including `turn/auth/` self-hosted. */
  | { readonly provider: 'custom'; readonly url: string };

export interface Settings {
  readonly turn: TurnSettings;
}

export const DEFAULT_SETTINGS: Settings = { turn: { provider: 'none' } };

/**
 * The endpoint to fetch ICE servers from, or null for STUN only.
 *
 * Metered's shape comes from its own documented sample; a custom URL is passed
 * through untouched, since `iceservers.ts` accepts both response shapes.
 */
export function turnCredentialsUrl(s: Settings): string | null {
  const t = s.turn;
  switch (t.provider) {
    case 'metered': {
      const sub = t.subdomain.trim();
      const key = t.apiKey.trim();
      if (sub === '' || key === '') return null;
      return `https://${sub}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`;
    }
    case 'custom': {
      const url = t.url.trim();
      return url === '' ? null : url;
    }
    case 'none':
      return null;
  }
}

/** Narrow unknown JSON to settings, discarding anything unrecognised. */
export function parseSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const turn = (raw as { turn?: unknown }).turn;
  if (typeof turn !== 'object' || turn === null) return DEFAULT_SETTINGS;

  const provider = (turn as { provider?: unknown }).provider;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (provider === 'metered') {
    return {
      turn: {
        provider: 'metered',
        subdomain: str((turn as { subdomain?: unknown }).subdomain),
        apiKey: str((turn as { apiKey?: unknown }).apiKey),
      },
    };
  }
  if (provider === 'custom') {
    return { turn: { provider: 'custom', url: str((turn as { url?: unknown }).url) } };
  }
  return DEFAULT_SETTINGS;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw === null ? DEFAULT_SETTINGS : parseSettings(JSON.parse(raw));
  } catch {
    // Corrupt or unreadable settings must not stop the app starting.
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
