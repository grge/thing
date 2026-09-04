import { describe, expect, it } from 'vitest';
import { rendererFor, shouldPrefetch } from './registry.js';
import './index.js';

describe('renderer selection (§4.7, FINDINGS F11)', () => {
  it('picks the renderer claiming the exact type', () => {
    expect(rendererFor('image/png')?.id).toBe('image');
    expect(rendererFor('text/markdown')?.id).toBe('text');
  });

  it('degrades a parameterised type to its base', () => {
    // The todo-list case: no todo renderer registered, so it renders as the
    // markdown it is rather than failing.
    expect(rendererFor('text/markdown; variant=todo')?.id).toBe('text');
  });

  it('degrades an unknown suffixed type to the suffix', () => {
    // A client that has never heard of a board still knows it is JSON.
    expect(rendererFor('application/vnd.thing.board+json')?.id).toBe('text');
  });

  it('degrades an unknown text subtype via text/*', () => {
    expect(rendererFor('text/x-something-invented')?.id).toBe('text');
  });

  it('degrades an unknown image subtype via image/*', () => {
    expect(rendererFor('image/x-invented')?.id).toBe('image');
  });

  it('picks the pdf renderer for application/pdf', () => {
    expect(rendererFor('application/pdf')?.id).toBe('pdf');
  });

  it('is null for a format nothing claims', () => {
    expect(rendererFor('application/octet-stream')).toBeNull();
    expect(rendererFor('video/mp4')).toBeNull();
    expect(rendererFor(null)).toBeNull();
    expect(rendererFor('nonsense')).toBeNull();
  });

  it('reports prefetch intent per type, for the canvas', () => {
    expect(shouldPrefetch('image/png')).toBe(true);
    // PDFs are large and this renderer cannot thumbnail them, so eager
    // fetching would buy the canvas nothing.
    expect(shouldPrefetch('application/pdf')).toBe(false);
    expect(shouldPrefetch('application/octet-stream')).toBe(false);
  });
});
