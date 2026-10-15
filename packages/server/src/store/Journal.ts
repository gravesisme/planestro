import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoLocal, type JournalEntry } from '@planestro/shared';

/**
 * Append-only operational event stream, one NDJSON file per month. Written before
 * side effects (`op.begin`) and after (`op.end`) so a restart can find open operations.
 */
export class Journal {
  constructor(private readonly dir: string, private readonly onAppend?: (e: JournalEntry) => void) {}

  append(entry: Omit<JournalEntry, 'ts'> & { ts?: string }): JournalEntry {
    const full: JournalEntry = { ts: entry.ts ?? isoLocal(), ...entry } as JournalEntry;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, `${full.ts.slice(0, 7)}.ndjson`), JSON.stringify(full) + '\n');
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

  /** Entries in chronological order; `since` filters by timestamp text (ISO compare works for same-offset text). */
  read(opts: { since?: string; item?: string; type?: string; limit?: number } = {}): JournalEntry[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.ndjson')).sort();
    const out: JournalEntry[] = [];
    for (const f of files) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e: JournalEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (opts.since && e.ts < opts.since) continue;
        if (opts.item && e.item !== opts.item) continue;
        if (opts.type && e.type !== opts.type) continue;
        out.push(e);
      }
    }
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  /** `op.begin` entries with no matching `op.end`. */
  openOps(): JournalEntry[] {
    const begins = new Map<string, JournalEntry>();
    for (const e of this.read()) {
      const id = e.data?.op_id as string | undefined;
      if (!id) continue;
      if (e.type === 'op.begin') begins.set(id, e);
      if (e.type === 'op.end') begins.delete(id);
    }
    return [...begins.values()];
  }
}
