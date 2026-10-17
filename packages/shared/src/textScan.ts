/**
 * Linear-time stand-ins for regexes that backtracked on long runs of whitespace (or `#`, or `-`) in text a worker or
 * a stranger wrote: `/\s+$/` took 4 s on 50,000 spaces, and a breakdown heading's took 11 s on 2,000, with the server
 * frozen meanwhile. Each keeps the regex's meaning, written as a scan.
 */

const LINE_END = new Set(['\n', '\r', '\u2028', '\u2029']);

/** `text.replace(/[ \t]+$/gm, '')`: spaces and tabs dropped before every line end and at the end of the text. */
export function trimLineEnds(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !LINE_END.has(text[i])) continue;
    let end = i;
    while (end > from && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
    out += text.slice(from, end) + (i < text.length ? text[i] : '');
    from = i + 1;
  }
  return out;
}

/** `/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(row.trim())`: a Markdown table's header separator row. */
export function isTableSeparator(row: string): boolean {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|')) r = r.slice(0, -1);
  return r.split('|').every((cell) => /^:?-+:?$/.test(cell.trim()));
}

/** `/^(#{1,6})\s+(.+?)\s*#*\s*$/`: an ATX heading's level and text, the closing `#`s and the spaces around them dropped. */
export function atxHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && line[level] === '#') level++;
  if (level < 1 || level > 6 || !/\s/.test(line[level] ?? '')) return null;
  const rest = line.slice(level);
  let text = rest.trim();
  let end = text.length;
  while (end > 1 && text[end - 1] === '#') end--; // the regex keeps at least one character
  text = text.slice(0, end).trimEnd();
  if (/[\n\r\u2028\u2029]/.test(text)) return null; // `.` stops at a line end; the `\s` around it does not
  return text ? { level, text } : null;
}

/** `/^# (.+?)\s*$/.exec(line)?.[1]`: a top-level `# Title` heading's title, trailing spaces dropped. */
export function h1Title(line: string): string | undefined {
  if (!line.startsWith('# ') || line.length < 3) return undefined;
  const title = line.slice(2).trimEnd() || line[2]; // the regex keeps at least one character
  return /[\n\r\u2028\u2029]/.test(title) ? undefined : title;
}

/** `text.replace(/[ \t]+$/, '')`: spaces and tabs dropped from the end of the text only. */
export function trimEndBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(0, end);
}

/** Each line break, with the whitespace around it, made one space (what `\s*\n\s*` replaced by a space did). */
export function joinLines(text: string): string {
  const parts = text.split('\n');
  if (parts.length === 1) return text;
  const middle = parts.slice(1, -1).map((p) => p.trim()).filter(Boolean);
  return [parts[0].trimEnd(), ...middle, parts[parts.length - 1].trimStart()].join(' ');
}
