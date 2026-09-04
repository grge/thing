/**
 * @thing/core — events, canonical encoding, signing, and the fold.
 *
 * No I/O, no platform. `lib` is ES2022 only (tsconfig.base.json), so a stray
 * `localStorage` or `document` reference fails to compile rather than failing
 * at run time in the headless peer.
 */

export const PACKAGE = '@thing/core';
