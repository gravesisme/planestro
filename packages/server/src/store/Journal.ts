import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal, type JournalEntry } from '@planestro/shared';

/** Month files this recent stay parsed in memory, read on from where they were last read; older ones are read from disk when asked for. */
const CACHED_MONTHS = 2;

/**
 * Token-shaped strings never reach the journal: a command line or an error that quoted one would otherwise sit there in
 * plain text (GitHub, Anthropic/OpenAI, Slack, AWS, a bearer header). The match is replaced, the entry kept.
 */
const SECRET_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g;
export const redactSecrets = (text: string): string => text.replace(SECRET_SHAPES, (_m, bearer?: string) => `${bearer ?? ''}[redacted]`);

export interface JournalQuery {
  since?: string; item?: string; type?: string;
  /** Any of these types (or those the predicate accepts); with `type`, both must hold. */
  types?: Iterable<string> | ((type: string) => boolean);
  /** The last `limit` matches. */
  limit?: number;
}

interface Parsed { size: number; entries: JournalEntry[]; byType: Map<string, JournalEntry[]>; byItem: Map<string, JournalEntry[]> }

/**
 * Append-only operational event stream, one NDJSON file per month. Written before
 * side effects (`op.begin`) and after (`op.end`) so a restart can find open operations.
 * Not tracked by the planning repository's git (schema 10): it is machine-local and grows by the hour.
 */
export class Journal {
  constructor(private readonly dir: string, private readonly onAppend?: (e: JournalEntry) => void) {}

  append(entry: Omit<JournalEntry, 'ts'> & { ts?: string }): JournalEntry {
    let full: JournalEntry = { ts: entry.ts ?? isoLocal(), ...entry } as JournalEntry;
    let line = JSON.stringify(full);
    const clean = redactSecrets(line);
    if (clean !== line) { line = clean; full = JSON.parse(clean); }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${full.ts.slice(0, 7)}.ndjson`), line + '\n');
    this.onAppend?.(full);
    return full;
  }

  begin(op: string, item: string | undefined, data: Record<string, unknown> = {}): string {
    const opId = `${op}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.append({ type: 'op.begin', item, actor: 'engine', data: { op, op_id: opId, ...data } });
    return opId;
  }

  end(opId: string, item: string | undefined, outcome: 'ok' | 'failed' | 'aborted', data: Record<string, unknown> = {}): void {
    const noted = this.notes.get(opId); this.notes.delete(opId);
    this.append({ type: 'op.end', item, actor: 'engine', data: { op_id: opId, outcome, ...noted, ...data } });
  }

  /** Data for an open op's `op.end`, whichever path ends it (#179: a CI wait's run timing). A later note replaces an earlier one. */
  note(opId: string, data: Record<string, unknown>): void { this.notes.set(opId, data); }
  private readonly notes = new Map<string, Record<string, unknown>>();

  private readonly parsed = new Map<string, Parsed>();

  /**
   * Entries in chronological order; `since` filters by timestamp text (ISO compare works for same-offset text) and skips
   * the month files wholly before it. Recent months are served from memory, indexed by type and item, and each read
   * parses only what was appended since the last one: every page load used to parse every line ever written.
   * The entries returned are shared: read them, never change them.
   */
  read(opts: JournalQuery = {}): JournalEntry[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f)).sort();
    const sinceMonth = opts.since ? monthBefore(opts.since.slice(0, 7)) : undefined; // a month early: `since` may carry another offset
    const cachedFrom = files[Math.max(0, files.length - CACHED_MONTHS)] ?? '';
    for (const f of this.parsed.keys()) if (!files.includes(f) || f < cachedFrom) this.parsed.delete(f);
    const wanted = typeFilter(opts);
    const keep = (e: JournalEntry) => (!opts.since || e.ts >= opts.since) && (!opts.item || e.item === opts.item) && wanted(e.type);
    const chunks: JournalEntry[][] = [];
    let found = 0;
    // Newest first, so a `limit` stops reading once it has enough.
    for (const f of [...files].reverse()) {
      if (sinceMonth && f.slice(0, 7) < sinceMonth) break;
      const chunk = f >= cachedFrom ? this.fromMemory(f, opts, keep) : this.fromDisk(f, opts, keep);
      chunks.push(chunk);
      found += chunk.length;
      if (opts.limit && found >= opts.limit) break;
    }
    const out = chunks.reverse().flat();
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  private fromMemory(f: string, opts: JournalQuery, keep: (e: JournalEntry) => boolean): JournalEntry[] {
    const p = this.refresh(f);
    let pool = p.entries;
    if (opts.item) pool = p.byItem.get(opts.item) ?? [];
    else if (opts.type) pool = p.byType.get(opts.type) ?? [];
    else if (opts.types && typeof opts.types !== 'function') {
      const lists = [...new Set(opts.types)].map((t) => p.byType.get(t) ?? []).filter((l) => l.length);
      pool = lists.length === 1 ? lists[0] : lists.length ? p.entries : [];
    }
    return pool.filter(keep);
  }

  /** The file as parsed, extended by whatever was appended since (by this process or another); a file that shrank is read again. */
  private refresh(f: string): Parsed {
    const path = join(this.dir, f);
    const size = statSync(path).size;
    let p = this.parsed.get(f);
    if (!p || size < p.size) { p = { size: 0, entries: [], byType: new Map(), byItem: new Map() }; this.parsed.set(f, p); }
    if (size === p.size) return p;
    const buf = Buffer.alloc(size - p.size);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, buf.length, p.size); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(0x0a); // a line still being written is read next time
    if (end < 0) return p;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      const e = parseLine(line);
      if (!e) continue;
      p.entries.push(e);
      push(p.byType, e.type, e);
      if (e.item) push(p.byItem, e.item, e);
    }
    p.size += end + 1;
    return p;
  }

  private fromDisk(f: string, opts: JournalQuery, keep: (e: JournalEntry) => boolean): JournalEntry[] {
    // A cheap text test before parsing: a line that cannot name the type or item asked for is skipped unparsed.
    const needles = opts.type ? [JSON.stringify(opts.type)] : opts.types && typeof opts.types !== 'function' ? [...opts.types].map((t) => JSON.stringify(t)) : undefined;
    const itemNeedle = opts.item ? JSON.stringify(opts.item) : undefined;
    const out: JournalEntry[] = [];
    for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
      if (needles && !needles.some((n) => line.includes(n))) continue;
      if (itemNeedle && !line.includes(itemNeedle)) continue;
      const e = parseLine(line);
      if (e && keep(e)) out.push(e);
    }
    return out;
  }

  /** `op.begin` entries with no matching `op.end`. */
  openOps(): JournalEntry[] {
    const begins = new Map<string, JournalEntry>();
    for (const e of this.read({ types: ['op.begin', 'op.end'] })) {
      const id = e.data?.op_id as string | undefined;
      if (!id) continue;
      if (e.type === 'op.begin') begins.set(id, e);
      if (e.type === 'op.end') begins.delete(id);
    }
    return [...begins.values()];
  }
}

function parseLine(line: string): JournalEntry | undefined {
  if (!line.trim()) return undefined;
  try { const e = JSON.parse(line); return e && typeof e.ts === 'string' && typeof e.type === 'string' ? e : undefined; } catch { return undefined; }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); }

function typeFilter(opts: JournalQuery): (type: string) => boolean {
  const one = opts.type;
  const t = opts.types;
  const any = t === undefined ? undefined : typeof t === 'function' ? t : ((s: Set<string>) => (x: string) => s.has(x))(new Set(t));
  return (type) => (!one || type === one) && (!any || any(type));
}

function monthBefore(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
