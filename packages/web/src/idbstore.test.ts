/**
 * The browser backend against the shared conformance suite.
 *
 * Runs under `fake-indexeddb`, which is a real implementation of the API rather
 * than a stub — so this checks the same behaviour a browser would, including
 * transaction semantics and structured clone of byte arrays.
 */
import { conformanceTests, type Store } from '@thing/engine';
import 'fake-indexeddb/auto';
import { IdbStore } from './idbstore.js';

let n = 0;

conformanceTests(
  'indexeddb',
  async (): Promise<Store> => {
    // A fresh prefix per store, so one test's databases cannot be seen by the
    // next — the suite expects an empty store each time.
    n += 1;
    return new IdbStore(`thing-test-${n}`);
  },
);
