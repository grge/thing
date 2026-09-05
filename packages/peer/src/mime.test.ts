/**
 * Guessing a kind from a filename.
 *
 * A guess, and advisory (§4.2) — but a wrong guess beats
 * `application/octet-stream` on every file, which tells a view nothing.
 */
import { describe, expect, it } from 'vitest';
import { isTextual, kindForName } from './mime.js';

describe('kindForName', () => {
  it('knows the cases people actually share', () => {
    expect(kindForName('readme.txt')).toBe('text/plain');
    expect(kindForName('notes.md')).toBe('text/markdown');
    expect(kindForName('photo.jpg')).toBe('image/jpeg');
    expect(kindForName('report.pdf')).toBe('application/pdf');
    expect(kindForName('data.json')).toBe('application/json');
  });

  it('is case-insensitive about the extension', () => {
    expect(kindForName('PHOTO.JPG')).toBe('image/jpeg');
  });

  it('falls back rather than guessing wildly', () => {
    expect(kindForName('unknown.zzz')).toBe('application/octet-stream');
    expect(kindForName('noextension')).toBe('application/octet-stream');
    // A dotfile is not an extension: `.bashrc` is a name, not a `bashrc` file.
    expect(kindForName('.bashrc')).toBe('application/octet-stream');
    expect(kindForName('trailing.')).toBe('application/octet-stream');
  });

  it('uses the last extension', () => {
    expect(kindForName('archive.tar.gz')).toBe('application/gzip');
  });
});

describe('isTextual', () => {
  it('accepts text and the structured formats that are text', () => {
    expect(isTextual('text/plain')).toBe(true);
    expect(isTextual('text/markdown')).toBe(true);
    expect(isTextual('application/json')).toBe(true);
    expect(isTextual('image/svg+xml')).toBe(true);
  });

  it('rejects binary and the unknown', () => {
    expect(isTextual('image/png')).toBe(false);
    expect(isTextual('application/octet-stream')).toBe(false);
    expect(isTextual(null)).toBe(false);
  });
});
