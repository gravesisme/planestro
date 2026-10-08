import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import type YAML from 'yaml';
import { planReviewByDefault,
  parseItemFile, serializeItemFile, setSection, appendActivity, getSection, idNumber, slugify,
  parsePromptFile, serializePromptFile, renderPrompt,
  parseReleaseFile, serializeReleaseFile, setReleaseSection, sortReleases, compareVersions, getReleaseSection, VERSION_RE, DATE_RE,
  parseScheduleFile, serializeScheduleFile, setScheduleDescription, scheduleDescription, scheduleContext, withHistory, parseCron, validTimeZone, RenderError, SCHEDULE_NAME_RE, PRIORITIES, KINDS,
  parseQuestionFile, serializeQuestionFile, setQuestionSection, appendThread, questionNumber, QUESTION_SECTIONS,
  applyTransition, flavorOf, laneOf, needsYou, baseBranchOf, depsSatisfied,
  rankForTop, rankForBottom, rankBefore, rankAfter, renormalize, sortByRank, priorityBand,
  isoLocal, SCHEMA_VERSION, chatAttachmentKind, chatAttachmentRefusal, CHAT_ATTACHMENTS_DIR, type ChatAttachment,
  type ItemFile, type ItemFrontmatter, type PromptFile, type ReleaseFile, type ReleaseStatus, type QuestionFile, type QuestionStatus, type ScheduleFile, type ThreadActor, type Status, type Actor, type Flavor, type Lane, type Priority,
  type Config, type LocalConfig, type ServerEvent, type ActivityActor,
} from '@planestro/shared';
import { atomicWrite, cleanStaleTemps } from './atomicWrite.ts';
import { managedAttachmentPath, managedAttachmentParts } from './managedAttachments.ts';
import { assertSafePlanningGit } from './planningGitSafety.ts';
import { DataDirInUseError } from '../exitCodes.ts';
import { Journal } from './Journal.ts';
import { GitCommitter } from './GitCommitter.ts';
import { IdAllocator } from './IdAllocator.ts';
import { matches } from './Search.ts';
import { readConfig, readLocalConfig, patchConfigFile, writeLocalConfig, resolveCodeRepo, resolveWorktreesRoot, schemaStatus, TOOL_VERSION, type SchemaStatus } from '../config.ts';

/**
 * p49: a polling loop wrote the same two app lines ("already on …; waiting for CI outside the merge
 * queue", "same red run … re-observed") every ~40 s for hours, alternating. An app line identical to
 * one of the last ACTIVITY_REPEAT_WINDOW entries says nothing new and is not appended; the journal
 * still records the mutation. People's and the orchestrator's lines are always kept.
 */
const ACTIVITY_REPEAT_WINDOW = 2;
function repeatsRecentAppLine(file: ItemFile, actor: ActivityActor, text: string): boolean {
  if (actor !== 'app') return false;
  const line = `[app] ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
  return getSection(file, 'Activity').split('\n').filter((l) => l.startsWith('- ')).slice(-ACTIVITY_REPEAT_WINDOW).some((l) => l.slice(l.indexOf(' ', 2) + 1) === line);
}

export interface StoredItem { id: string; path: string; file: ItemFile }
export interface StoredPrompt { name: string; path: string; file: PromptFile }
export interface StoredRelease { version: string; path: string; file: ReleaseFile }
export interface StoredQuestion { id: string; path: string; file: QuestionFile }
export interface StoredSchedule { name: string; path: string; file: ScheduleFile }
export interface InvalidFile { path: string; error: string }

export interface Derived { lane: Lane; needs_you: boolean; external: boolean; flavor: Flavor; base_branch?: string; base_branch_error?: string; deps_satisfied: boolean; children: string[] }

export type ItemOp =
  | { set: Partial<ItemFrontmatter> & Record<string, unknown> }
  | { unset: string[] }
  | { section: string; body: string }
  | { activity: { actor: ActivityActor; text: string } }
  | { transition: { to: Status; actor: Actor } }
  | { rank: number };

export interface MutateOptions { commit?: string; body?: string; paths?: string[] }

export interface CreateItemInput {
  title: string; category?: string; description?: string; notes?: string; kind?: 'item' | 'epic'; parent?: string;
  planner?: string; implementer?: string; status?: 'NOT_YET_SUBMITTED' | 'ICEBOX'; depends_on?: string[]; extra?: Record<string, unknown>;
  /** Unset by default (#194). */
  priority?: Priority;
  /** Omitted: the project's `defaults.allow_model_fallback`. */
  allow_model_fallback?: boolean;
  /** The Activity line it starts with; omitted, `created`. */
  created_line?: string;
}

export interface AskInput { headline: string; summary: string; details?: string; recommendation?: string; item?: string }
export interface QuestionEdit { headline?: string; summary?: string; details?: string; recommendation?: string }

/** A finished or iceboxed item's open questions are moot: the state machine knows, so nobody is asked (invariant 4). */
const SETTLES_QUESTIONS: Partial<Record<Status, string>> = { FINISHED: 'finished', ICEBOX: 'moved to the icebox' };

/** What the user sets on a schedule (#247); `null` clears an optional field. */
export interface ScheduleFields { title?: string; description?: string; cron?: string; tz?: string; enabled?: boolean; skip_if_open?: boolean; submit?: boolean; kind?: 'item' | 'epic'; category?: string | null; priority?: Priority | null }
export interface ReleaseFields { version?: string; title?: string | null; status?: ReleaseStatus; date?: string | null; tag?: string | null; items?: string[] }

export interface DataStoreOptions { emit?: (e: ServerEvent) => void; log?: (level: 'info' | 'warn' | 'error', message: string) => void; lock?: boolean }

const REORDER_COMMIT_DELAY_MS = 5 * 60_000;
const EDIT_COMMIT_DELAY_MS = 30_000;

/**
 * The only writer of a planestro data dir while the app runs. Every mutation re-reads
 * the file, applies ops, writes atomically, journals, broadcasts, and commits when the
 * change is semantic. Files are the truth; the in-memory index is a cache.
 */
export class DataStore {
  readonly config: Config;
  readonly local: LocalConfig;
  readonly items = new Map<string, StoredItem>();
  readonly prompts = new Map<string, StoredPrompt>();
  readonly releases = new Map<string, StoredRelease>();
  readonly questions = new Map<string, StoredQuestion>();
  readonly schedules = new Map<string, StoredSchedule>();
  readonly invalid: InvalidFile[] = [];
  readonly journal: Journal;
  readonly git: GitCommitter;
  readonly ids: IdAllocator;
  readonly schema: SchemaStatus;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private locked = false;

  private constructor(readonly dataDir: string, private readonly opts: DataStoreOptions) {
    this.config = readConfig(dataDir);
    this.local = readLocalConfig(dataDir);
    this.schema = schemaStatus(this.config);
    this.journal = new Journal(join(dataDir, 'journal'), (entry) => this.emit({ type: 'journal.appended', entry }));
    this.git = new GitCommitter(dataDir, { autoCommit: this.config.git.auto_commit, autoPush: this.config.git.auto_push, toolVersion: TOOL_VERSION, log: opts.log });
    this.ids = new IdAllocator(dataDir, this.config.project.id_prefix);
  }

  static async open(dataDir: string, opts: DataStoreOptions = {}): Promise<DataStore> {
    assertSafePlanningGit(dataDir);
    const store = new DataStore(dataDir, opts);
    if (opts.lock !== false) store.acquireLock();
    for (const d of ['items', 'prompts', 'releases', 'questions', 'schedules']) for (const f of cleanStaleTemps(join(dataDir, d))) opts.log?.('warn', `removed stale temp file ${d}/${f}`);
    store.load();
    await store.commitHandEdits();
    if (!store.readOnly) store.settleQuestions();
    return store;
  }

  get readOnly(): boolean { return this.schema !== 'current'; }
  get itemsDir(): string { return join(this.dataDir, 'items'); }
  get promptsDir(): string { return join(this.dataDir, 'prompts'); }
  get releasesDir(): string { return join(this.dataDir, 'releases'); }
  get questionsDir(): string { return join(this.dataDir, 'questions'); }
  get schedulesDir(): string { return join(this.dataDir, 'schedules'); }
  get attachmentsDir(): string { return join(this.dataDir, 'attachments'); }
  codeRepoPath(): string { return resolveCodeRepo(this.dataDir, this.config, this.local); }
  worktreesRoot(): string { return resolveWorktreesRoot(this.dataDir, this.config, this.local); }

  private emit(e: ServerEvent): void { this.opts.emit?.(e); }
  private log(level: 'info' | 'warn' | 'error', message: string): void { this.opts.log?.(level, message); }

  // ---- lock ----
  private acquireLock(): void {
    const dir = join(this.dataDir, '.planestro');
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'lock');
    if (existsSync(lock)) {
      try {
        const { pid } = JSON.parse(readFileSync(lock, 'utf8'));
        if (pid && pid !== process.pid) { process.kill(pid, 0); throw new DataDirInUseError(pid, lock); }
      } catch (e) {
        if (e instanceof DataDirInUseError) throw e; // live process; typed so `serve` exits with its own code (#85)
        // ESRCH or unreadable: stale lock
      }
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: isoLocal() }));
    this.locked = true;
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.locked) { try { unlinkSync(join(this.dataDir, '.planestro', 'lock')); } catch { /* ignore */ } this.locked = false; }
  }

  // ---- loading ----
  load(): void {
    this.items.clear(); this.prompts.clear(); this.releases.clear(); this.questions.clear(); this.schedules.clear(); this.invalid.length = 0;
    mkdirSync(this.itemsDir, { recursive: true }); mkdirSync(this.promptsDir, { recursive: true });
    for (const name of readdirSync(this.itemsDir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(this.itemsDir, name);
      try {
        const file = parseItemFile(readFileSync(path, 'utf8'));
        if (`${file.frontmatter.id}.md` !== name) throw new Error(`id ${file.frontmatter.id} does not match file name`);
        if (file.frontmatter.schema > SCHEMA_VERSION) throw new Error(`schema ${file.frontmatter.schema} is newer than this planestro (${SCHEMA_VERSION})`);
        this.items.set(file.frontmatter.id, { id: file.frontmatter.id, path, file });
      } catch (e) { this.invalid.push({ path, error: String((e as Error).message ?? e) }); this.emit({ type: 'invalid_file', path, error: String((e as Error).message ?? e) }); }
    }
    for (const name of readdirSync(this.promptsDir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(this.promptsDir, name);
      try {
        const file = parsePromptFile(readFileSync(path, 'utf8'));
        if (`${file.frontmatter.name}.md` !== name) throw new Error(`prompt name ${file.frontmatter.name} does not match file name`);
        this.prompts.set(file.frontmatter.name, { name: file.frontmatter.name, path, file });
      } catch (e) { this.invalid.push({ path, error: String((e as Error).message ?? e) }); this.emit({ type: 'invalid_file', path, error: String((e as Error).message ?? e) }); }
    }
    // Created on first use: a data dir that has never had a release stays as it was.
    if (existsSync(this.releasesDir)) for (const name of readdirSync(this.releasesDir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(this.releasesDir, name);
      try {
        const file = parseReleaseFile(readFileSync(path, 'utf8'));
        if (`${file.frontmatter.version}.md` !== name) throw new Error(`release version ${file.frontmatter.version} does not match file name`);
        this.releases.set(file.frontmatter.version, { version: file.frontmatter.version, path, file });
      } catch (e) { this.invalid.push({ path, error: String((e as Error).message ?? e) }); this.emit({ type: 'invalid_file', path, error: String((e as Error).message ?? e) }); }
    }
    // Created on first use, like releases.
    if (existsSync(this.questionsDir)) for (const name of readdirSync(this.questionsDir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(this.questionsDir, name);
      try {
        const file = parseQuestionFile(readFileSync(path, 'utf8'));
        if (`${file.frontmatter.id}.md` !== name) throw new Error(`question id ${file.frontmatter.id} does not match file name`);
        this.questions.set(file.frontmatter.id, { id: file.frontmatter.id, path, file });
      } catch (e) { this.invalid.push({ path, error: String((e as Error).message ?? e) }); this.emit({ type: 'invalid_file', path, error: String((e as Error).message ?? e) }); }
    }
    if (existsSync(this.schedulesDir)) for (const name of readdirSync(this.schedulesDir).filter((f) => f.endsWith('.md')).sort()) {
      const path = join(this.schedulesDir, name);
      try {
        const file = parseScheduleFile(readFileSync(path, 'utf8'));
        if (`${file.frontmatter.name}.md` !== name) throw new Error(`schedule name ${file.frontmatter.name} does not match file name`);
        this.schedules.set(file.frontmatter.name, { name: file.frontmatter.name, path, file });
      } catch (e) { this.invalid.push({ path, error: String((e as Error).message ?? e) }); this.emit({ type: 'invalid_file', path, error: String((e as Error).message ?? e) }); }
    }
  }

  /** Re-read everything from disk, config included (hand edits, external tools). */
  reload(): void {
    (this as { config: Config }).config = readConfig(this.dataDir);
    (this as { local: LocalConfig }).local = readLocalConfig(this.dataDir);
    this.load();
    this.emit({ type: 'index.reloaded' });
  }

  /** Files edited while planestro was not running are versioned as-is (only when every dirty file parses). */
  private async commitHandEdits(): Promise<void> {
    const { dirty } = await this.git.status();
    const edits = dirty.filter((p) => p.startsWith('items/') || p.startsWith('prompts/') || p.startsWith('releases/') || p.startsWith('questions/') || p.startsWith('schedules/') || p === 'planestro.yml' || p.startsWith('attachments/'));
    if (!edits.length) return;
    if (this.invalid.length) { this.log('warn', `${edits.length} file(s) changed outside planestro but ${this.invalid.length} file(s) are invalid; leaving the tree uncommitted`); return; }
    this.git.commit(`manual: ${edits.length} file(s) edited outside planestro`, edits.join('\n'));
  }

  // ---- reads ----
  getItem(id: string): StoredItem | undefined { return this.items.get(id); }
  requireItem(id: string): StoredItem { const it = this.items.get(id); if (!it) throw new Error(`unknown item ${id}`); return it; }
  /** Priority first, then rank (#194): the board's columns, the queue's admissions and the orchestrator's lists all read this order. */
  listItems(): StoredItem[] { return sortByRank([...this.items.values()].map((s) => ({ id: s.id, rank: s.file.frontmatter.rank, priority: s.file.frontmatter.priority, s }))).map((x) => x.s); }
  laneItems(lane: Lane): StoredItem[] { return this.listItems().filter((s) => laneOf(s.file.frontmatter.status) === lane); }
  search(query: string, filter: { status?: Status; category?: string; priority?: Priority; lane?: Lane } = {}): StoredItem[] {
    return this.listItems().filter((s) => {
      const fm = s.file.frontmatter;
      if (filter.status && fm.status !== filter.status) return false;
      if (filter.category && fm.category !== filter.category) return false;
      if (filter.priority && fm.priority !== filter.priority) return false;
      if (filter.lane && laneOf(fm.status) !== filter.lane) return false;
      return matches({ frontmatter: fm, text: s.file.sections.map((x) => x.body).join('\n') }, query);
    });
  }
  maxIdNumber(): number { let max = 0; for (const id of this.items.keys()) max = Math.max(max, idNumber(id)); return max; }

  flavorOf(fm: ItemFrontmatter): Flavor { return flavorOf(fm, this.config.models); }
  defaultBranch(): string { return this.config.code_repo.default_branch; }

  /**
   * A base that is the integration branch of an epic that has merged no longer exists (the merge
   * deleted it): what it held is in that epic's own base, so that is the base now (dogfood p45:
   * HH-163 was opened on feature/crystal-cavern, which HH-113's merge into develop deleted, and its
   * PR could not be opened). Followed as far as it goes; a cycle stops where it started.
   */
  private liveBase(base: string): string {
    const seen = new Set<string>();
    for (let b = base; ; ) {
      if (seen.has(b)) return base;
      seen.add(b);
      const epic = [...this.items.values()].find((i) => i.file.frontmatter.kind === 'epic' && i.file.frontmatter.branch === b);
      if (!epic || !['MERGED', 'FINISHED'].includes(epic.file.frontmatter.status)) return b;
      const efm = epic.file.frontmatter;
      const eparent = efm.parent ? this.items.get(efm.parent)?.file.frontmatter : undefined;
      b = baseBranchOf(efm, eparent, this.defaultBranch());
    }
  }

  derived(item: StoredItem): Derived {
    const fm = item.file.frontmatter;
    const parent = fm.parent ? this.items.get(fm.parent)?.file.frontmatter : undefined;
    let base_branch: string | undefined; let base_branch_error: string | undefined;
    try { base_branch = this.liveBase(baseBranchOf(fm, parent, this.defaultBranch())); } catch (e) { base_branch_error = (e as Error).message; }
    const flavor = this.flavorOf(fm);
    return {
      lane: laneOf(fm.status), needs_you: needsYou(fm), flavor, external: flavor === 'external', base_branch, base_branch_error,
      deps_satisfied: depsSatisfied(fm, (id) => this.items.get(id)?.file.frontmatter),
      children: [...this.items.values()].filter((s) => s.file.frontmatter.parent === fm.id).map((s) => s.id).sort((a, b) => idNumber(a) - idNumber(b)),
    };
  }

  /**
   * Items planestro merged into this item's base after its worktree was cut (#217), by merged_at: what a plan
   * awaiting approval was not made against. A worker item planning or with its plan ready only; what merged
   * outside planestro is not seen here (approval's sync takes it in all the same).
   */
  mergedSinceCut(item: StoredItem): string[] {
    const fm = item.file.frontmatter;
    if (!fm.worktree || !fm.started_at || fm.kind === 'epic' || !['PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status)) return [];
    const cut = Date.parse(fm.started_at);
    const moved = [...this.items.values()].filter((i) => i.id !== item.id && i.file.frontmatter.merged_at && Date.parse(i.file.frontmatter.merged_at) > cut);
    if (!moved.length) return [];
    const base = this.derived(item).base_branch;
    return moved.filter((i) => this.derived(i).base_branch === base).map((i) => i.id).sort((a, b) => idNumber(a) - idNumber(b));
  }

  // ---- writes ----
  private assertWritable(): void { if (this.readOnly) throw new Error(`data dir schema is ${this.config.schema_version}; this planestro speaks ${SCHEMA_VERSION} (${this.schema}) — read-only`); }

  private writeItem(file: ItemFile): StoredItem {
    const id = file.frontmatter.id;
    const path = join(this.itemsDir, `${id}.md`);
    atomicWrite(path, serializeItemFile(file));
    const stored = { id, path, file: parseItemFile(readFileSync(path, 'utf8')) };
    this.items.set(id, stored);
    return stored;
  }

  createItem(input: CreateItemInput, actor: Actor = 'user'): StoredItem {
    this.assertWritable();
    if (input.category && !this.config.categories.includes(input.category)) throw new Error(`unknown category ${input.category}`);
    if (input.parent) { const p = this.requireItem(input.parent); if (p.file.frontmatter.kind !== 'epic') throw new Error(`${input.parent} is not an epic`); }
    const now = isoLocal();
    const id = this.ids.allocate(this.maxIdNumber());
    const status = input.status ?? 'NOT_YET_SUBMITTED';
    const lane = laneOf(status);
    const fm: ItemFrontmatter = {
      schema: SCHEMA_VERSION, id, kind: input.kind ?? 'item', parent: input.parent, title: input.title.trim(),
      category: input.category ?? this.config.defaults.category, ...(input.priority ? { priority: input.priority } : {}), status,
      rank: rankForBottom(this.laneItems(lane).map((s) => ({ id: s.id, rank: s.file.frontmatter.rank }))),
      planner: input.planner ?? this.config.defaults.planner, implementer: input.implementer ?? this.config.defaults.implementer,
      ...((input.allow_model_fallback ?? this.config.defaults.allow_model_fallback) ? { allow_model_fallback: true } : {}),
      depends_on: input.depends_on ?? [], attachments: [], created_at: now, updated_at: now, ...(status === 'ICEBOX' ? { iceboxed_at: now } : {}),
      ...(input.extra?.auto_approve_plan === undefined && planReviewByDefault(this.config, input.implementer, input.kind ?? 'item') ? { auto_approve_plan: true } : {}),
      ...(input.extra ?? {}),
    };
    const file: ItemFile = { frontmatter: fm, sections: [] };
    setSection(file, 'Description', input.description ?? '');
    setSection(file, 'Notes', input.notes ?? '');
    setSection(file, 'Plan', '');
    appendActivity(file, actor === 'engine' ? 'app' : actor, input.created_line ?? 'created', now);
    const stored = this.writeItem(file);
    this.journal.append({ type: 'item.created', item: id, actor, data: { title: fm.title, status } });
    this.emit({ type: 'item.created', id });
    this.git.commit(`${id}: create item`, fm.title, [this.rel(stored.path), 'counter']);
    return stored;
  }

  /**
   * Re-read → apply ops → bump updated_at → atomic write → journal → broadcast → optional commit.
   * Ops are applied in order; a failing op aborts the whole mutation (nothing written).
   */
  mutateItem(id: string, ops: ItemOp[], actor: Actor, options: MutateOptions = {}): StoredItem {
    this.assertWritable();
    const current = this.requireItem(id);
    const file = parseItemFile(readFileSync(current.path, 'utf8'));
    const now = isoLocal();
    const before = file.frontmatter.status;
    for (const op of ops) {
      if ('set' in op) Object.assign(file.frontmatter, op.set);
      else if ('unset' in op) for (const k of op.unset) delete (file.frontmatter as Record<string, unknown>)[k];
      else if ('section' in op) setSection(file, op.section, op.body);
      else if ('activity' in op) { if (!repeatsRecentAppLine(file, op.activity.actor, op.activity.text)) appendActivity(file, op.activity.actor, op.activity.text, now); }
      else if ('transition' in op) {
        const next = applyTransition(file.frontmatter, op.transition.to, op.transition.actor, this.flavorOf(file.frontmatter), now);
        file.frontmatter = next;
        appendActivity(file, actorToActivity(op.transition.actor), `status ${before} → ${op.transition.to}`, now);
      }
      else if ('rank' in op) file.frontmatter.rank = op.rank;
    }
    // A hold's reason lasts as long as the hold, whoever lifts it (a release, the orchestrator, an edit): #97.
    if (!file.frontmatter.skip_merge) { delete file.frontmatter.hold_reason; delete file.frontmatter.hold_waits_on; }
    file.frontmatter.updated_at = now;
    const stored = this.writeItem(file);
    this.journal.append({ type: 'item.updated', item: id, actor, data: { ops: ops.map(opName), from: before, to: stored.file.frontmatter.status } });
    this.emit({ type: 'item.updated', id, source: 'app' });
    if (options.commit) this.git.commit(options.commit, options.body, [this.rel(stored.path), ...(options.paths ?? [])]);
    const after = stored.file.frontmatter.status;
    if (after !== before && SETTLES_QUESTIONS[after]) this.settleQuestions(id);
    return stored;
  }

  transition(id: string, to: Status, actor: Actor): StoredItem {
    const item = this.requireItem(id);
    const label = to.toLowerCase().replace(/_/g, ' ');
    return this.mutateItem(id, [{ transition: { to, actor } }], actor, { commit: `${id}: ${label}` });
  }

  /** Debounced user edit of a section or authoritative field: written now, committed after a quiet period. */
  editItem(id: string, ops: ItemOp[], actor: Actor = 'user'): StoredItem {
    const stored = this.mutateItem(id, ops, actor);
    this.scheduleCommit(`edit:${id}`, `${id}: edit`, EDIT_COMMIT_DELAY_MS, [this.rel(stored.path)]);
    return stored;
  }

  move(id: string, how: 'top' | 'bottom' | 'before' | 'after' | 'icebox' | 'backlog', refId?: string, actor: Actor = 'user'): StoredItem {
    this.assertWritable();
    const item = this.requireItem(id);
    const fm = item.file.frontmatter;
    if (how === 'icebox') return this.transition(id, 'ICEBOX', actor);
    if (how === 'backlog') return this.transition(id, 'NOT_YET_SUBMITTED', actor);
    const lane = laneOf(fm.status);
    // A rank orders an item within its priority band (#194). A place beside an item of another band snaps
    // to this band's edge nearest it; changing the band is a priority edit, not a move.
    const band = priorityBand(fm.priority);
    const refBand = (how === 'before' || how === 'after') && refId ? priorityBand(this.requireItem(refId).file.frontmatter.priority) : band;
    const op = refBand < band ? 'top' : refBand > band ? 'bottom' : how;
    const ranked = this.laneItems(lane).filter((s) => priorityBand(s.file.frontmatter.priority) === band).map((s) => ({ id: s.id, rank: s.file.frontmatter.rank }));
    let rank: number | null;
    if (op === 'top') rank = rankForTop(ranked.filter((r) => r.id !== id));
    else if (op === 'bottom') rank = rankForBottom(ranked.filter((r) => r.id !== id));
    else {
      if (!refId) throw new Error('before/after need a reference item');
      rank = op === 'before' ? rankBefore(ranked, refId, id) : rankAfter(ranked, refId, id);
      if (rank === null) {
        const order = sortByRank(ranked.filter((r) => r.id !== id)).map((r) => r.id);
        const at = order.indexOf(refId) + (op === 'after' ? 1 : 0);
        order.splice(at, 0, id);
        for (const [rid, r] of renormalize(order)) if (rid !== id) this.mutateItem(rid, [{ rank: r }], actor);
        rank = renormalize(order).get(id)!;
        this.log('info', `renormalized ${lane} ranks (${order.length} items)`);
      }
    }
    const stored = this.mutateItem(id, [{ rank }], actor);
    this.scheduleCommit(`reorder:${lane}`, `planestro: reorder ${lane}`, REORDER_COMMIT_DELAY_MS, ['items']);
    return stored;
  }

  deleteItem(id: string, actor: Actor = 'user'): void {
    this.assertWritable();
    const item = this.requireItem(id);
    if (this.derived(item).children.length) throw new Error(`${id} has children`);
    unlinkSync(item.path);
    this.items.delete(id);
    this.journal.append({ type: 'item.deleted', item: id, actor });
    this.emit({ type: 'item.deleted', id });
    this.git.commit(`${id}: delete item`, item.file.frontmatter.title, [this.rel(item.path)]);
  }

  /** Flush a pending debounced commit early (e.g. before a semantic commit or shutdown). */
  private scheduleCommit(key: string, message: string, delayMs: number, paths?: string[]): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => { this.timers.delete(key); this.git.commit(message, undefined, paths); }, delayMs);
    t.unref?.();
    this.timers.set(key, t);
  }

  private cancelCommit(key: string): void { const t = this.timers.get(key); if (t) { clearTimeout(t); this.timers.delete(key); } }

  async flushCommits(): Promise<void> {
    const pending = [...this.timers.entries()];
    this.timers.clear();
    for (const [, t] of pending) clearTimeout(t);
    if (pending.length) this.git.checkpoint();
  }

  // ---- attachments ----
  addManagedAttachment(id: string, originalName: string, data: Buffer, actor: Actor = 'user'): { path: string; kind: 'managed' | 'reference' } {
    this.assertWritable();
    this.requireItem(id);
    if (data.length > this.config.attachments.managed_max_bytes) throw new Error(`attachment exceeds managed_max_bytes (${this.config.attachments.managed_max_bytes}); add it as a reference instead`);
    const stamp = isoLocal().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
    const safe = basename(originalName).replace(/[^A-Za-z0-9._-]+/g, '-');
    const rel = `attachments/${id}/${stamp}-${safe}`;
    atomicWrite(managedAttachmentPath(this.dataDir, id, `${stamp}-${safe}`, true), data);
    const entry = { path: rel, kind: 'managed' as const, added_at: isoLocal() };
    this.mutateItem(id, [{ set: { attachments: [...this.requireItem(id).file.frontmatter.attachments, entry] } }, { activity: { actor: actorToActivity(actor), text: `attached ${rel}` } }], actor, { commit: `${id}: attach ${safe}`, paths: [rel] });
    return entry;
  }

  /** What the user sends the orchestrator with a chat message (#288): checked whole before anything is written, then committed once. */
  addChatAttachments(files: { name: string; data: Buffer }[]): ChatAttachment[] {
    this.assertWritable();
    const why = chatAttachmentRefusal(files.map((f) => ({ name: f.name, size: f.data.length })), this.config.attachments.managed_max_bytes);
    if (why) throw new Error(why);
    if (!files.length) return [];
    const stamp = isoLocal().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
    const used = new Set<string>();
    const out = files.map((f) => {
      const safe = basename(f.name).replace(/[^A-Za-z0-9._-]+/g, '-');
      let file = `${stamp}-${safe}`;
      for (let n = 2; used.has(file) || existsSync(join(this.attachmentsDir, CHAT_ATTACHMENTS_DIR, file)); n++) file = `${stamp}-${n}-${safe}`;
      used.add(file);
      atomicWrite(managedAttachmentPath(this.dataDir, CHAT_ATTACHMENTS_DIR, file, true), f.data);
      return { path: `attachments/${CHAT_ATTACHMENTS_DIR}/${file}`, name: f.name, kind: chatAttachmentKind(f.name)!, bytes: f.data.length };
    });
    this.git.commit(`chat: attach ${out.map((a) => basename(a.name).replace(/[^A-Za-z0-9._-]+/g, '-')).join(', ')}`, undefined, out.map((a) => a.path));
    return out;
  }

  /** Absolute path of a chat attachment, inside the data dir only. */
  chatAttachmentAbsPath(path: string): string {
    const parts = managedAttachmentParts(path, CHAT_ATTACHMENTS_DIR);
    return managedAttachmentPath(this.dataDir, parts.id, parts.file);
  }

  addReferenceAttachment(id: string, path: string, actor: Actor = 'user'): { path: string; kind: 'reference' } {
    const entry = { path, kind: 'reference' as const, added_at: isoLocal() };
    this.mutateItem(id, [{ set: { attachments: [...this.requireItem(id).file.frontmatter.attachments, entry] } }, { activity: { actor: actorToActivity(actor), text: `referenced ${path}` } }], actor, { commit: `${id}: reference ${basename(path)}` });
    return entry;
  }

  removeAttachment(id: string, path: string, actor: Actor = 'user'): void {
    const fm = this.requireItem(id).file.frontmatter;
    const entry = fm.attachments.find((a) => a.path === path);
    if (!entry) throw new Error(`no attachment ${path} on ${id}`);
    if (entry.kind === 'managed') {
      const parts = managedAttachmentParts(path, id);
      try { unlinkSync(managedAttachmentPath(this.dataDir, parts.id, parts.file)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    this.mutateItem(id, [{ set: { attachments: fm.attachments.filter((a) => a.path !== path) } }], actor, { commit: `${id}: remove attachment ${basename(path)}`, paths: entry.kind === 'managed' ? [path] : [] });
  }

  /** Absolute path for an attachment (managed → inside data dir; reference → as given, or relative to the code repo). */
  attachmentAbsPath(entry: { path: string; kind: string }): string {
    if (entry.kind === 'managed') {
      const parts = managedAttachmentParts(entry.path);
      this.requireItem(parts.id);
      return managedAttachmentPath(this.dataDir, parts.id, parts.file);
    }
    return entry.path.startsWith('/') ? entry.path : join(this.codeRepoPath(), entry.path);
  }

  // ---- prompts ----
  getPrompt(name: string): StoredPrompt | undefined { return this.prompts.get(name); }
  listPrompts(): StoredPrompt[] { return [...this.prompts.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  promptByRole(role: string): StoredPrompt | undefined { return this.listPrompts().find((p) => p.file.frontmatter.role === role); }

  putPrompt(file: PromptFile, actor: Actor = 'user'): StoredPrompt {
    this.assertWritable();
    const name = file.frontmatter.name;
    const path = join(this.promptsDir, `${name}.md`);
    const isNew = !existsSync(path);
    atomicWrite(path, serializePromptFile(file));
    const stored = { name, path, file: parsePromptFile(readFileSync(path, 'utf8')) };
    this.prompts.set(name, stored);
    this.journal.append({ type: isNew ? 'prompt.created' : 'prompt.updated', actor, data: { name } });
    this.emit({ type: 'prompt.updated', name });
    this.git.commit(`prompts: ${isNew ? 'add' : 'edit'} ${name}`, undefined, [this.rel(path)]);
    return stored;
  }

  /** A new library prompt. Refuses an existing name: `putPrompt` is the edit path. */
  createPrompt(input: { name: string; title: string; kind: PromptFile['frontmatter']['kind']; description?: string; body: string }, actor: Actor = 'user'): StoredPrompt {
    if (this.prompts.has(input.name) || existsSync(join(this.promptsDir, `${input.name}.md`))) throw new Error(`a prompt named ${input.name} already exists`);
    const file = parsePromptFile(serializePromptFile({ frontmatter: { schema: 1, name: input.name, kind: input.kind, title: input.title.trim(), ...(input.description?.trim() ? { description: input.description.trim() } : {}) }, body: input.body }));
    return this.putPrompt(file, actor);
  }

  /** The key is only ever `true` or absent, so unfavorited files stay as they were. */
  setPromptFavorite(name: string, favorite: boolean, actor: Actor = 'user'): StoredPrompt {
    const p = this.prompts.get(name);
    if (!p) throw new Error(`unknown prompt ${name}`);
    if (Boolean(p.file.frontmatter.favorite) === favorite) return p;
    const { favorite: _was, ...rest } = p.file.frontmatter;
    return this.putPrompt({ frontmatter: favorite ? { ...rest, favorite: true } : rest, body: p.file.body }, actor);
  }

  deletePrompt(name: string, actor: Actor = 'user'): void {
    this.assertWritable();
    const p = this.prompts.get(name);
    if (!p) throw new Error(`unknown prompt ${name}`);
    unlinkSync(p.path);
    this.prompts.delete(name);
    this.journal.append({ type: 'prompt.deleted', actor, data: { name } });
    this.emit({ type: 'prompt.updated', name });
    this.git.commit(`prompts: delete ${name}`, undefined, [this.rel(p.path)]);
  }

  // ---- releases ----
  getRelease(version: string): StoredRelease | undefined { return this.releases.get(version); }
  requireRelease(version: string): StoredRelease { const r = this.releases.get(version); if (!r) throw new Error(`unknown release ${version}`); return r; }
  listReleases(): StoredRelease[] { return sortReleases([...this.releases.values()].map((r) => ({ ...r, frontmatter: r.file.frontmatter }))).map(({ frontmatter: _, ...r }) => r); }

  private writeRelease(file: ReleaseFile): StoredRelease {
    const version = file.frontmatter.version;
    const path = join(this.releasesDir, `${version}.md`);
    atomicWrite(path, serializeReleaseFile(file));
    const stored = { version, path, file: parseReleaseFile(readFileSync(path, 'utf8')) };
    this.releases.set(version, stored);
    return stored;
  }

  /**
   * A new release starts with every section the project defines; the ones marked `carry` (store
   * copy) begin as the text of the newest release before it, so only what changed needs writing.
   */
  createRelease(input: { version: string; title?: string; status?: ReleaseStatus; date?: string }, actor: Actor = 'user'): StoredRelease {
    this.assertWritable();
    const version = input.version.trim();
    if (!VERSION_RE.test(version)) throw new Error('version: letters, digits, dots and dashes, starting with a letter or digit');
    if (input.date && !DATE_RE.test(input.date)) throw new Error('date: YYYY-MM-DD');
    if (this.releases.has(version) || existsSync(join(this.releasesDir, `${version}.md`))) throw new Error(`release ${version} already exists`);
    const all = this.listReleases().filter((r) => r.file.frontmatter.status !== 'cancelled');
    const previous = all.find((r) => compareVersions(r.version, version) < 0) ?? all[0];
    const now = isoLocal();
    const file: ReleaseFile = {
      frontmatter: { schema: 1, version, ...(input.title?.trim() ? { title: input.title.trim() } : {}), status: input.status ?? 'planned', ...(input.date ? { date: input.date } : {}), items: [], created_at: now, updated_at: now },
      sections: [],
    };
    const defs = this.config.releases.sections;
    for (const d of defs) setReleaseSection(file, d.title, d.carry && previous ? getReleaseSection(previous.file, d.title) : '', defs);
    const stored = this.writeRelease(file);
    this.journal.append({ type: 'release.created', actor, data: { version, carried_from: previous?.version } });
    this.emit({ type: 'release.updated', version });
    this.git.commit(`releases: add ${version}`, previous ? `Store copy carried from ${previous.version}.` : undefined, [this.rel(stored.path)]);
    return stored;
  }

  /**
   * Status, version and item changes commit at once with a message saying what happened; text
   * edits are written now and committed after a quiet period, like an item's sections.
   */
  editRelease(version: string, change: { fields?: ReleaseFields; sections?: Record<string, string> }, actor: Actor = 'user'): StoredRelease {
    this.assertWritable();
    const current = this.requireRelease(version);
    const file = parseReleaseFile(readFileSync(current.path, 'utf8'));
    const fm = file.frontmatter as ReleaseFile['frontmatter'] & Record<string, unknown>;
    const f = change.fields ?? {};
    const said: string[] = [];
    const next = f.version?.trim() || version;
    if (next !== version) {
      if (!VERSION_RE.test(next)) throw new Error('version: letters, digits, dots and dashes, starting with a letter or digit');
      if (this.releases.has(next) || existsSync(join(this.releasesDir, `${next}.md`))) throw new Error(`release ${next} already exists`);
      fm.version = next; said.push(`rename ${version} → ${next}`);
    }
    for (const k of ['title', 'date', 'tag'] as const) {
      const v = f[k];
      if (v === undefined) continue;
      if (k === 'date' && v && !DATE_RE.test(v)) throw new Error('date: YYYY-MM-DD');
      if (v === null || !v.trim()) delete fm[k]; else fm[k] = v.trim();
    }
    if (f.status && f.status !== fm.status) {
      fm.status = f.status; said.push(f.status);
      // The day it shipped is the one fact everyone asks later. A target still ahead becomes today; a
      // past date stays, so an old release can be recorded after the fact.
      const today = isoLocal().slice(0, 10);
      if (f.status === 'released' && f.date === undefined && (!fm.date || fm.date > today)) fm.date = today;
    }
    if (f.items) {
      for (const id of f.items) this.requireItem(id);
      const items = [...new Set(f.items)];
      const added = items.filter((i) => !fm.items.includes(i)); const removed = fm.items.filter((i) => !items.includes(i));
      if (added.length) said.push(`add ${added.join(', ')}`);
      if (removed.length) said.push(`remove ${removed.join(', ')}`);
      fm.items = items;
    }
    for (const [title, body] of Object.entries(change.sections ?? {})) setReleaseSection(file, title, body, this.config.releases.sections);
    fm.updated_at = isoLocal();
    const stored = this.writeRelease(file);
    if (next !== version) { unlinkSync(current.path); this.releases.delete(version); }
    this.journal.append({ type: 'release.updated', actor, data: { version: next, ...(next !== version ? { was: version } : {}), fields: Object.keys(f), sections: Object.keys(change.sections ?? {}) } });
    this.emit({ type: 'release.updated', version: next });
    if (said.length) {
      this.cancelCommit(`release:${version}`); // the pending text edit rides along in this commit
      this.git.commit(`releases: ${next !== version ? '' : `${next} `}${said.join('; ')}`, undefined, [this.rel(stored.path), ...(next !== version ? [this.rel(current.path)] : [])]);
    } else this.scheduleCommit(`release:${next}`, `releases: edit ${next}`, EDIT_COMMIT_DELAY_MS, [this.rel(stored.path)]);
    return stored;
  }

  deleteRelease(version: string, actor: Actor = 'user'): void {
    this.assertWritable();
    const r = this.requireRelease(version);
    this.cancelCommit(`release:${version}`);
    unlinkSync(r.path);
    this.releases.delete(version);
    this.journal.append({ type: 'release.deleted', actor, data: { version } });
    this.emit({ type: 'release.updated', version });
    this.git.commit(`releases: delete ${version}`, undefined, [this.rel(r.path)]);
  }

  // ---- questions ----
  getQuestion(id: string): StoredQuestion | undefined { return this.questions.get(id); }
  requireQuestion(id: string): StoredQuestion { const q = this.questions.get(id); if (!q) throw new Error(`unknown question ${id}`); return q; }
  /** Newest first. */
  listQuestions(filter: { status?: QuestionStatus; item?: string } = {}): StoredQuestion[] {
    return [...this.questions.values()].filter((q) => (!filter.status || q.file.frontmatter.status === filter.status) && (!filter.item || q.file.frontmatter.item === filter.item))
      .sort((a, b) => questionNumber(b.id) - questionNumber(a.id));
  }

  private writeQuestion(file: QuestionFile): StoredQuestion {
    const id = file.frontmatter.id;
    const path = join(this.questionsDir, `${id}.md`);
    atomicWrite(path, serializeQuestionFile(file));
    const stored = { id, path, file: parseQuestionFile(readFileSync(path, 'utf8')) };
    this.questions.set(id, stored);
    return stored;
  }

  /** Numbers are never reused: planestro never deletes a question, and the highest file name is the counter. */
  private nextQuestionId(): string {
    let max = 0;
    for (const id of this.questions.keys()) max = Math.max(max, questionNumber(id));
    if (existsSync(this.questionsDir)) for (const f of readdirSync(this.questionsDir)) { const m = /^Q-(\d+)\.md$/.exec(f); if (m) max = Math.max(max, Number(m[1])); }
    return `Q-${max + 1}`;
  }

  /** The orchestrator asks: a new open question with its plain-language summary, details and recommendation. */
  askQuestion(input: AskInput, actor: Actor = 'orchestrator'): StoredQuestion {
    this.assertWritable();
    if (input.item) this.requireItem(input.item);
    const now = isoLocal();
    const id = this.nextQuestionId();
    const file: QuestionFile = { frontmatter: { schema: 1, id, status: 'open', ...(input.item ? { item: input.item } : {}), asked_at: now, updated_at: now, headline: oneLine(input.headline) }, sections: QUESTION_SECTIONS.map((title) => ({ title, body: '' })) };
    setQuestionSection(file, 'Summary', input.summary);
    setQuestionSection(file, 'Details', input.details ?? '');
    setQuestionSection(file, 'Recommendation', input.recommendation ?? '');
    const stored = this.writeQuestion(file);
    this.journal.append({ type: 'question.asked', item: input.item, actor, data: { id, headline: file.frontmatter.headline } });
    this.emit({ type: 'question.updated', id });
    this.git.commit(`${id}: ask`, file.frontmatter.headline, [this.rel(stored.path)]);
    return stored;
  }

  /** Re-read → change → bump updated_at → write → journal → broadcast → commit (`Q-7: reply`), as for items. */
  private mutateQuestion(id: string, verb: string, actor: Actor, change: (file: QuestionFile, now: string) => void): StoredQuestion {
    this.assertWritable();
    const current = this.requireQuestion(id);
    const file = parseQuestionFile(readFileSync(current.path, 'utf8'));
    const now = isoLocal();
    change(file, now);
    file.frontmatter.updated_at = now;
    const stored = this.writeQuestion(file);
    this.journal.append({ type: `question.${verb}`, item: file.frontmatter.item, actor, data: { id, status: file.frontmatter.status } });
    this.emit({ type: 'question.updated', id });
    this.git.commit(`${id}: ${verb}`, undefined, [this.rel(stored.path)]);
    return stored;
  }

  /** A message in the question's thread, from the user, the orchestrator, or planestro itself. */
  postToQuestion(id: string, from: ThreadActor, text: string): StoredQuestion {
    if (!text.trim()) throw new Error('an empty message');
    return this.mutateQuestion(id, from === 'user' ? 'message' : from === 'orchestrator' ? 'reply' : 'note', from === 'app' ? 'engine' : from, (f, now) => appendThread(f, from, text, now));
  }

  /** The orchestrator refreshes what it asked (the situation moved on); the thread says what changed. */
  updateQuestion(id: string, edit: QuestionEdit, actor: Actor = 'orchestrator'): StoredQuestion {
    const fields = (['headline', 'summary', 'details', 'recommendation'] as const).filter((k) => edit[k] !== undefined && edit[k]!.trim() !== '');
    if (!fields.length) throw new Error('nothing to update: give a summary, details, recommendation or headline');
    return this.mutateQuestion(id, 'update', actor, (f, now) => {
      if (edit.headline?.trim()) f.frontmatter.headline = oneLine(edit.headline);
      if (edit.summary?.trim()) setQuestionSection(f, 'Summary', edit.summary);
      if (edit.details?.trim()) setQuestionSection(f, 'Details', edit.details);
      if (edit.recommendation?.trim()) setQuestionSection(f, 'Recommendation', edit.recommendation);
      appendThread(f, 'app', `${actor === 'user' ? 'you' : 'the orchestrator'} updated the ${fields.join(', ')}`, now);
    });
  }

  resolveQuestion(id: string, status: 'resolved' | 'withdrawn', resolution: string, actor: Actor = 'user'): StoredQuestion {
    const text = oneLine(resolution) || (status === 'resolved' ? 'answered' : 'withdrawn');
    return this.mutateQuestion(id, status === 'resolved' ? 'resolve' : 'withdraw', actor, (f, now) => {
      f.frontmatter.status = status; f.frontmatter.resolved_at = now; f.frontmatter.resolution = text;
      appendThread(f, 'app', `${status} by ${actor === 'user' ? 'you' : actor === 'engine' ? 'planestro' : 'the orchestrator'}: ${text}`, now);
    });
  }

  reopenQuestion(id: string, actor: Actor = 'user'): StoredQuestion {
    return this.mutateQuestion(id, 'reopen', actor, (f, now) => {
      if (f.frontmatter.status === 'open') throw new Error(`${id} is already open`);
      f.frontmatter.status = 'open'; delete f.frontmatter.resolved_at; delete f.frontmatter.resolution;
      appendThread(f, 'app', `reopened by ${actor === 'user' ? 'you' : 'the orchestrator'}`, now);
    });
  }

  /**
   * Open questions about an item that is finished or iceboxed resolve by themselves (#57: three
   * rescue questions stayed at the top of the Console a day after their items finished). Called
   * on every such transition, and at startup for one made while planestro was not running.
   */
  settleQuestions(item?: string): string[] {
    const settled: string[] = [];
    for (const q of this.listQuestions({ status: 'open', item })) {
      const it = q.file.frontmatter.item ? this.items.get(q.file.frontmatter.item) : undefined;
      const why = it && SETTLES_QUESTIONS[it.file.frontmatter.status];
      if (!it || !why) continue;
      this.resolveQuestion(q.id, 'resolved', `${it.id} ${why}`, 'engine');
      settled.push(q.id);
    }
    return settled;
  }

  /** Render a prompt with the standard context for an item (plus extras). Throws RenderError on gaps. */
  renderPrompt(name: string, item: StoredItem | undefined, extra: Record<string, unknown> = {}): string {
    const body = this.prompts.get(name)?.file.body ?? this.shippedPrompt(name);
    if (body === undefined) throw new Error(`unknown prompt ${name}`);
    return renderPrompt(body, this.promptContext(item, extra), (n) => this.prompts.get(n)?.file.body ?? this.shippedPrompt(n), name);
  }

  /** What the items this one waited on put into the branch, from their `delivered` records: facts from git, not a summary. */
  deliveredText(dependsOn: readonly string[]): string {
    if (!dependsOn.length) return '(this item did not wait on any other item)';
    const size = (f: { bytes?: number; width?: number; height?: number }) => [f.width ? `${f.width}×${f.height}` : '', f.bytes ? (f.bytes > 1e6 ? `${(f.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(f.bytes / 1024))} KB`) : ''].filter(Boolean).join(', ');
    return dependsOn.map((id) => {
      const dep = this.items.get(id)?.file.frontmatter;
      if (!dep) return `- ${id}: unknown item`;
      const files = dep.delivered ?? [];
      const head = `- ${id} — "${dep.title}" (${dep.status === 'MERGED' || dep.status === 'FINISHED' ? 'merged into your base branch' : `NOT merged yet: ${dep.status}`})`;
      if (!files.length) return `${head}\n  - no file list was recorded for it; look at the base branch`;
      return [head, ...files.slice(0, 40).map((f) => `  - ${f.change} \`${f.path}\`${size(f) ? ` (${size(f)})` : ''}`), ...(files.length > 40 ? [`  - …and ${files.length - 40} more`] : [])].join('\n');
    }).join('\n');
  }

  /**
   * A data dir is seeded with the shipped prompts once, at init; a prompt planestro gained later (a
   * new runner's worker rules) is read from the tool itself until the project saves its own copy.
   */
  private shippedPrompt(name: string): string | undefined {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;
    try { return parsePromptFile(readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), 'utf8')).body; } catch { return undefined; }
  }

  /**
   * An item's Notes, and its epic's after them (#128, HH-256): the designer's decisions for a whole epic are written on
   * the epic, and a child planner or worker read only its own item, so a child not started yet never heard them. In
   * `item.notes`, so a data dir's own copy of the prompts carries them too.
   */
  private notesWithEpic(item: StoredItem): string {
    const own = getSection(item.file, 'Notes');
    const epic = item.file.frontmatter.parent ? this.items.get(item.file.frontmatter.parent) : undefined;
    const theirs = epic ? getSection(epic.file, 'Notes').trim() : '';
    if (!theirs) return own;
    return `${own.trim() ? `${own.trim()}\n\n` : ''}From its epic ${epic!.file.frontmatter.id} ("${epic!.file.frontmatter.title}"), which these apply to as well:\n\n${theirs}`;
  }

  promptContext(item: StoredItem | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const repo = { path: this.codeRepoPath(), default_branch: this.defaultBranch(), release_branch: this.config.code_repo.release_branch ?? '(none)', github: this.config.code_repo.github ?? '(none)' };
    const base: Record<string, unknown> = { repo, data_dir: this.dataDir, project: this.config.project };
    if (item) {
      const fm = item.file.frontmatter;
      const d = this.derived(item);
      base.item = {
        id: fm.id, number: idNumber(fm.id), slug: slugify(fm.title), title: fm.title, file: item.path, category: fm.category, status: fm.status,
        description: getSection(item.file, 'Description'), notes: this.notesWithEpic(item), plan: getSection(item.file, 'Plan'),
        branch: fm.branch, worktree: fm.worktree, pr: fm.pr, planner: fm.planner, implementer: fm.implementer,
      };
      base.base_branch = d.base_branch;
      base.worktree = fm.worktree ? (fm.worktree.startsWith('/') ? fm.worktree : join(this.codeRepoPath(), fm.worktree)) : undefined;
      base.attachments = fm.attachments.map((a) => `${this.attachmentAbsPath(a)} (${a.kind})`).join('\n') || '(none)';
      base.attachments_dir = join(this.attachmentsDir, fm.id);
      base.dependencies = { delivered: this.deliveredText(fm.depends_on) };
      if (fm.pr) base.pr = { number: fm.pr, url: this.config.code_repo.github ? `https://github.com/${this.config.code_repo.github}/pull/${fm.pr}` : String(fm.pr) };
    }
    return { ...base, ...extra };
  }

  // ---- schedules ----
  getSchedule(name: string): StoredSchedule | undefined { return this.schedules.get(name); }
  requireSchedule(name: string): StoredSchedule { const s = this.schedules.get(name); if (!s) throw new Error(`unknown schedule ${name}`); return s; }
  listSchedules(): StoredSchedule[] { return [...this.schedules.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  private writeSchedule(file: ScheduleFile): StoredSchedule {
    const path = join(this.schedulesDir, `${file.frontmatter.name}.md`);
    atomicWrite(path, serializeScheduleFile(file));
    const stored = { name: file.frontmatter.name, path, file: parseScheduleFile(readFileSync(path, 'utf8')) };
    this.schedules.set(stored.name, stored);
    return stored;
  }

  /** Everything a schedule's fields must be before it is written, so the engine never meets a template it cannot fill. */
  private checkSchedule(file: ScheduleFile, actor: Actor): void {
    const fm = file.frontmatter;
    if (!SCHEDULE_NAME_RE.test(fm.name)) throw new Error('a schedule name is lowercase letters, digits and dashes');
    parseCron(fm.cron);
    if (!validTimeZone(fm.tz)) throw new Error(`"${fm.tz}" is not a time zone (an IANA name such as Europe/London)`);
    if (fm.category && !this.config.categories.includes(fm.category)) throw new Error(`unknown category ${fm.category}`);
    if (!KINDS.includes(fm.kind) || (fm.priority && !PRIORITIES.includes(fm.priority))) throw new Error('kind is item or epic; priority is high, medium or low');
    // #73: work is submitted on the user's word only, so only the user can make a schedule submit.
    if (fm.submit && (actor !== 'user' || fm.created_by !== 'user')) throw new Error('only a schedule the user made can submit what it files');
    const ctx = scheduleContext(fm, isoLocal());
    try { renderPrompt(fm.title, ctx); renderPrompt(scheduleDescription(file), ctx); } catch (e) {
      if (e instanceof RenderError) throw new Error(`unknown placeholder ${e.missing.join(', ')}: a schedule fills in {{date}}, {{slot}} and {{schedule}}`);
      throw e;
    }
  }

  createSchedule(input: ScheduleFields & { name: string; title: string; cron: string; tz: string }, actor: Actor = 'user'): StoredSchedule {
    this.assertWritable();
    const name = input.name.trim();
    if (this.schedules.has(name) || existsSync(join(this.schedulesDir, `${name}.md`))) throw new Error(`schedule ${name} already exists`);
    const now = isoLocal();
    const file: ScheduleFile = { frontmatter: {
      schema: 1, name, title: input.title.trim(), cron: input.cron.trim(), tz: input.tz.trim(), enabled: input.enabled ?? true, skip_if_open: input.skip_if_open ?? false, submit: input.submit ?? false,
      created_by: actor, kind: input.kind ?? 'item', ...(input.category ? { category: input.category } : {}), ...(input.priority ? { priority: input.priority } : {}),
      created_at: now, updated_at: now, armed_at: now, history: [],
    }, sections: [] };
    setScheduleDescription(file, input.description ?? '');
    this.checkSchedule(file, actor);
    const stored = this.writeSchedule(file);
    this.journal.append({ type: 'schedule.created', actor, data: { name, cron: file.frontmatter.cron, tz: file.frontmatter.tz, submit: file.frontmatter.submit } });
    this.emit({ type: 'schedule.updated', name });
    this.git.commit(`schedules: add ${name}`, `${file.frontmatter.cron} (${file.frontmatter.tz})`, [this.rel(stored.path)]);
    return stored;
  }

  /** A change to when it runs (cron, zone, turning it on) re-arms it from now: a slot it was not running for is never filed late. */
  editSchedule(name: string, fields: ScheduleFields, actor: Actor = 'user'): StoredSchedule {
    this.assertWritable();
    const current = this.requireSchedule(name);
    const file = parseScheduleFile(readFileSync(current.path, 'utf8'));
    const fm = file.frontmatter as ScheduleFile['frontmatter'] & Record<string, unknown>;
    const now = isoLocal();
    const rearm = (fields.cron !== undefined && fields.cron.trim() !== fm.cron) || (fields.tz !== undefined && fields.tz.trim() !== fm.tz) || (fields.enabled === true && !fm.enabled);
    for (const k of ['title', 'cron', 'tz'] as const) if (fields[k] !== undefined) fm[k] = fields[k]!.trim();
    for (const k of ['enabled', 'skip_if_open', 'submit', 'kind'] as const) if (fields[k] !== undefined) fm[k] = fields[k] as never;
    for (const k of ['category', 'priority'] as const) if (fields[k] !== undefined) { if (fields[k] === null || fields[k] === '') delete fm[k]; else fm[k] = fields[k] as never; }
    if (fields.description !== undefined) setScheduleDescription(file, fields.description);
    // Turning submit on is the user's word; one already on is kept by anyone's other edits.
    this.checkSchedule(file, fields.submit && !current.file.frontmatter.submit ? actor : 'user');
    if (rearm) fm.armed_at = now;
    fm.updated_at = now;
    const stored = this.writeSchedule(file);
    this.journal.append({ type: 'schedule.updated', actor, data: { name, fields: Object.keys(fields) } });
    this.emit({ type: 'schedule.updated', name });
    this.git.commit(`schedules: edit ${name}`, Object.keys(fields).join(', '), [this.rel(stored.path)]);
    return stored;
  }

  deleteSchedule(name: string, actor: Actor = 'user'): void {
    this.assertWritable();
    const s = this.requireSchedule(name);
    unlinkSync(s.path);
    this.schedules.delete(name);
    this.journal.append({ type: 'schedule.deleted', actor, data: { name } });
    this.emit({ type: 'schedule.updated', name });
    this.git.commit(`schedules: delete ${name}`, undefined, [this.rel(s.path)]);
  }

  /** The engine handled a slot: it filed an item for it, or skipped it and says why. No slot at or before it is filed again. */
  recordScheduleSlot(name: string, entry: { slot: string; item?: string; skipped?: string }): StoredSchedule {
    this.assertWritable();
    const current = this.requireSchedule(name);
    const file = parseScheduleFile(readFileSync(current.path, 'utf8'));
    const now = isoLocal();
    file.frontmatter.last_slot = entry.slot;
    file.frontmatter.history = withHistory(file.frontmatter.history, { ...entry, at: now });
    file.frontmatter.updated_at = now;
    const stored = this.writeSchedule(file);
    this.journal.append({ type: 'schedule.slot', item: entry.item, actor: 'engine', data: { name, ...entry } });
    this.emit({ type: 'schedule.updated', name });
    this.git.commit(`schedules: ${name} ${entry.item ? `filed ${entry.item}` : 'skipped'} for ${entry.slot}`, entry.skipped, [this.rel(stored.path)]);
    return stored;
  }

  // ---- config ----
  updateConfig(patch: (doc: YAML.Document) => void, message = 'config: update'): Config {
    this.assertWritable();
    const next = patchConfigFile(this.dataDir, patch);
    (this as { config: Config }).config = next;
    this.journal.append({ type: 'config.updated', actor: 'user' });
    this.emit({ type: 'config.updated' });
    this.git.commit(message, undefined, ['planestro.yml']);
    return next;
  }

  updateLocal(patch: Partial<LocalConfig>): LocalConfig {
    const next = { ...this.local, ...patch, engine: { ...this.local.engine, ...(patch.engine ?? {}) } };
    writeLocalConfig(this.dataDir, next);
    (this as { local: LocalConfig }).local = next;
    this.emit({ type: 'config.updated' });
    return next;
  }

  renameCategory(from: string, to: string): number {
    if (!this.config.categories.includes(from)) throw new Error(`unknown category ${from}`);
    const affected = [...this.items.values()].filter((s) => s.file.frontmatter.category === from);
    for (const s of affected) this.mutateItem(s.id, [{ set: { category: to } }], 'user', { commit: `${s.id}: category ${from} → ${to}` });
    this.updateConfig((doc) => {
      const cats = (doc.get('categories') as YAML.YAMLSeq).toJSON() as string[];
      doc.set('categories', cats.map((c) => (c === from ? to : c)));
      if (doc.getIn(['defaults', 'category']) === from) doc.setIn(['defaults', 'category'], to);
    }, `config: rename category ${from} → ${to} (${affected.length} items)`);
    return affected.length;
  }

  removeCategory(name: string, reassignTo: string): number {
    if (name === reassignTo) throw new Error('reassign target must differ');
    if (!this.config.categories.includes(reassignTo)) throw new Error(`unknown category ${reassignTo}`);
    const affected = [...this.items.values()].filter((s) => s.file.frontmatter.category === name);
    for (const s of affected) this.mutateItem(s.id, [{ set: { category: reassignTo } }], 'user', { commit: `${s.id}: category ${name} → ${reassignTo}` });
    this.updateConfig((doc) => {
      const cats = (doc.get('categories') as YAML.YAMLSeq).toJSON() as string[];
      doc.set('categories', cats.filter((c) => c !== name));
      if (doc.getIn(['defaults', 'category']) === name) doc.setIn(['defaults', 'category'], reassignTo);
    }, `config: remove category ${name} (${affected.length} items → ${reassignTo})`);
    return affected.length;
  }

  /** Path relative to the data dir (git pathspec). */
  private rel(abs: string): string { return relative(this.dataDir, abs); }

  stats(): { items: number; prompts: number; releases: number; questions: number; invalid: number; attachmentsBytes: number } {
    let attachmentsBytes = 0;
    const walk = (dir: string) => { if (!existsSync(dir)) return; for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) walk(p); else attachmentsBytes += statSync(p).size; } };
    walk(this.attachmentsDir);
    return { items: this.items.size, prompts: this.prompts.size, releases: this.releases.size, questions: this.questions.size, invalid: this.invalid.length, attachmentsBytes };
  }
}

/** A headline is one line: whatever the model wrote, newlines fold into spaces. */
function oneLine(text: string): string { return text.replace(/\s*\n\s*/g, ' ').trim(); }
function actorToActivity(actor: Actor): ActivityActor { return actor === 'engine' ? 'app' : actor; }
function opName(op: ItemOp): string { return Object.keys(op)[0]; }
