/**
 * The platform surface `store` may touch.
 *
 * Same reasoning as `core`'s copy: this package compiles with `"types": []` and
 * an ES2022-only `lib`, so neither DOM nor Node typings are in scope. A few
 * things exist in *both* runtimes and are needed here; those are declared, and
 * nothing else is.
 *
 * The backends are the exception and declare their own: `indexeddb.ts` needs
 * browser APIs, `files.ts` needs Node's. Each is imported only by the client
 * that can provide them.
 */

interface TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
  new (): TextEncoder;
};

interface TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string;
}

declare const TextDecoder: {
  new (label?: string, options?: { fatal?: boolean }): TextDecoder;
};
