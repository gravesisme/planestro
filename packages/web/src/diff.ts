/** A unified diff as the review panel shows it (#233): parsed from git's patch text, nothing asked of a model. */
export interface DiffLine { type: 'ctx' | 'add' | 'del'; old?: number; new?: number; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
/** A split view's row: the old line on the left, the new one on the right; a lone side leaves the other empty. */
export interface SplitRow { left?: DiffLine; right?: DiffLine }

/** Hunks from one file's `git diff` output; headers and "\ No newline" markers are not lines of the file. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | undefined, o = 0, n = 0;
  for (const raw of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) { cur = { header: raw, lines: [] }; hunks.push(cur); o = Number(h[1]); n = Number(h[2]); continue; }
    if (!cur || raw.startsWith('\\')) continue;
    const c = raw[0], text = raw.slice(1);
    if (c === '+') cur.lines.push({ type: 'add', new: n++, text });
    else if (c === '-') cur.lines.push({ type: 'del', old: o++, text });
    else if (c === ' ') cur.lines.push({ type: 'ctx', old: o++, new: n++, text });
  }
  return hunks;
}

/** Side by side: a run of removals pairs, line for line, with the additions that follow it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].type === 'ctx') { rows.push({ left: lines[i], right: lines[i] }); i++; continue; }
    const del: DiffLine[] = [], add: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') del.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') add.push(lines[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows.push({ left: del[k], right: add[k] });
  }
  return rows;
}

/** A line's key, stable across both views: its side and number. */
export const lineKey = (l: DiffLine) => l.type === 'del' ? `o${l.old}` : `n${l.new}`;

/** Selected lines as review feedback: the file and its line numbers, then the lines themselves as a diff. */
export function quoteLines(path: string, lines: DiffLine[]): string {
  if (!lines.length) return '';
  const nums = lines.map((l) => l.new ?? l.old!);
  const first = Math.min(...nums), last = Math.max(...nums);
  const at = first === last ? `line ${first}` : `lines ${first}–${last}`;
  const body = lines.map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`).join('\n');
  return `${path}, ${at}:\n\`\`\`diff\n${body}\n\`\`\``;
}
