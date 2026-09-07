/**
 * Choosing a renderer.
 *
 * The property that matters is degradation: an object with a type nothing
 * claims exactly should still be shown by something more general, rather than
 * failing. That is §3.1's tiering at the presentation layer.
 */
import { describe, expect, it } from 'vitest';

import { register, rendererFor } from './registry.js';

// Stubs rather than the real components: the unit under test is the selection
// rule, and importing `.svelte` here would need a Svelte plugin in the test
// runner to check something that has nothing to do with rendering.
//
// The claims must mirror `index.ts`. That duplication is the cost of not
// pulling a compiler into a unit test, and it is small — but if a renderer's
// claims change there, they must change here.
const stub = (() => undefined) as never;
register({ id: 'text', claims: ['text/*', 'application/json', 'application/xml'], component: stub });
register({ id: 'image', claims: ['image/*'], component: stub });
register({ id: 'pdf', claims: ['application/pdf'], component: stub, fills: true });

describe('rendererFor', () => {
  it('matches an exact claim', () => {
    expect(rendererFor('application/pdf')?.id).toBe('pdf');
  });

  it('matches a wildcard when nothing claims the exact type', () => {
    // Nothing claims `image/avif`; `image/*` does.
    expect(rendererFor('image/avif')?.id).toBe('image');
    expect(rendererFor('text/markdown')?.id).toBe('text');
  });

  it('falls back along a +suffix, which is the point of the chain', () => {
    // A client that has never heard of a board still knows it is JSON.
    expect(rendererFor('application/vnd.thing.board+json')?.id).toBe('text');
  });

  it('ignores parameters when nothing claims the parameterised form', () => {
    expect(rendererFor('text/markdown; variant=todo')?.id).toBe('text');
  });

  it('is null for a type nothing can show', () => {
    // Honest: the preview offers a download rather than pretending.
    expect(rendererFor('application/octet-stream')).toBeNull();
    expect(rendererFor('video/mp4')).toBeNull();
  });

  it('is null for an absent or unparseable type', () => {
    expect(rendererFor(null)).toBeNull();
    expect(rendererFor('nonsense')).toBeNull();
  });
});
