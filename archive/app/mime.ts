/**
 * MIME handling (§4.7).
 *
 * `:type` names a **format**, never a renderer. `text/markdown`, not
 * `todo-list`. A client with no renderer for a type degrades along the type
 * itself rather than failing: that is what lets a TUI client, a web client, and
 * a client with a bespoke renderer all show the same object usefully.
 */

export interface ParsedType {
  /** e.g. `application` */
  readonly top: string;
  /** e.g. `vnd.thing.board+json` */
  readonly sub: string;
  /** The `+suffix`, if any: `json`, `xml`, `octet-stream`. */
  readonly suffix: string | null;
  /** `text/markdown` — the type without parameters. */
  readonly essence: string;
  /** `; variant=todo` → `{ variant: 'todo' }`. Lowercased keys. */
  readonly params: Readonly<Record<string, string>>;
}

/** Parse a MIME type. Returns null for anything unparseable — never throws. */
export function parseType(raw: string | null): ParsedType | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const [essenceRaw = '', ...paramParts] = trimmed.split(';');
  const essence = essenceRaw.trim().toLowerCase();
  const slash = essence.indexOf('/');
  if (slash <= 0 || slash === essence.length - 1) return null;

  const top = essence.slice(0, slash);
  const sub = essence.slice(slash + 1);
  const plus = sub.lastIndexOf('+');

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key !== '') params[key] = value;
  }

  return {
    top,
    sub,
    suffix: plus > 0 ? sub.slice(plus + 1) : null,
    essence,
    params,
  };
}

/**
 * Candidate types to try, most specific first (§4.7).
 *
 * `application/vnd.thing.board+json; schema=kanban` yields:
 *   application/vnd.thing.board+json; schema=kanban
 *   application/vnd.thing.board+json
 *   application/json          ← the +suffix fallback
 *   application/*
 *
 * The suffix step is what makes an unknown specialised type still readable: a
 * client that has never heard of a board still knows it is JSON.
 */
export function degradations(raw: string | null): string[] {
  const t = parseType(raw);
  if (t === null) return [];

  const out: string[] = [];
  if (Object.keys(t.params).length > 0) out.push(normalise(raw!));
  out.push(t.essence);
  if (t.suffix !== null) out.push(`${t.top}/${t.suffix}`);
  out.push(`${t.top}/*`);
  return [...new Set(out)];
}

function normalise(raw: string): string {
  const t = parseType(raw);
  if (t === null) return raw.trim().toLowerCase();
  const params = Object.entries(t.params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `; ${k}=${v}`)
    .join('');
  return t.essence + params;
}

/**
 * Last-resort type for an object with no `:type` (§4.7).
 *
 * Extension only, and only for objects created before `:type` existed or by a
 * client that did not assert one. Never guessed from content: a todo list and a
 * plain note can hold identical markdown bytes, so content cannot distinguish
 * them (FINDINGS F11).
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/plain',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

export function typeFromName(name: string | null): string | null {
  if (name === null) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The type to render an object as: what it asserts, else what its name
 * suggests. Null means unknown, which the UI shows as "not renderable" rather
 * than guessing (§8.2).
 */
export function effectiveType(asserted: string | null, name: string | null): string | null {
  if (asserted !== null && parseType(asserted) !== null) return asserted;
  return typeFromName(name);
}

/** A MIME safe to hand a download. Never null, so a file can always be saved. */
export function downloadType(asserted: string | null, name: string | null): string {
  return parseType(effectiveType(asserted, name))?.essence ?? 'application/octet-stream';
}
