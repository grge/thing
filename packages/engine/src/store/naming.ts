/**
 * Naming spaces (ARCHITECTURE.md §5.5).
 *
 * There is no global namespace and no registry. Every peer names spaces for
 * itself, so nothing here is replicated and nothing here is authoritative —
 * two people can call the same space different things, and two different spaces
 * can share a name without conflict.
 *
 * Three layers, in the order §4.6's petname argument gives them:
 *
 * 1. **A petname** — what this client calls it. Local, and it wins.
 * 2. **The suggested name** — what the space calls itself, on its root. Signed
 *    and replicated, so unforgeable but not unique.
 * 3. **The short code** — derived from the key (§5.4), so it always exists.
 *
 * The key is underneath all of it and always works. Nothing ever *resolves* by
 * name in the protocol: names are for people recognising things they have
 * already met, and keys are for machines deciding what something is.
 */
import { codeFor, isCode, type PublicKey } from '../core/index.js';
import type { SpaceId } from './types.js';

/** Petnames a client has chosen, kept with the store they name (§5.5). */
export interface PetnameStore {
  /** All petnames, name -> space id. */
  all(): Promise<ReadonlyMap<string, SpaceId>>;
  set(name: string, space: SpaceId): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * What one space can be called.
 *
 * `display` is what a person should see: the petname if there is one, else what
 * the space calls itself, else the code — never an unadorned 64-character key,
 * which is unreadable and untypeable.
 */
export interface SpaceNames {
  readonly id: SpaceId;
  readonly code: string;
  readonly petname: string | null;
  readonly suggested: string | null;
  readonly display: string;
}

export function namesFor(
  key: PublicKey,
  options: { petname?: string | null; suggested?: string | null } = {},
): SpaceNames {
  const id = hexOf(key);
  const code = codeFor(key);
  const petname = options.petname ?? null;
  const suggested = options.suggested ?? null;
  return {
    id,
    code,
    petname,
    suggested,
    display: petname ?? suggested ?? code,
  };
}

/** Why a name could not be turned into exactly one space. */
export type ResolveFailure =
  | { readonly kind: 'unknown'; readonly query: string }
  | { readonly kind: 'ambiguous'; readonly query: string; readonly matches: readonly SpaceId[] };

export type Resolution =
  | { readonly ok: true; readonly id: SpaceId }
  | { readonly ok: false; readonly why: ResolveFailure };

/**
 * Turn whatever a person typed into one space.
 *
 * Tried in order of how specific the thing is, so a full key always wins and an
 * ambiguous name is **an error rather than a guess** — silently picking one of
 * two spaces because they happen to share a name is the kind of mistake that is
 * discovered much later.
 */
export function resolveName(query: string, spaces: readonly SpaceNames[]): Resolution {
  const lower = query.toLowerCase();

  // A full key: unambiguous by construction.
  if (lower.length === 64 && /^[0-9a-f]+$/.test(lower)) {
    return { ok: true, id: lower };
  }

  const byExact = (pick: (s: SpaceNames) => string | null): SpaceId[] =>
    spaces.filter((s) => pick(s)?.toLowerCase() === lower).map((s) => s.id);

  for (const candidates of [
    byExact((s) => s.petname),
    byExact((s) => s.suggested),
    isCode(lower) ? byExact((s) => s.code) : [],
    // A key prefix, last: it is the least likely thing a person typed on
    // purpose, and the most likely to collide when short.
    lower.length >= 4 && /^[0-9a-f]+$/.test(lower)
      ? spaces.filter((s) => s.id.startsWith(lower)).map((s) => s.id)
      : [],
  ]) {
    if (candidates.length === 1) return { ok: true, id: candidates[0]! };
    if (candidates.length > 1) {
      return { ok: false, why: { kind: 'ambiguous', query, matches: candidates } };
    }
  }

  return { ok: false, why: { kind: 'unknown', query } };
}

function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
