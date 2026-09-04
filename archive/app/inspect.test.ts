import { describe, expect, it } from 'vitest';
import { summarise, toRows } from './inspect.js';
import { fold, ROOT } from '../fold/index.js';
import { TestWriter, uuid, writer } from '../fold/testkit.js';

describe('toRows', () => {
  it('labels targets and resolves uuid values to names', () => {
    const a = new TestWriter(writer('alice'));
    const dir = uuid('dir');
    const file = uuid('file');
    const log = [a.name(dir, 'docs'), a.name(file, 'notes.txt'), a.parent(file, dir)];
    const rows = toRows(log, fold(log));

    expect(rows[1]!.targetLabel).toBe('notes.txt');
    expect(rows[1]!.value).toBe('"notes.txt"');
    expect(rows[2]!.value).toContain('(docs)');
  });

  it('renders ROOT by name, not as zeroes', () => {
    const a = new TestWriter(writer('alice'));
    const log = [a.parent(uuid('f'), ROOT)];
    expect(toRows(log, fold(log))[0]!.value).toBe('ROOT');
  });

  it('shows null content distinctly from a hash', () => {
    const a = new TestWriter(writer('alice'));
    const f = uuid('f');
    const log = [a.content(f, null)];
    expect(toRows(log, fold(log))[0]!.value).toBe('null');
  });
});

describe('summarise (§3.1)', () => {
  it('reports the highest contiguous seq, not the highest held', () => {
    // The version vector rule: holding 0,1,2 and 4 reports 2, because 4 sits
    // past a gap and is unapplied until 3 arrives (§3.3).
    const a = new TestWriter(writer('alice'));
    const t = uuid('f');
    const all = [a.name(t, 'a'), a.name(t, 'b'), a.name(t, 'c'), a.name(t, 'd'), a.name(t, 'e')];
    const withGap = [all[0]!, all[1]!, all[2]!, all[4]!];

    const [s] = summarise(withGap);
    expect(s!.contiguous).toBe(2);
    expect(s!.highest).toBe(4);
    expect(s!.gaps).toEqual([4]);
  });

  it('reports no gaps for a complete chain', () => {
    const a = new TestWriter(writer('alice'));
    const t = uuid('f');
    const [s] = summarise([a.name(t, 'a'), a.name(t, 'b'), a.name(t, 'c')]);
    expect(s!.contiguous).toBe(2);
    expect(s!.gaps).toEqual([]);
  });

  it('separates writers', () => {
    const a = new TestWriter(writer('alice'));
    const b = new TestWriter(writer('bob'));
    const t = uuid('f');
    const rows = summarise([a.name(t, 'x'), b.name(t, 'y'), b.name(t, 'z')]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.count).sort()).toEqual([1, 2]);
  });
});
