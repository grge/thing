/**
 * The platform surface `peer` may touch.
 *
 * Same reasoning as `core`'s copy: this package compiles with `"types": []` and
 * an ES2022-only `lib`, so neither DOM nor Node typings are in scope. A few
 * things exist in *both* runtimes and are needed here; those are declared, and
 * nothing else is.
 *
 * `crypto.getRandomValues` is here because minting an object identity needs
 * randomness, and both runtimes have it.
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

interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

declare const crypto: Crypto | undefined;
