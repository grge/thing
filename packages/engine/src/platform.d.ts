/**
 * The platform surface the engine may touch.
 *
 * The engine runs unchanged in a browser and in Node, so it must not assume
 * either one's globals. The obvious way to satisfy TypeScript would be to add
 * `"lib": ["DOM"]` or `"types": ["node"]` — but that admits *everything* those
 * environments offer, and a stray `localStorage` would then compile here and
 * fail at run time in a server.
 *
 * So instead: `"types": []`, an ES2022-only `lib`, and this file declaring
 * exactly what both runtimes genuinely provide. Anything not written here is a
 * compile error, which is the point. `boundary.test.ts` guards the
 * configuration, because widening it to fix one import would silently lose the
 * property everywhere.
 *
 * Everything the engine needs beyond this — storage, sockets, a place to keep
 * keys — is *supplied to it* rather than reached for. See `index.ts`.
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

interface CryptoKey {
  readonly type: string;
}

interface SubtleCrypto {
  digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
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
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    keyUsages: readonly string[],
  ): Promise<unknown>;
}

interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  readonly subtle: SubtleCrypto | undefined;
}

declare const crypto: Crypto | undefined;

/** Used by the ephemeral channel's expiry, and present in both runtimes. */
declare function setTimeout(handler: () => void, timeout?: number): unknown;
