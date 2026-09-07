/**
 * Parsing a media type, and degrading along it.
 *
 * The degradation chain is what keeps a specialised type readable: a client
 * that has never heard of a board still knows it is JSON.
 */
import { describe, expect, it } from 'vitest';

import { degradations, parseType } from './mime.js';

describe('parseType', () => {
  it('splits a plain type', () => {
    expect(parseType('text/markdown')).toMatchObject({
      top: 'text',
      sub: 'markdown',
      essence: 'text/markdown',
      suffix: null,
    });
  });

  it('finds a +suffix', () => {
    expect(parseType('application/vnd.thing.board+json')?.suffix).toBe('json');
  });

  it('reads parameters, lowercasing keys and unquoting values', () => {
    expect(parseType('text/plain; Charset="utf-8"')?.params).toEqual({ charset: 'utf-8' });
  });

  it('returns null rather than throwing on anything unparseable', () => {
    // A `:kind` is advisory (§4.2) and may be anything a writer put there, so
    // this runs on untrusted input and must never be the thing that fails.
    for (const bad of [null, '', '   ', 'notatype', '/leading', 'trailing/', 'a/b/c'.slice(0, 1)]) {
      expect(parseType(bad)).toBeNull();
    }
  });
});

describe('degradations', () => {
  it('walks from most specific to least', () => {
    expect(degradations('application/vnd.thing.board+json; schema=kanban')).toEqual([
      'application/vnd.thing.board+json; schema=kanban',
      'application/vnd.thing.board+json',
      'application/json',
      'application/*',
    ]);
  });

  it('omits the parameter step when there are none', () => {
    expect(degradations('text/markdown')).toEqual(['text/markdown', 'text/*']);
  });

  it('sorts parameters, so two spellings of one type agree', () => {
    expect(degradations('text/plain; b=2; a=1')[0]).toBe(degradations('text/plain; a=1; b=2')[0]);
  });

  it('is empty for an unparseable type, so a caller falls through', () => {
    expect(degradations(null)).toEqual([]);
    expect(degradations('nonsense')).toEqual([]);
  });
});
