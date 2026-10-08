import { describe, it, expect } from 'vitest';
import { parsePatch, splitRows, quoteLines, lineKey } from '../src/diff.ts';

const patch = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ export function f() {
 keep one
-old two
+new two
+added three
 keep four
\\ No newline at end of file
`;

describe('the review panel reads a file diff (#233)', () => {
  it('numbers each line on its own side', () => {
    const [h] = parsePatch(patch);
    expect(h.header).toBe('@@ -1,4 +1,4 @@ export function f() {');
    expect(h.lines).toEqual([
      { type: 'ctx', old: 1, new: 1, text: 'keep one' },
      { type: 'del', old: 2, text: 'old two' },
      { type: 'add', new: 2, text: 'new two' },
      { type: 'add', new: 3, text: 'added three' },
      { type: 'ctx', old: 3, new: 4, text: 'keep four' },
    ]);
    expect(parsePatch('Binary files /dev/null and b/x.bin differ\n')).toEqual([]);
  });

  it('pairs removals with the additions after them side by side', () => {
    const rows = splitRows(parsePatch(patch)[0].lines);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([['keep one', 'keep one'], ['old two', 'new two'], [null, 'added three'], ['keep four', 'keep four']]);
  });

  it('quotes selected lines with the file and their numbers', () => {
    const lines = parsePatch(patch)[0].lines;
    expect(quoteLines('src/a.ts', lines.slice(1, 3))).toBe('src/a.ts, line 2:\n```diff\n-old two\n+new two\n```');
    expect(quoteLines('src/a.ts', lines.slice(2, 4))).toBe('src/a.ts, lines 2–3:\n```diff\n+new two\n+added three\n```');
    expect(new Set(lines.map(lineKey)).size).toBe(lines.length);
  });
});
