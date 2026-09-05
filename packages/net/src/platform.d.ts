/**
 * The platform surface `net` may touch.
 *
 * Same reasoning as `core`'s copy: this package compiles with `"types": []` and
 * an ES2022-only `lib`, so neither DOM nor Node typings are in scope. A few
 * things exist in *both* runtimes and are needed here; those are declared, and
 * nothing else is.
 *
 * `setTimeout` is here because backpressure has to wait for a channel to drain
 * (§2.4), and both runtimes have it.
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

declare function setTimeout(handler: () => void, timeout?: number): unknown;
