import type { BreakdownChild } from './breakdown.ts';
import { renderPrompt, RenderError } from './placeholders.ts';

/**
 * An epic's children from a list (#239): one change applied to many targets is one child per target. A prompt template
 * and a list render children for the breakdown panel, where the user reviews them; nothing here creates anything.
 */
export type ChildListFormat = 'lines' | 'csv' | 'json';

/** One entry of the list: `item` names it, `fields` are its columns (CSV) or keys (JSON), `depends_on` is 0-based. */
export interface ChildListEntry { item: string; fields: Record<string, unknown>; depends_on: number[] }

export type ParsedChildList = { format: ChildListFormat; entries: ChildListEntry[] } | { problem: string };

/** A line's list marker (`- `, `* `, `+ `, `1. `, `1) `), as pasted from Markdown. */
const MARKER = /^(?:[-*+]|\d+[.)])\s+/;

/**
 * Lines (one entry each, blanks and list markers dropped), CSV (a header row names the fields) or a JSON array (of
 * strings, or objects whose fields the template may name). `auto` reads a JSON array as JSON and anything else as lines.
 * An entry is named by its `item` field, else its first. A `depends_on` field lists the entry numbers (1-based) it waits on.
 */
export function parseChildList(text: string, format: ChildListFormat | 'auto' = 'auto'): ParsedChildList {
  if (!text.trim()) return { problem: 'the list has no entries' };
  const fmt: ChildListFormat = format !== 'auto' ? format : /^\s*\[/.test(text) ? 'json' : 'lines';
  let rows: Record<string, unknown>[];
  if (fmt === 'lines') {
    rows = text.split(/\r?\n/).map((l) => l.trim().replace(MARKER, '').trim()).filter(Boolean).map((item) => ({ item }));
  } else if (fmt === 'csv') {
    const parsed = parseCsv(text);
    if (typeof parsed === 'string') return { problem: parsed };
    const [header, ...body] = parsed;
    const names = header.map((h) => h.trim());
    if (names.some((n) => !n)) return { problem: 'every column of the CSV header row needs a name' };
    if (!body.length) return { problem: 'the list has no entries: the CSV has a header row only' };
    for (const [i, r] of body.entries()) if (r.length > names.length) return { problem: `CSV row ${i + 2} has ${r.length} fields; the header has ${names.length}` };
    rows = body.map((r) => Object.fromEntries(names.map((n, k) => [n, (r[k] ?? '').trim()])));
  } else {
    let data: unknown;
    try { data = JSON.parse(text); } catch (e) { return { problem: `the list is not valid JSON: ${(e as Error).message}` }; }
    if (!Array.isArray(data)) return { problem: 'a JSON list is a JSON array of strings or objects' };
    rows = [];
    for (const [i, v] of data.entries()) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') rows.push({ item: String(v) });
      else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) rows.push(v as Record<string, unknown>);
      else return { problem: `entry ${i + 1} of the JSON list is ${JSON.stringify(v)}: each is a string or an object with fields` };
    }
  }
  if (!rows.length) return { problem: 'the list has no entries' };
  const entries: ChildListEntry[] = [];
  for (const [i, fields] of rows.entries()) {
    const named = fields.item ?? Object.values(fields)[0];
    const item = typeof named === 'string' ? named : JSON.stringify(named);
    const deps = dependsOn(fields.depends_on);
    if (typeof deps === 'string') return { problem: `entry ${i + 1} depends on ${JSON.stringify(deps)}, which is not a list of entry numbers` };
    for (const d of deps) {
      if (d < 1 || d > rows.length) return { problem: `entry ${i + 1} depends on ${d}, which is not an entry (1–${rows.length})` };
      if (d === i + 1) return { problem: `entry ${i + 1} depends on itself` };
    }
    entries.push({ item, fields, depends_on: [...new Set(deps)].map((d) => d - 1) });
  }
  return { format: fmt, entries };
}

/** Entry numbers from a number, an array of them, or text like "1, 2" / "1 2"; the original value when it is none of those. */
function dependsOn(v: unknown): number[] | string {
  if (v === undefined || v === null || v === '') return [];
  const parts = Array.isArray(v) ? v : typeof v === 'number' ? [v] : String(v).split(/[\s,;]+/).filter(Boolean);
  const out = parts.map((p) => typeof p === 'number' ? p : /^\d+$/.test(String(p).trim()) ? Number(String(p).trim()) : NaN);
  return out.every((n) => Number.isInteger(n)) ? out : String(Array.isArray(v) ? JSON.stringify(v) : v);
}

/** RFC 4180-ish: quoted fields may hold commas, newlines and doubled quotes. Rows that are wholly blank are dropped. */
function parseCsv(text: string): string[][] | string {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false; let i = 0;
  const endRow = () => { row.push(cell); cell = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && !cell.trim()) { quoted = true; cell = ''; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { endRow(); i += 2; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    cell += ch; i++;
  }
  if (quoted) return `the CSV has an unclosed quote in row ${rows.length + 1}`;
  endRow();
  return rows.length ? rows : 'the list has no entries';
}

export interface ChildListSpec {
  /** The brief each child is made from: `{{item}}`, `{{n}}` (its number) and `{{<field>}}` are filled in per entry. */
  template: string;
  /** Each child's title, filled in the same way; `{{item}}` when left empty. */
  title?: string;
  list: string;
  format?: ChildListFormat | 'auto';
  implementer: string;
  /** Omitted, each child takes its epic's category. */
  category?: string;
}

/** The children a template and a list render, for the user to review; `problem` names the first thing that stops it. */
export function childrenFromList(spec: ChildListSpec): { children: BreakdownChild[]; problem: string | null } {
  if (!spec.template.trim()) return { children: [], problem: 'write the prompt template each child is made from' };
  const parsed = parseChildList(spec.list, spec.format ?? 'auto');
  if ('problem' in parsed) return { children: [], problem: parsed.problem };
  const children: BreakdownChild[] = [];
  for (const [i, e] of parsed.entries.entries()) {
    const ctx = { ...e.fields, item: e.item, n: String(i + 1) };
    let title: string; let description: string;
    try {
      title = renderPrompt(spec.title?.trim() || '{{item}}', ctx, undefined, 'the title').replace(/\s+/g, ' ').trim();
      description = renderPrompt(spec.template, ctx, undefined, 'the template').trim();
    } catch (err) {
      if (!(err instanceof RenderError)) throw err;
      const have = ['item', 'n', ...Object.keys(e.fields).filter((k) => k !== 'item')].map((k) => `{{${k}}}`);
      return { children: [], problem: `entry ${i + 1} ("${e.item.slice(0, 40)}") has no ${err.missing.join(', ')}: use ${have.slice(0, -1).join(', ')} or ${have.at(-1)}` };
    }
    children.push({ title, description, implementer: spec.implementer, ...(spec.category ? { category: spec.category } : {}), depends_on: e.depends_on });
  }
  const seen = new Map<string, number>();
  for (const [i, c] of children.entries()) {
    const j = seen.get(c.description);
    if (j !== undefined) return { children: [], problem: `entries ${j + 1} and ${i + 1} get the same brief: the template needs a placeholder such as {{item}}` };
    seen.set(c.description, i);
  }
  return { children, problem: null };
}
