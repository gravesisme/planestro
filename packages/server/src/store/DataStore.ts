import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import type YAML from 'yaml';
import {
  parseItemFile, serializeItemFile, setSection, appendActivity, getSection, idNumber, slugify,
  parsePromptFile, serializePromptFile, renderPrompt,
  applyTransition, flavorOf, laneOf, needsYou, baseBranchOf, depsSatisfied,
  rankForTop, rankForBottom, rankBefore, rankAfter, renormalize, sortByRank,
  isoLocal, SCHEMA_VERSION,
  type ItemFile, type ItemFrontmatter, type PromptFile, type Status, type Actor, type Flavor, type Lane,
  type Config, type LocalConfig, type ServerEvent, type ActivityActor,
} from '@planestro/shared';
import { atomicWrite, cleanStaleTemps } from './atomicWrite.ts';
import { Journal } from './Journal.ts';
import { GitCommitter } from './GitCommitter.ts';
import { IdAllocator } from './IdAllocator.ts';
import { matches } from './Search.ts';
import { readConfig, readLocalConfig, patchConfigFile, writeLocalConfig, resolveCodeRepo, resolveWorktreesRoot, schemaStatus, TOOL_VERSION, type SchemaStatus } from '../config.ts';

export interface StoredItem { id: string; path: string; file: ItemFile }
export interface StoredPrompt { name: string; path: string; file: PromptFile }
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
}

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
    const store = new DataStore(dataDir, opts);
    if (opts.lock !== false) store.acquireLock();
    for (const d of ['items', 'prompts']) for (const f of cleanStaleTemps(join(dataDir, d))) opts.log?.('warn', `removed stale temp file ${d}/${f}`);
    store.load();
    await store.commitHandEdits();
    return store;
  }

  get readOnly(): boolean { return this.schema !== 'current'; }
  get itemsDir(): string { return join(this.dataDir, 'items'); }
  get promptsDir(): string { return join(this.dataDir, 'prompts'); }
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
        if (pid && pid !== process.pid) { process.kill(pid, 0); throw new Error(`data dir is in use by planestro pid ${pid} (${lock})`); }
      } catch (e) {
        if (String(e).includes('in use')) throw e; // live process
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
    this.items.clear(); this.prompts.clear(); this.invalid.length = 0;
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
    const edits = dirty.filter((p) => p.startsWith('items/') || p.startsWith('prompts/') || p === 'planestro.yml' || p.startsWith('attachments/'));
    if (!edits.length) return;
    if (this.invalid.length) { this.log('warn', `${edits.length} file(s) changed outside planestro but ${this.invalid.length} file(s) are invalid; leaving the tree uncommitted`); return; }
    this.git.commit(`manual: ${edits.length} file(s) edited outside planestro`, edits.join('\n'));
  }

  // ---- reads ----
  getItem(id: string): StoredItem | undefined { return this.items.get(id); }
  requireItem(id: string): StoredItem { const it = this.items.get(id); if (!it) throw new Error(`unknown item ${id}`); return it; }
  listItems(): StoredItem[] { return sortByRank([...this.items.values()].map((s) => ({ id: s.id, rank: s.file.frontmatter.rank, s }))).map((x) => x.s); }
  laneItems(lane: Lane): StoredItem[] { return this.listItems().filter((s) => laneOf(s.file.frontmatter.status) === lane); }
  search(query: string, filter: { status?: Status; category?: string; lane?: Lane } = {}): StoredItem[] {
    return this.listItems().filter((s) => {
      const fm = s.file.frontmatter;
      if (filter.status && fm.status !== filter.status) return false;
      if (filter.category && fm.category !== filter.category) return false;
      if (filter.lane && laneOf(fm.status) !== filter.lane) return false;
      return matches({ frontmatter: fm, text: s.file.sections.map((x) => x.body).join('\n') }, query);
    });
  }
  maxIdNumber(): number { let max = 0; for (const id of this.items.keys()) max = Math.max(max, idNumber(id)); return max; }

  flavorOf(fm: ItemFrontmatter): Flavor { return flavorOf(fm, this.config.models); }
  defaultBranch(): string { return this.config.code_repo.default_branch; }

  derived(item: StoredItem): Derived {
    const fm = item.file.frontmatter;
    const parent = fm.parent ? this.items.get(fm.parent)?.file.frontmatter : undefined;
    let base_branch: string | undefined; let base_branch_error: string | undefined;
    try { base_branch = baseBranchOf(fm, parent, this.defaultBranch()); } catch (e) { base_branch_error = (e as Error).message; }
    const flavor = this.flavorOf(fm);
    return {
      lane: laneOf(fm.status), needs_you: needsYou(fm), flavor, external: flavor === 'external', base_branch, base_branch_error,
      deps_satisfied: depsSatisfied(fm, (id) => this.items.get(id)?.file.frontmatter),
      children: [...this.items.values()].filter((s) => s.file.frontmatter.parent === fm.id).map((s) => s.id).sort((a, b) => idNumber(a) - idNumber(b)),
    };
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
      category: input.category ?? this.config.defaults.category, status,
      rank: rankForBottom(this.laneItems(lane).map((s) => ({ id: s.id, rank: s.file.frontmatter.rank }))),
      planner: input.planner ?? this.config.defaults.planner, implementer: input.implementer ?? this.config.defaults.implementer,
      depends_on: input.depends_on ?? [], attachments: [], created_at: now, updated_at: now, ...(status === 'ICEBOX' ? { iceboxed_at: now } : {}),
      ...(input.extra ?? {}),
    };
    const file: ItemFile = { frontmatter: fm, sections: [] };
    setSection(file, 'Description', input.description ?? '');
    setSection(file, 'Notes', input.notes ?? '');
    setSection(file, 'Plan', '');
    appendActivity(file, actor === 'engine' ? 'app' : actor, 'created', now);
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
      else if ('activity' in op) appendActivity(file, op.activity.actor, op.activity.text, now);
      else if ('transition' in op) {
        const next = applyTransition(file.frontmatter, op.transition.to, op.transition.actor, this.flavorOf(file.frontmatter), now);
        file.frontmatter = next;
        appendActivity(file, actorToActivity(op.transition.actor), `status ${before} → ${op.transition.to}`, now);
      }
      else if ('rank' in op) file.frontmatter.rank = op.rank;
    }
    file.frontmatter.updated_at = now;
    const stored = this.writeItem(file);
    this.journal.append({ type: 'item.updated', item: id, actor, data: { ops: ops.map(opName), from: before, to: stored.file.frontmatter.status } });
    this.emit({ type: 'item.updated', id, source: 'app' });
    if (options.commit) this.git.commit(options.commit, options.body, [this.rel(stored.path), ...(options.paths ?? [])]);
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

  move(id: string, op: 'top' | 'bottom' | 'before' | 'after' | 'icebox' | 'backlog', refId?: string, actor: Actor = 'user'): StoredItem {
    this.assertWritable();
    const item = this.requireItem(id);
    const fm = item.file.frontmatter;
    if (op === 'icebox') return this.transition(id, 'ICEBOX', actor);
    if (op === 'backlog') return this.transition(id, 'NOT_YET_SUBMITTED', actor);
    const lane = laneOf(fm.status);
    const ranked = this.laneItems(lane).map((s) => ({ id: s.id, rank: s.file.frontmatter.rank }));
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
    atomicWrite(join(this.dataDir, rel), data);
    const entry = { path: rel, kind: 'managed' as const, added_at: isoLocal() };
    this.mutateItem(id, [{ set: { attachments: [...this.requireItem(id).file.frontmatter.attachments, entry] } }, { activity: { actor: actorToActivity(actor), text: `attached ${rel}` } }], actor, { commit: `${id}: attach ${safe}`, paths: [rel] });
    return entry;
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
    if (entry.kind === 'managed' && existsSync(join(this.dataDir, path))) unlinkSync(join(this.dataDir, path));
    this.mutateItem(id, [{ set: { attachments: fm.attachments.filter((a) => a.path !== path) } }], actor, { commit: `${id}: remove attachment ${basename(path)}`, paths: entry.kind === 'managed' ? [path] : [] });
  }

  /** Absolute path for an attachment (managed → inside data dir; reference → as given, or relative to the code repo). */
  attachmentAbsPath(entry: { path: string; kind: string }): string {
    if (entry.kind === 'managed') return join(this.dataDir, entry.path);
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

  /** Render a prompt with the standard context for an item (plus extras). Throws RenderError on gaps. */
  renderPrompt(name: string, item: StoredItem | undefined, extra: Record<string, unknown> = {}): string {
    const p = this.prompts.get(name);
    if (!p) throw new Error(`unknown prompt ${name}`);
    return renderPrompt(p.file.body, this.promptContext(item, extra), (n) => this.prompts.get(n)?.file.body, name);
  }

  promptContext(item: StoredItem | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const repo = { path: this.codeRepoPath(), default_branch: this.defaultBranch(), release_branch: this.config.code_repo.release_branch ?? '(none)', github: this.config.code_repo.github ?? '(none)' };
    const base: Record<string, unknown> = { repo, data_dir: this.dataDir, project: this.config.project };
    if (item) {
      const fm = item.file.frontmatter;
      const d = this.derived(item);
      base.item = {
        id: fm.id, number: idNumber(fm.id), slug: slugify(fm.title), title: fm.title, file: item.path, category: fm.category, status: fm.status,
        description: getSection(item.file, 'Description'), notes: getSection(item.file, 'Notes'), plan: getSection(item.file, 'Plan'),
        branch: fm.branch, worktree: fm.worktree, pr: fm.pr, planner: fm.planner, implementer: fm.implementer,
      };
      base.base_branch = d.base_branch;
      base.worktree = fm.worktree ? (fm.worktree.startsWith('/') ? fm.worktree : join(this.codeRepoPath(), fm.worktree)) : undefined;
      base.attachments = fm.attachments.map((a) => `${this.attachmentAbsPath(a)} (${a.kind})`).join('\n') || '(none)';
      base.attachments_dir = join(this.attachmentsDir, fm.id);
      if (fm.pr) base.pr = { number: fm.pr, url: this.config.code_repo.github ? `https://github.com/${this.config.code_repo.github}/pull/${fm.pr}` : String(fm.pr) };
    }
    return { ...base, ...extra };
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

  stats(): { items: number; prompts: number; invalid: number; attachmentsBytes: number } {
    let attachmentsBytes = 0;
    const walk = (dir: string) => { if (!existsSync(dir)) return; for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) walk(p); else attachmentsBytes += statSync(p).size; } };
    walk(this.attachmentsDir);
    return { items: this.items.size, prompts: this.prompts.size, invalid: this.invalid.length, attachmentsBytes };
  }
}

function actorToActivity(actor: Actor): ActivityActor { return actor === 'engine' ? 'app' : actor; }
function opName(op: ItemOp): string { return Object.keys(op)[0]; }
