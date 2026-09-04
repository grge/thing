/**
 * The platform surface `core` is allowed to touch, declared rather than
 * inherited.
 *
 * `core` compiles with `"types": []` and an ES2022-only `lib`, so neither DOM
 * nor Node typings are in scope — which is the point (ARCHITECTURE.md §5.6: the
 * headless peer and the browser run the same code). But a few things genuinely
 * exist in *both* runtimes and are needed here: WebCrypto for signing, and
 * `TextEncoder` for canonical UTF-8.
 *
 * Declaring exactly those, and nothing else, keeps the boundary meaningful. The
 * alternative — widening `types` to `["node"]` or adding `DOM` to `lib` — would
 * make `localStorage` and `process` compile too, and the property this package
 * exists to guarantee would be gone.
 *
 * Every member here must be present in both a browser and Node. Anything that
 * is not belongs in `web` or `node`.
 */

interface TextEncoder {
  encode(input?: string): Uint8Array;
}

declare const TextEncoder: {
  new (): TextEncoder;
};

interface SubtleCrypto {
  digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<unknown>;
  importKey(
    format: string,
    keyData: ArrayBufferView | ArrayBuffer,
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<CryptoKey>;
  sign(
    algorithm: string,
    key: CryptoKey,
    data: ArrayBufferView | ArrayBuffer,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: string,
    key: CryptoKey,
    signature: ArrayBufferView | ArrayBuffer,
    data: ArrayBufferView | ArrayBuffer,
  ): Promise<boolean>;
}

interface CryptoKey {
  readonly type: string;
}

interface Crypto {
  readonly subtle: SubtleCrypto | undefined;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

declare const crypto: Crypto | undefined;
