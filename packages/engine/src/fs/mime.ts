/**
 * Guessing what a file is, from its name.
 *
 * `:kind` names a body rule *and* tells a view what the bytes are — the
 * overloading ARCHITECTURE.md §3.9 flags. A browser gets a media type from the
 * `File` it was handed; anything else has only a filename, and a wrong guess is
 * better than `application/octet-stream` on every file, which tells a view
 * nothing at all.
 *
 * **A guess, and only a guess.** It is advisory (§4.2): a view that cannot draw
 * what the kind claims falls back on the bytes, and nothing about replication
 * or folding depends on this being right.
 */

/**
 * Extensions worth knowing, and nothing more.
 *
 * Deliberately short. A complete media-type table is a large thing to carry
 * for a marginal improvement over "unknown", and the cases that matter are the
 * ones a person actually puts in a shared folder.
 */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  // text
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  go: 'text/x-go',
  sh: 'text/x-shellscript',
  toml: 'text/x-toml',
  log: 'text/plain',

  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',

  // documents
  pdf: 'application/pdf',
  epub: 'application/epub+zip',

  // audio and video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',

  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
};

/** What this file is, as far as its name says. */
export function kindForName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Whether a kind is text a view can reasonably show.
 *
 * `text/*` plus the structured formats that are text in everything but their
 * top-level type. Kept here rather than in a view, so the browser and anything
 * else agree about it.
 */
export function isTextual(kind: string | null): boolean {
  if (kind === null) return false;
  if (kind.startsWith('text/')) return true;
  return (
    kind === 'application/json' ||
    kind === 'application/xml' ||
    kind === 'application/yaml' ||
    kind === 'image/svg+xml'
  );
}

/* ── parsing a type, and degrading along it ─────────────────────────────── */

/**
 * A parsed media type.
 *
 * `:kind` names a **format**, never a renderer: `text/markdown`, not
 * `todo-list`. That distinction is what lets a terminal client, a browser and
 * a client with a bespoke renderer all show the same object usefully — each
 * degrades along the type until it finds something it understands.
 */
export interface ParsedType {
  /** e.g. `application` */
  readonly top: string;
  /** e.g. `vnd.thing.board+json` */
  readonly sub: string;
  /** The `+suffix`, if any: `json`, `xml`. */
  readonly suffix: string | null;
  /** `text/markdown` — the type without parameters. */
  readonly essence: string;
  /** `; variant=todo` becomes `{ variant: 'todo' }`. Keys lowercased. */
  readonly params: Readonly<Record<string, string>>;
}

/** Parse a media type. Null for anything unparseable — never throws. */
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
 * Candidate types to try, most specific first.
 *
 * `application/vnd.thing.board+json; schema=kanban` yields:
 *
 * ```
 * application/vnd.thing.board+json; schema=kanban
 * application/vnd.thing.board+json
 * application/json                    <- the +suffix fallback
 * application/*
 * ```
 *
 * **The suffix step is what keeps a specialised type readable.** A client that
 * has never heard of a board still knows it is JSON, and shows it as such
 * rather than as a byte count. That is §3.1's tiering — fold what you can,
 * show what you cannot — applied to presentation.
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

/** A type with its parameters sorted, so two spellings compare equal. */
function normalise(raw: string): string {
  const t = parseType(raw);
  if (t === null) return raw.trim().toLowerCase();
  const params = Object.entries(t.params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `; ${k}=${v}`)
    .join('');
  return t.essence + params;
}
