/**
 * The memory backend against the conformance suite.
 *
 * Runs first, so a conformance failure in a real backend is known to be about
 * persistence rather than about the shared rules.
 */
import { conformanceTests } from './conformance.js';
import { MemoryStore } from './memory.js';

conformanceTests('memory', async () => new MemoryStore());
