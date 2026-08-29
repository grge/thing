import { describe, expect, it } from 'vitest';
import { degradations, downloadType, effectiveType, parseType, typeFromName } from './mime.js';

describe('parseType (§4.7)', () => {
  it('splits a plain type', () => {
    const t = parseType('text/markdown')!;
    expect(t.top).toBe('text');
    expect(t.sub).toBe('markdown');
    expect(t.essence).toBe('text/markdown');
    expect(t.suffix).toBeNull();
  });

  it('extracts a structured suffix', () => {
    expect(parseType('application/vnd.thing.board+json')!.suffix).toBe('json');
  });

  it('reads parameters', () => {
    const t = parseType('text/markdown; variant=todo')!;
    expect(t.essence).toBe('text/markdown');
    expect(t.params).toEqual({ variant: 'todo' });
  });

  it('strips quotes from parameter values', () => {
    expect(parseType('text/plain; charset="utf-8"')!.params['charset']).toBe('utf-8');
  });

  it('lowercases the essence but not parameter values', () => {
    const t = parseType('TEXT/Markdown; Variant=ToDo')!;
    expect(t.essence).toBe('text/markdown');
    expect(t.params['variant']).toBe('ToDo');
  });

  it('returns null rather than throwing on junk', () => {
    for (const bad of ['', '   ', 'notamime', '/leading', 'trailing/', null]) {
      expect(parseType(bad)).toBeNull();
    }
  });
});

describe('degradations (§4.7)', () => {
  it('falls back through suffix to the base type', () => {
    // The point of the suffix: a client that has never heard of a board still
    // knows the payload is JSON.
    expect(degradations('application/vnd.thing.board+json')).toEqual([
      'application/vnd.thing.board+json',
      'application/json',
      'application/*',
    ]);
  });

  it('keeps the parameterised form as the most specific candidate', () => {
    // A todo list is markdown, and a client with no todo renderer still renders
    // it as markdown rather than failing.
    expect(degradations('text/markdown; variant=todo')).toEqual([
      'text/markdown; variant=todo',
      'text/markdown',
      'text/*',
    ]);
  });

  it('handles a plain type', () => {
    expect(degradations('image/png')).toEqual(['image/png', 'image/*']);
  });

  it('is empty for an unparseable type', () => {
    expect(degradations('nonsense')).toEqual([]);
    expect(degradations(null)).toEqual([]);
  });
});

describe('typeFromName — fallback only', () => {
  it('maps known extensions', () => {
    expect(typeFromName('photo.png')).toBe('image/png');
    expect(typeFromName('notes.MD')).toBe('text/markdown');
    expect(typeFromName('paper.pdf')).toBe('application/pdf');
  });

  it('is null for an unknown or absent extension', () => {
    expect(typeFromName('README')).toBeNull();
    expect(typeFromName('archive.xyz')).toBeNull();
    expect(typeFromName('.hidden')).toBeNull();
    expect(typeFromName(null)).toBeNull();
  });
});

describe('effectiveType', () => {
  it('prefers what the object asserts over what its name suggests', () => {
    // The decisive case: a todo list is markdown by content and by extension,
    // and only the assertion distinguishes it (FINDINGS F11).
    expect(effectiveType('text/markdown; variant=todo', 'list.md')).toBe(
      'text/markdown; variant=todo',
    );
  });

  it('falls back to the extension when nothing is asserted', () => {
    expect(effectiveType(null, 'photo.png')).toBe('image/png');
  });

  it('ignores an unparseable assertion and falls back', () => {
    expect(effectiveType('garbage', 'photo.png')).toBe('image/png');
  });

  it('is null when neither says anything', () => {
    expect(effectiveType(null, 'README')).toBeNull();
  });
});

describe('downloadType', () => {
  it('always yields something a download can use', () => {
    expect(downloadType(null, 'README')).toBe('application/octet-stream');
    expect(downloadType('text/markdown; variant=todo', null)).toBe('text/markdown');
    expect(downloadType(null, 'photo.png')).toBe('image/png');
  });
});
