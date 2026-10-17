import { describe, it, expect } from 'vitest';
import { trimLineEnds, isTableSeparator, atxHeading, h1Title, trimEndBlanks, joinLines, epicShapeOf, holdShapeOf, parseItemFile, serializeItemFile, appendActivity } from '../src/index.ts';

const timed = (fn: () => unknown): number => { const t = performance.now(); fn(); return performance.now() - t; };
const spaces = ' '.repeat(50_000);

describe('text a worker or a stranger wrote is scanned in linear time', () => {
  it('keeps each regex it replaced to the letter', () => {
    expect(trimLineEnds('a \t\nb  \r\nc\t')).toBe('a\nb\r\nc');
    expect(isTableSeparator('| :--- | ---: |')).toBe(true);
    expect(isTableSeparator('|---|')).toBe(true);
    expect(isTableSeparator('| a | --- |')).toBe(false);
    expect(isTableSeparator('||')).toBe(false);
    expect(atxHeading('## Children ##')).toEqual({ level: 2, text: 'Children' });
    expect(atxHeading('# C#')).toEqual({ level: 1, text: 'C' });
    expect(atxHeading('####### seven')).toBeNull();
    expect(atxHeading('#nospace')).toBeNull();
    expect(h1Title('# Plan  ')).toBe('Plan');
    expect(h1Title('## Plan')).toBeUndefined();
    expect(trimEndBlanks('ls \t')).toBe('ls');
    expect(joinLines(' a \n\n  b \n')).toBe(' a b ');
  });

  it('finishes on 50,000 spaces, hashes or dashes in a fraction of a second', () => {
    const cases: [string, () => unknown][] = [
      ['trimLineEnds', () => trimLineEnds(spaces + 'x')],
      ['separator', () => isTableSeparator('-' + spaces + 'x')],
      ['heading', () => atxHeading('# a' + spaces + 'x')],
      ['heading #', () => atxHeading('# a' + '#'.repeat(50_000) + 'x')],
      ['h1', () => h1Title('# a' + spaces + 'x')],
      ['joinLines', () => joinLines('a' + spaces + 'b\nc')],
      ['epicShapeOf', () => epicShapeOf('# children' + spaces + 'x\n- a\n- b\n|' + '-'.repeat(50_000) + spaces + 'x|')],
      ['holdShapeOf', () => holdShapeOf('| a |\n|-' + spaces + 'x|\n')],
      ['parseItemFile', () => parseItemFile(`---\nschema: 1\nid: X-1\ntitle: t\ncategory: c\nstatus: QUEUED\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Plan${spaces}x\n\nbody${spaces}x\n`)],
    ];
    for (const [name, fn] of cases) expect(timed(fn), name).toBeLessThan(250);
  });

  it('an item file with long whitespace in its sections round-trips quickly', () => {
    const file = parseItemFile(`---\nschema: 1\nid: X-1\ntitle: t\ncategory: c\nstatus: QUEUED\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Notes\n\nnote${spaces}x\n`);
    expect(timed(() => appendActivity(file, 'worker', `done${spaces}x\n  next`))).toBeLessThan(250);
    expect(timed(() => serializeItemFile(file))).toBeLessThan(250);
    expect(serializeItemFile(file)).toContain(`] done${spaces}x next`);
  });
});
