import { SCHEMA_VERSION, categoryColors, QUESTION_SECTIONS, canonicalTimestamp, isoLocal, parseItemFile, serializeQuestionFile, setQuestionSection, appendThread, type QuestionFile } from '@planestro/shared';
import YAML from 'yaml';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../store/atomicWrite.ts';
import { GitCommitter } from '../store/GitCommitter.ts';
import { CONFIG_FILE, TOOL_VERSION } from '../config.ts';

export interface Migration { version: number; describe: string; up(dataDir: string, log: (m: string) => void): Promise<void> | void }

/** Ordered by version; each `up` takes the dir from version-1 to version. */
export const MIGRATIONS: Migration[] = [
  { version: 9, describe: 'each category has a tag color (category_colors), suggested for the categories that have none', up(dataDir, log) {
    const path = join(dataDir, CONFIG_FILE);
    const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
    const categories = (doc.get('categories') as YAML.YAMLSeq | undefined)?.toJSON() as string[] | undefined;
    if (!categories?.length) return;
    const stored = ((doc.get('category_colors') as YAML.YAMLMap | undefined)?.toJSON() ?? {}) as Record<string, string>;
    const added = Object.entries(categoryColors({ categories, category_colors: stored })).filter(([c]) => stored[c] === undefined);
    for (const [c, color] of added) doc.setIn(['category_colors', c], color);
    if (added.length) atomicWrite(path, doc.toString({ lineWidth: 0 }));
    log(`  suggested a color for ${added.length} categor${added.length === 1 ? 'y' : 'ies'}`);
  } },
  { version: 8, describe: 'an item imported from a GitHub issue carries source: {github_issue, closes?}', up() { /* A new item key; nothing to rewrite. Older readers must not drop source, which keeps an issue from being imported twice. */ } },
  { version: 7, describe: 'schedules (schedules/<name>.md) file an item at each cron slot; an item filed by one carries scheduled_from', up() { /* A new file type and item key; nothing to rewrite. Older readers must not drop scheduled_from, which keeps a slot from being filed twice. */ } },
  { version: 6, describe: 'an item can wait on an audition of takes the user picks from (awaiting: audition)', up() { /* A new awaiting value; existing items are unchanged. Older readers must not open an item parked on one. */ } },
  { version: 5, describe: 'decision cards support explicit turn and token budget extensions', up() { /* Additive option fields; existing cards remain valid. Older writers must not drop approved extensions. */ } },
  { version: 4, describe: 'runner sessions carry role and tool contract', up(dataDir, log) {
    const dir = join(dataDir, 'items');
    if (!existsSync(dir)) return;
    let count = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const path = join(dir, file); const text = readFileSync(path, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!match) continue;
      const doc = YAML.parseDocument(match[1]);
      const sessions = doc.get('agent_sessions');
      if (!YAML.isMap(sessions)) continue;
      let changed = false;
      for (const pair of sessions.items) if (YAML.isScalar(pair.value) && typeof pair.value.value === 'string') {
        const runner = String(pair.key);
        pair.value = doc.createNode({ session_id: pair.value.value, role: 'implement', tool_contract: runner === 'codex' ? 'exec-v1' : 'claude-v1', ...(runner === 'codex' ? { transport: 'exec' } : {}) }); changed = true;
      }
      if (changed) { atomicWrite(path, `---\n${doc.toString({ lineWidth: 0 })}---${text.slice(match[0].length)}`); count++; }
    }
    log(`  upgraded ${count} item session record(s)`);
  } },
  { version: 1, describe: 'initial schema', up() { /* baseline: nothing to rewrite */ } },
  {
    version: 2,
    describe: 'concurrency.max_godot_jobs → concurrency.max_local_jobs (the limit was never Godot-specific)',
    up(dataDir, log) {
      const path = join(dataDir, CONFIG_FILE);
      const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
      const old = doc.getIn(['concurrency', 'max_godot_jobs']);
      if (old === undefined) return;
      if (doc.getIn(['concurrency', 'max_local_jobs']) === undefined) doc.setIn(['concurrency', 'max_local_jobs'], old);
      doc.deleteIn(['concurrency', 'max_godot_jobs']);
      atomicWrite(path, doc.toString({ lineWidth: 0 }));
      log(`  concurrency.max_local_jobs: ${String(old)}`);
    },
  },
  {
    version: 3,
    describe: 'orchestrator questions become files (questions/Q-<n>.md) with a state and a discussion',
    up(dataDir, log) { const n = importJournalQuestions(dataDir); log(`  imported ${n.imported} question(s) from the journal${n.settled ? ` (${n.settled} already moot: their items are finished or iceboxed)` : ''}`); },
  },
];

/**
 * Schema 3: every `orchestrator.question` journal line becomes a question file, so the Console
 * lists them with a state instead of forever (#57). The old line had only one text: it is the
 * headline and the summary. The same text asked again about the same item is one question (the
 * orchestrator re-asked what nobody had answered), with each later ask in its thread. A question
 * whose item is already finished or iceboxed is imported resolved, saying so. Files already
 * there are left alone, so running it twice imports nothing twice.
 */
export function importJournalQuestions(dataDir: string): { imported: number; settled: number } {
  const journal = join(dataDir, 'journal');
  const qdir = join(dataDir, 'questions');
  if (!existsSync(journal) || (existsSync(qdir) && readdirSync(qdir).some((f) => f.endsWith('.md')))) return { imported: 0, settled: 0 };
  const entries: { ts: string; item?: string; text: string }[] = [];
  for (const f of readdirSync(journal).filter((f) => f.endsWith('.ndjson')).sort()) {
    for (const line of readFileSync(join(journal, f), 'utf8').split('\n')) {
      if (!line.includes('"orchestrator.question"')) continue;
      try { const e = JSON.parse(line); const text = String(e.data?.question ?? '').trim(); if (e.type === 'orchestrator.question' && text && e.ts) entries.push({ ts: canonicalTimestamp(e.ts), item: typeof e.item === 'string' ? e.item : undefined, text }); } catch { /* a torn line */ }
    }
  }
  const status = (id?: string): string | undefined => {
    if (!id || !existsSync(join(dataDir, 'items', `${id}.md`))) return undefined;
    try { return parseItemFile(readFileSync(join(dataDir, 'items', `${id}.md`), 'utf8')).frontmatter.status; } catch { return undefined; }
  };
  const groups = new Map<string, typeof entries>();
  for (const e of entries) { const k = `${e.item ?? ''}\n${e.text}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
  let n = 0; let settled = 0;
  for (const [first, ...again] of [...groups.values()].sort((a, b) => a[0].ts.localeCompare(b[0].ts))) {
    const id = `Q-${++n}`;
    const itemStatus = status(first.item);
    const item = itemStatus ? first.item : undefined; // an item since deleted is only named in the text
    const moot = itemStatus === 'FINISHED' ? 'finished' : itemStatus === 'ICEBOX' ? 'moved to the icebox' : undefined;
    const last = again.at(-1)?.ts ?? first.ts;
    const now = isoLocal();
    const file: QuestionFile = {
      frontmatter: { schema: 1, id, status: moot ? 'resolved' : 'open', ...(item ? { item } : {}), asked_at: first.ts, updated_at: moot ? now : last, ...(moot ? { resolved_at: now, resolution: `${item} ${moot}` } : {}), headline: first.text.replace(/\s*\n\s*/g, ' ') },
      sections: QUESTION_SECTIONS.map((title) => ({ title, body: '' })),
    };
    setQuestionSection(file, 'Summary', first.text + (first.item && !item ? ` (about ${first.item})` : ''));
    for (const e of again) appendThread(file, 'app', 'the orchestrator asked this again', e.ts);
    appendThread(file, 'app', 'imported from the journal: asked before questions had their own pages, so it has no separate summary or recommendation', now);
    if (moot) { appendThread(file, 'app', `resolved by planestro: ${item} ${moot}`, now); settled++; }
    atomicWrite(join(qdir, `${id}.md`), serializeQuestionFile(file));
  }
  return { imported: n, settled };
}

export function currentVersion(dataDir: string): number {
  const doc = YAML.parse(readFileSync(join(dataDir, CONFIG_FILE), 'utf8'));
  return Number(doc?.schema_version ?? 0);
}

/** Apply every migration above the dir's version, bumping schema_version/tool_version in planestro.yml. */
export async function migrate(dataDir: string, log: (m: string) => void = () => {}): Promise<{ from: number; to: number; applied: number[] }> {
  const from = currentVersion(dataDir);
  if (from > SCHEMA_VERSION) throw new Error(`data dir is schema ${from}; this planestro knows ${SCHEMA_VERSION} — upgrade the tool`);
  const applied: number[] = [];
  for (const m of MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)) {
    log(`migrating ${m.version - 1} → ${m.version}: ${m.describe}`);
    await m.up(dataDir, log);
    stampVersion(dataDir, m.version);
    applied.push(m.version);
  }
  if (!applied.length) stampVersion(dataDir, from);
  // One semantic commit for the whole migration, rather than a `manual: …` at the next start.
  else new GitCommitter(dataDir, { autoCommit: YAML.parse(readFileSync(join(dataDir, CONFIG_FILE), 'utf8'))?.git?.auto_commit !== false, autoPush: false, toolVersion: TOOL_VERSION }).commit(`planestro: migrate schema ${from} → ${applied.at(-1)}`, applied.map((v) => `${v}: ${MIGRATIONS.find((m) => m.version === v)!.describe}`).join('\n'), [CONFIG_FILE, 'questions', 'items'].filter((p) => existsSync(join(dataDir, p))));
  return { from, to: SCHEMA_VERSION, applied };
}

export function stampVersion(dataDir: string, version: number): void {
  const path = join(dataDir, CONFIG_FILE);
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  doc.set('schema_version', version);
  if (doc.get('tool_version') !== TOOL_VERSION) doc.set('tool_version', TOOL_VERSION);
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
}
