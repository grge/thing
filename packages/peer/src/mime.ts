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
