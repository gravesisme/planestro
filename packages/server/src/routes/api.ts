import { parkSummary } from '../engine/parks.ts';
import { suggestForStore } from '../engine/allowSuggest.ts';
import { notesWithLinks, fileNote, markNotes, notesSeen, markNotesSeen } from '../engine/feedback.ts';
import { importIssues, importableIssues } from '../engine/issueImport.ts';
import type { GhPort } from '../engine/ports.ts';
import { previewSwitch, applySwitch, itemModelSwitchOps } from '../providerSwitch.ts';
import { orchestratorSpend } from '../engine/orchestratorSpend.ts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { join } from 'node:path';
import { managedAttachmentPath } from '../store/managedAttachments.ts';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { allowedTransitions, parsePromptFile, RenderError, STATUSES, PRIORITIES, type Priority, PROMPT_KINDS, RELEASE_STATUSES, KINDS, markUnavailable, CHAT_ATTACHMENTS_DIR, CHAT_MAX_FILES, type Status, type Actor, usageReport, dayBefore, USAGE_REPORT_TYPES, itemEfficiency, efficiencyRanking, EFFICIENCY_TYPES, ciAggregates, CI_INSIGHT_TYPES, isoLocal, HEX_COLOR, suggestCategoryColor } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Engine } from '../engine/Engine.ts';
import type { ConsoleBuffer } from '../store/ConsoleBuffer.ts';
import { itemView, promptView, releaseView, scheduleView, questionView, stateView, guardView, modeView, runnerStallsView, publicLocal } from './views.ts';
import { applyConfigSettings, applyLocalSettings, putModel, removeModel, runningKeys } from '../settingsWrite.ts';
import { fromThisMachine } from '../guard.ts';
import { projectsOverview, liveOverviewDeps, type OverviewDeps } from '../projects.ts';
import { importCandidates, importMcpServers, putMcpServer, removeMcpServer, testMcpServer } from '../mcpServers.ts';
import { changeConcurrency, concurrencyView, hostLoad, rollbackConcurrency } from '../concurrency.ts';
import type { HostLoad } from '@planestro/shared';

const EDITABLE_FIELDS = z.object({
  title: z.string().min(1).optional(), category: z.string().min(1).optional(), priority: z.enum(PRIORITIES).nullable().optional(), release: z.string().min(1).nullable().optional(), planner: z.string().optional(), implementer: z.string().optional(),
  auto_approve_plan: z.boolean().optional(), allow_model_fallback: z.boolean().nullable().optional(), depends_on: z.array(z.string()).optional(), parent: z.string().nullable().optional(),
  merge_policy: z.enum(['app', 'watch']).nullable().optional(), base_branch_override: z.string().nullable().optional(),
  branch: z.string().nullable().optional(), pr: z.number().int().positive().nullable().optional(),
  skip_merge: z.boolean().nullable().optional(),
  budget_usd: z.number().positive().nullable().optional(), budget_turns: z.number().int().positive().nullable().optional(), budget_tokens: z.number().int().positive().nullable().optional(), mcp_budget: z.number().int().nonnegative().nullable().optional(),
  loop: z.object({ max_iterations: z.number().int().positive(), goal: z.string().optional() }).nullable().optional(),
  source: z.object({ github_issue: z.number().int().positive(), closes: z.boolean().optional() }).nullable().optional(),
}).strict();

const CHAT_TYPES = new Set(['orchestrator.user_message', 'orchestrator.reply', 'orchestrator.question', 'orchestrator.done']);

/** The orchestrator, when this engine has one (the live engine, in live or dry-run mode; never the mock). */
type Orch = { wake: (ev: { type: string; item?: string; data?: Record<string, unknown> }) => void; enabled: boolean; questionPending?: (id: string) => boolean };
const orchestratorOf = (engine: Engine): Orch | undefined => (engine as Engine & { orchestrator?: Orch }).orchestrator;
/** The engine's gh port (through its orchestrator), for issues (#231); the mock engine has none. */
function ghOf(engine: Engine, what: string): GhPort {
  const gh = (engine as Engine & { orchestrator?: { gh?: GhPort } }).orchestrator?.gh;
  if (!gh) throw Object.assign(new Error(`this engine cannot ${what}`), { status: 400 });
  return gh;
}

/** A file a person reviews by eye or ear, typed by its extension. SVG can carry script: it is served as an image only, never as a document. */
function reviewFile(c: Context, path: string, buf: Buffer | null): Response {
  if (!buf) return c.json({ error: 'not found' }, 404);
  const ext = path.split('.').pop()!.toLowerCase();
  const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', fbx: 'application/octet-stream' } as Record<string, string>)[ext] ?? 'application/octet-stream';
  return new Response(new Uint8Array(buf), { headers: { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } });
}

/** What a multipart form adds around its files (boundaries, headers, a chat message's text). */
const FORM_OVERHEAD_BYTES = 256 * 1024;
const mb = (n: number) => `${Math.round(n / 1e5) / 10} MB`;

/**
 * An upload is bounded before it is read (#336): a body over `maxFiles` files of the store's per-file limit is refused with
 * 413 from its Content-Length, or as soon as a streamed one passes it, so nothing larger is ever held in memory. The limit
 * is read per request, so a changed `attachments.managed_max_bytes` / `image_max_bytes` applies at once.
 */
function uploadLimit(store: DataStore, maxFiles: number): MiddlewareHandler {
  return (c, next) => {
    // A picture may be up to image_max_bytes (#355); the store checks each file against its own type's limit.
    const { managed_max_bytes, image_max_bytes } = store.config.attachments;
    const perFile = Math.max(managed_max_bytes, image_max_bytes);
    const maxSize = perFile * maxFiles + FORM_OVERHEAD_BYTES;
    return bodyLimit({ maxSize, onError: (c) => c.json({ error: `the upload is over the ${mb(maxSize)} limit: at most ${maxFiles} file${maxFiles === 1 ? '' : 's'} of ${mb(perFile)} each (attachments.${perFile === managed_max_bytes ? 'managed_max_bytes' : 'image_max_bytes'})` }, 413) })(c, next);
  };
}
/** More files than a route takes: refused whole, with 413 like an oversized body. */
/** `?limit=` for the journal: 1 to 1000, 200 when absent or not a number (NaN once meant the whole journal, megabytes). */
export function journalLimit(raw: string | undefined): number {
  const n = Math.floor(Number(raw ?? 200));
  return Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 200;
}

class TooManyFiles extends Error {}

export function apiRoutes(store: DataStore, engine: Engine, consoles?: ConsoleBuffer, opts: { projects?: OverviewDeps; hostLoad?: () => HostLoad | undefined } = {}): Hono {
  const api = new Hono();
  /** A change to what runs on this machine, asked from another one: refused before anything is written. */
  const remoteRunRefusal = (c: Context, what: string) => fromThisMachine(c) ? undefined
    : c.json({ error: `${what} can only be changed from this machine itself, not over the network` }, 403);
  const fail = (c: any, e: unknown, status = 400) => c.json({ error: (e as Error).message ?? String(e) }, e instanceof TooManyFiles ? 413 : status);
  const pending = (id: string) => Boolean(orchestratorOf(engine)?.questionPending?.(id));
  const awake = (): Orch => { const o = orchestratorOf(engine); if (!o?.enabled) throw new Error('the orchestrator is not available with this engine'); return o; };

  api.post('/providers/preview', async (c) => { try { return c.json(previewSwitch(store, engine, await c.req.json())); } catch (e) { return fail(c, e); } });
  api.post('/providers/apply', async (c) => { try { return c.json(applySwitch(store, engine, await c.req.json())); } catch (e) { return fail(c, e); } });
  api.post('/providers/:runner/retry', (c) => { try { const runner = z.enum(['claude', 'codex']).parse(c.req.param('runner')); engine.retryProvider?.(runner); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
  api.get('/orchestrator/selection', (c) => c.json((engine as any).orchestrator?.selection ?? { restart_required: false }));
  api.get('/state', async (c) => c.json(stateView(store, engine, await store.git.status({ maxAgeMs: 2000 }))));
  // Every project on this machine (#235), read-only: the others are asked server-side, so the page makes no cross-origin read.
  api.get('/projects', async (c) => c.json(await projectsOverview({ dataDir: store.dataDir, name: store.config.project.name, state: () => stateView(store, engine, null) }, opts.projects ?? liveOverviewDeps())));
  api.post('/reload', async (c) => { store.reload(); return c.json({ ok: true, invalid: store.invalid }); });
  api.post('/reconcile', async (c) => { const e = engine as Engine & { reconcile?: (s: 'manual') => Promise<string[]> }; if (!e.reconcile) return c.json({ corrections: [], note: 'no reconciler with this engine' }); return c.json({ corrections: await e.reconcile('manual') }); });
  api.post('/queue/order', async (c) => { try { const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(await c.req.json()); ids.forEach((id, i) => store.mutateItem(id, [{ set: { merge_order: i + 1 } }], 'user')); store.git.commit('planestro: merge order'); engine.poke(); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.get('/items', (c) => {
    const q = c.req.query('q') ?? '';
    const status = c.req.query('status') as Status | undefined;
    const lane = c.req.query('lane') as 'board' | 'icebox' | 'done' | undefined;
    const category = c.req.query('category') ?? undefined;
    const priority = c.req.query('priority') as Priority | undefined;
    return c.json(store.search(q, { status, lane, category, priority }).map((i) => itemView(store, i)));
  });
  api.post('/items', async (c) => {
    try {
      const body = z.object({
        title: z.string().min(1), category: z.string().optional(), priority: z.enum(PRIORITIES).optional(), release: z.string().min(1).nullable().optional(), description: z.string().optional(), notes: z.string().optional(),
        kind: z.enum(['item', 'epic']).optional(), parent: z.string().optional(), planner: z.string().optional(), implementer: z.string().optional(),
        status: z.enum(['NOT_YET_SUBMITTED', 'ICEBOX']).optional(), depends_on: z.array(z.string()).optional(), auto_approve_plan: z.boolean().optional(),
        allow_model_fallback: z.boolean().optional(),
      }).parse(await c.req.json());
      const { auto_approve_plan, ...input } = body;
      // Said either way: an unticked box is the user's choice, not a gap for defaults.auto_approve_plan to fill.
      return c.json(itemView(store, store.createItem({ ...input, ...(auto_approve_plan !== undefined ? { extra: { auto_approve_plan } } : {}) })), 201);
    } catch (e) { return fail(c, e); }
  });
  api.get('/items/:id', (c) => { const it = store.getItem(c.req.param('id')); return it ? c.json(itemView(store, it)) : c.json({ error: 'not found' }, 404); });
  api.delete('/items/:id', (c) => { try { store.deleteItem(c.req.param('id')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.patch('/items/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const body = z.object({ fields: EDITABLE_FIELDS.optional(), sections: z.object({ Description: z.string().optional(), Notes: z.string().optional(), Plan: z.string().optional() }).optional() }).parse(await c.req.json());
      const ops: ItemOp[] = [];
      if (body.fields) {
        const set: Record<string, unknown> = {}; const unset: string[] = [];
        for (const [k, v] of Object.entries(body.fields)) { if (v === null) unset.push(k); else if (v !== undefined) set[k] = v; }
        if (set.category && !store.config.categories.includes(set.category as string)) throw new Error(`unknown category ${set.category}`);
        if (set.release) store.requireRelease(set.release as string);
        if (set.parent) { const p = store.requireItem(set.parent as string); if (p.file.frontmatter.kind !== 'epic') throw new Error(`${set.parent} is not an epic`); }
        // A pull request attached by hand (finished outside planestro) must enter the merge pipeline
        // like one planestro opened: only ci_result 'pending' gets it picked up (dogfood p44).
        ops.push(...itemModelSwitchOps(store, engine, id, { planner: body.fields.planner, implementer: body.fields.implementer }));
        delete set.planner; delete set.implementer;
        const cur = store.requireItem(id).file.frontmatter;
        if (set.pr !== undefined && cur.status === 'IN_REVIEW' && (cur.ci_result === undefined || cur.ci_result === 'unknown')) set.ci_result = 'pending';
        if (Object.keys(set).length) ops.push({ set });
        if (unset.length) ops.push({ unset });
      }
      for (const [name, text] of Object.entries(body.sections ?? {})) if (text !== undefined) ops.push({ section: name, body: text });
      if (!ops.length) return c.json(itemView(store, store.requireItem(id)));
      const edited = store.editItem(id, ops);
      if (body.fields?.pr !== undefined) engine.poke();
      return c.json(itemView(store, edited));
    } catch (e) { return fail(c, e); }
  });

  api.post('/items/:id/move', async (c) => {
    try {
      const { op, ref } = z.object({ op: z.enum(['top', 'bottom', 'before', 'after', 'icebox', 'backlog']), ref: z.string().optional() }).parse(await c.req.json());
      return c.json(itemView(store, store.move(c.req.param('id'), op, ref)));
    } catch (e) { return fail(c, e); }
  });

  // Cost and tokens by stage, fresh sessions, parks and startup weight, from the journal (#346); an orchestrator wake shares its cost among its items.
  api.get('/items/:id/efficiency', (c) => {
    const types = new Set(EFFICIENCY_TYPES);
    return c.json(itemEfficiency(store.journal.read({ types }), c.req.param('id')));
  });
  api.get('/items/:id/console', (c) => c.json({ lines: consoles?.get(c.req.param('id')) ?? [] }));
  api.get('/items/:id/transitions', (c) => {
    const it = store.requireItem(c.req.param('id'));
    // A childless epic is not offered "start": nothing would ever drive it; "plan the breakdown" is (dogfood p56, LM-2).
    const bare = it.file.frontmatter.kind === 'epic' && it.file.frontmatter.status === 'NOT_YET_SUBMITTED' && !store.derived(it).children.length;   // approving a breakdown is also → IN_PROGRESS, with no children yet
    return c.json(allowedTransitions(it.file.frontmatter.status, 'user', store.flavorOf(it.file.frontmatter)).filter((t) => !(bare && t.to === 'IN_PROGRESS')).map((t) => ({ to: t.to, label: t.label })));
  });
  api.post('/items/:id/reopen-pr', async (c) => { try { const said = await engine.reopenPr(c.req.param('id')); if (/^not (possible|now)/.test(said)) throw new Error(said); return c.json({ said, item: itemView(store, store.requireItem(c.req.param('id'))) }); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/rerun-ci', async (c) => { try { const said = await engine.rerunCi(c.req.param('id'), 'user'); if (/^not (possible|now)/.test(said)) throw new Error(said); return c.json({ said, item: itemView(store, store.requireItem(c.req.param('id'))) }); } catch (e) { return fail(c, e); } });
  api.get('/items/:id/discard', async (c) => { try { return c.json(await engine.discardPreview(c.req.param('id'))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/discard', async (c) => {
    try {
      const { reason, delete_branch, expect_sha } = z.object({ reason: z.string().min(1), delete_branch: z.boolean().optional(), expect_sha: z.string().optional() }).parse(await c.req.json());
      const said = await engine.discard(c.req.param('id'), reason, { deleteBranch: delete_branch === true, ...(expect_sha ? { expectSha: expect_sha } : {}) });
      return c.json({ said, item: itemView(store, store.requireItem(c.req.param('id'))) });
    } catch (e) { return fail(c, e); }
  });
  // Undo last turn (#234): the user's only, never an orchestrator tool. The preview is what it discards; the undo is confirmed against it.
  api.get('/items/:id/undo-turn', async (c) => { try { return c.json(await engine.undoTurnPreview(c.req.param('id'))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/undo-turn', async (c) => {
    try {
      const { expect } = z.object({ expect: z.string().min(1) }).parse(await c.req.json());
      const said = await engine.undoTurn(c.req.param('id'), expect);
      return c.json({ said, item: itemView(store, store.requireItem(c.req.param('id'))) });
    } catch (e) { return fail(c, e); }
  });
  api.post('/items/:id/transition', async (c) => {
    try {
      const id = c.req.param('id');
      const { to, reason } = z.object({ to: z.enum(STATUSES), reason: z.string().optional() }).parse(await c.req.json());
      const it = store.requireItem(id);
      // Closing without a PR goes through the engine: it decides what happens to the worktree and branch.
      if (to === 'PLAN_IN_PROGRESS' && it.file.frontmatter.kind === 'epic') { await engine.planEpic(id); return c.json(itemView(store, store.requireItem(id))); }
      if (to === 'FINISHED') { await engine.closeAsDone(id, reason); return c.json(itemView(store, store.requireItem(id))); }
      // Out of review only by Discard (#135): it closes the pull request and says what became of the branch.
      if (to === 'ICEBOX' && it.file.frontmatter.status === 'IN_REVIEW') throw new Error('use Discard: it closes the pull request and says what becomes of the branch');
      const d = store.derived(it);
      if (to === 'QUEUED' && !d.deps_satisfied) throw new Error('dependencies are not merged yet');
      if (to === 'QUEUED' && d.base_branch_error) throw new Error(d.base_branch_error);
      const e = engine as Engine & { openEpic?: (id: string) => Promise<void> };
      if (to === 'IN_PROGRESS' && it.file.frontmatter.kind === 'epic' && e.openEpic) {
        // Started with no children, an epic opens a branch nothing ever drives: its planner breaks it down instead (dogfood p56, LM-2).
        if (!d.children.length && it.file.frontmatter.status === 'NOT_YET_SUBMITTED') await engine.planEpic(id, 'start: no children yet, so the planner breaks the epic down first');
        else await e.openEpic(id);
        return c.json(itemView(store, store.requireItem(id)));
      }
      let stored = store.transition(id, to, 'user' as Actor);
      // Moved into review by hand with a pull request already attached: it enters the merge pipeline (p44).
      if (to === 'IN_REVIEW' && stored.file.frontmatter.pr && (stored.file.frontmatter.ci_result === undefined || stored.file.frontmatter.ci_result === 'unknown')) stored = store.mutateItem(id, [{ set: { ci_result: 'pending' } }, { activity: { actor: 'app', text: `PR #${stored.file.frontmatter.pr} attached by hand: entering the merge pipeline` } }], 'user');
      // In review by hand, the session's work is over: its live turn and anything queued for it stop (p28).
      if (to === 'IN_REVIEW') { (engine as Engine & { stopForReview?: (id: string) => void }).stopForReview?.(id); stored = store.requireItem(id); }
      if (to === 'QUEUED' || to === 'IN_REVIEW') engine.poke();
      return c.json(itemView(store, stored));
    } catch (e) { return fail(c, e); }
  });
  // as_item: a plan that reads as an epic breakdown is refused unless the user approves it as one item on purpose (#69).
  // hold: the pull request it opens stays out of the merge queue until released, for this reason (#97).
  api.post('/items/:id/plan/review', (c) => { try { const said = engine.reviewPlanAgain(c.req.param('id')); if (/^not possible/.test(said)) throw new Error(said); return c.json({ said, item: itemView(store, store.requireItem(c.req.param('id'))) }); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/plan/approve', async (c) => { try { const { notes, as_item, hold, mcp_budget, sync_first } = z.object({ notes: z.string().optional(), as_item: z.boolean().optional(), hold: z.string().trim().min(1).optional(), mcp_budget: z.number().int().nonnegative().optional(), sync_first: z.boolean().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.approvePlan(c.req.param('id'), notes, 'user', { asItem: as_item === true, hold, ...(mcp_budget !== undefined ? { mcpBudget: mcp_budget } : {}), ...(sync_first !== undefined ? { syncFirst: sync_first } : {}) }); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  // Item ↔ epic while nothing has run for implementation (#69, HH-198).
  api.post('/items/:id/convert', async (c) => { try { const { to, reason } = z.object({ to: z.enum(['item', 'epic']), reason: z.string().optional() }).parse(await c.req.json()); await engine.convertKind(c.req.param('id'), to, 'user', reason); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/epic/plan', async (c) => { try { await engine.planEpic(c.req.param('id')); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  const breakdownChild = z.object({ title: z.string().min(1), description: z.string(), implementer: z.string(), category: z.string().optional(), depends_on: z.array(z.number().int().nonnegative()).optional(), planner: z.string().optional(), hold_for_review: z.boolean().optional() });
  api.post('/items/:id/breakdown/approve', async (c) => {
    try {
      const { children, queue } = z.object({ children: z.array(breakdownChild).optional(), queue: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
      const created = await engine.approveBreakdown(c.req.param('id'), children, { queue });
      return c.json({ created, item: itemView(store, store.requireItem(c.req.param('id'))) });
    } catch (e) { return fail(c, e); }
  });
  // Children rendered from a list and reviewed by the user (#239).
  api.post('/items/:id/children', async (c) => {
    try {
      const { children, queue } = z.object({ children: z.array(breakdownChild), queue: z.boolean().optional() }).parse(await c.req.json());
      const created = await engine.addChildren(c.req.param('id'), children, { queue });
      return c.json({ created, item: itemView(store, store.requireItem(c.req.param('id'))) });
    } catch (e) { return fail(c, e); }
  });
  api.get('/items/:id/images', async (c) => { try { return c.json(await engine.reviewImages(c.req.param('id'))); } catch (e) { return fail(c, e); } });
  api.get('/items/:id/thumb', async (c) => {
    const id = c.req.param('id');
    const first = (await engine.reviewImages(id).catch(() => [])).find((f) => f.change !== 'deleted' && (f.kind ?? 'image') === 'image' && !/\.svg$/i.test(f.path));
    const buf = first ? await engine.reviewImage(id, first.path, 'after').catch(() => null) : null;
    if (!first || !buf) return c.json({ error: 'not found' }, 404);
    const ext = first.path.split('.').pop()!.toLowerCase();
    return new Response(new Uint8Array(buf), { headers: { 'content-type': ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });
  api.get('/items/:id/image', async (c) => {
    const path = c.req.query('path') ?? ''; const side = c.req.query('side') === 'before' ? 'before' : 'after';
    const buf = await engine.reviewImage(c.req.param('id'), path, side).catch(() => null);
    return reviewFile(c, path, buf);
  });
  // A take of the audition the item waits on (#207), which may be in an ignored folder; nothing else in the worktree.
  api.get('/items/:id/audition', async (c) => {
    const path = c.req.query('path') ?? '';
    const buf = engine.auditionFile ? await engine.auditionFile(c.req.param('id'), path).catch(() => null) : null;
    return reviewFile(c, path, buf);
  });
  // One changed file's diff against the base (#233), read from git alone.
  api.get('/items/:id/diff', async (c) => {
    const d = await engine.reviewDiff(c.req.param('id'), c.req.query('path') ?? '').catch(() => null);
    return d ? c.json(d, 200, { 'cache-control': 'no-store' }) : c.json({ error: 'not found' }, 404);
  });
  api.post('/items/:id/review/changes', async (c) => { try { const { note } = z.object({ note: z.string().min(1) }).parse(await c.req.json()); await engine.requestReviewChanges(c.req.param('id'), note); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/hold/release', async (c) => { try { const { note } = z.object({ note: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.releaseHold(c.req.param('id'), note); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/plan/reject', async (c) => { try { const { message } = z.object({ message: z.string().min(1) }).parse(await c.req.json()); await engine.rejectPlan(c.req.param('id'), message); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/message', async (c) => { try { const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json()); await engine.message(c.req.param('id'), text); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/epic/:action', async (c) => {
    try {
      const e = engine as Engine & { openEpic?: (id: string) => Promise<void>; submitEpic?: (id: string) => Promise<void>; syncBase?: (id: string) => Promise<void> };
      const action = c.req.param('action');
      const id = c.req.param('id');
      if (action === 'open' && e.openEpic) {
        if (!store.derived(store.requireItem(id)).children.length) throw new Error(`${id} has no children yet: plan the breakdown, or add children first`);   // dogfood p56, LM-2
        await e.openEpic(id);
      }
      else if (action === 'submit' && e.submitEpic) await e.submitEpic(id);
      else if (action === 'sync' && e.syncBase) await e.syncBase(id);
      else throw new Error(`epic action ${action} is not available`);
      return c.json(itemView(store, store.requireItem(id)));
    } catch (e) { return fail(c, e); }
  });
  api.post('/items/:id/resume-after', async (c) => {
    try {
      const { items, prs, message } = z.object({ items: z.array(z.string()).default([]), prs: z.array(z.number().int().positive()).default([]), message: z.string().min(1) }).parse(await c.req.json());
      const e = engine as Engine & { resumeAfter?: (id: string, items: string[], message: string, by?: 'user', prs?: number[]) => Promise<string> };
      if (!e.resumeAfter) throw new Error('this engine cannot resume items');
      const r = await e.resumeAfter(c.req.param('id'), items, message, 'user', prs);
      if (!r.startsWith('parked')) throw new Error(r);
      return c.json(itemView(store, store.requireItem(c.req.param('id'))));
    } catch (e) { return fail(c, e); }
  });
  api.delete('/items/:id/resume-after', (c) => { try { (engine as Engine & { cancelResumeAfter?: (id: string) => void }).cancelResumeAfter?.(c.req.param('id')); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  // Take over (p28): you finish the item by hand, and nothing automatic drives it until you hand it back.
  api.post('/items/:id/take-over', async (c) => { try { const { note } = z.object({ note: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.takeOver(c.req.param('id'), note); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/hand-back', async (c) => { try { const { note } = z.object({ note: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.handBack(c.req.param('id'), note); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  // Finish from here (f2): committed work that could not reach a pull request on its own goes to one now.
  api.post('/items/:id/finish', async (c) => {
    try {
      const e = engine as Engine & { finishFromWorktree?: (id: string) => Promise<string> };
      if (!e.finishFromWorktree) throw new Error('finishing from a worktree needs the live engine');
      const r = await e.finishFromWorktree(c.req.param('id'));
      if (!r.startsWith('finishing')) throw new Error(r);
      return c.json(itemView(store, store.requireItem(c.req.param('id'))));
    } catch (e) { return fail(c, e); }
  });
  // Sync with base (p29): bring a branch up to date with its base between turns; a conflict goes to the session.
  api.post('/items/:id/sync', async (c) => {
    try {
      const e = engine as Engine & { syncWithBase?: (id: string) => Promise<string> };
      if (!e.syncWithBase) throw new Error('syncing a branch needs the live engine');
      const r = await e.syncWithBase(c.req.param('id'));
      if (/^(not now|not possible|refused|nothing to)/.test(r)) throw new Error(r);
      return c.json({ ...itemView(store, store.requireItem(c.req.param('id'))), result: r });
    } catch (e) { return fail(c, e); }
  });
  api.post('/items/:id/unblock', async (c) => { try { const { message, fresh } = z.object({ message: z.string().optional(), fresh: z.boolean().optional() }).parse(await c.req.json().catch(() => ({}))); const e = engine as Engine & { unblock?: (id: string, m?: string, by?: 'user', o?: { fresh?: boolean }) => Promise<void> }; if (e.unblock) await e.unblock(c.req.param('id'), message, 'user', { fresh }); else store.mutateItem(c.req.param('id'), [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }], 'user', { commit: `${c.req.param('id')}: unblock` }); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  // The answer to an orchestrator's decision card: an option's label, your own words, or both.
  api.post('/items/:id/decision', async (c) => {
    try {
      const body = z.object({ choice: z.string().optional(), text: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
      const e = engine as Engine & { answerDecision?: (id: string, a: { choice?: string; text?: string }) => Promise<void> };
      if (!e.answerDecision) throw new Error('decisions need the live engine');
      await e.answerDecision(c.req.param('id'), body);
      return c.json(itemView(store, store.requireItem(c.req.param('id'))));
    } catch (e) { return fail(c, e); }
  });
  // Each kind's fields checked here: they are written into the item and put in the session's next message.
  const Respond = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('question'), answers: z.record(z.string(), z.string().max(20_000)) }).passthrough(),
    z.object({ kind: z.literal('permission'), decision: z.enum(['allow', 'always', 'deny']), reason: z.string().max(4_000).optional() }).passthrough(),
    z.object({ kind: z.literal('audition') }).passthrough(),
  ]);
  api.post('/items/:id/respond', async (c) => { try { await engine.respond(c.req.param('id'), Respond.parse(await c.req.json())); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.post('/items/:id/attachments', uploadLimit(store, 1), async (c) => {
    try {
      const id = c.req.param('id');
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('multipart/form-data')) {
        const form = await c.req.formData();
        if (form.getAll('file').length > 1) throw new TooManyFiles('one file per upload');
        const f = form.get('file');
        if (!(f instanceof File)) throw new Error('file field missing');
        return c.json(store.addManagedAttachment(id, f.name || 'paste.png', Buffer.from(await f.arrayBuffer())), 201);
      }
      const { path } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
      return c.json(store.addReferenceAttachment(id, path), 201);
    } catch (e) { return fail(c, e); }
  });
  api.delete('/items/:id/attachments', (c) => { try { store.removeAttachment(c.req.param('id'), c.req.query('path') ?? ''); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.get('/prompts', (c) => c.json(store.listPrompts().map(promptView)));
  api.get('/prompts/:name', (c) => { const p = store.getPrompt(c.req.param('name')); return p ? c.json(promptView(p)) : c.json({ error: 'not found' }, 404); });
  api.post('/prompts', async (c) => {
    try {
      const input = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'name: lowercase letters, digits and dashes'), title: z.string().min(1), kind: z.enum(PROMPT_KINDS).default('template'), description: z.string().optional(), body: z.string().default('') }).parse(await c.req.json());
      return c.json(promptView(store.createPrompt(input)), 201);
    } catch (e) { return fail(c, e); }
  });
  api.post('/prompts/:name/favorite', async (c) => {
    try {
      const { favorite } = z.object({ favorite: z.boolean() }).parse(await c.req.json());
      return c.json(promptView(store.setPromptFavorite(c.req.param('name'), favorite)));
    } catch (e) { return fail(c, e); }
  });
  api.put('/prompts/:name', async (c) => {
    try {
      const { text } = z.object({ text: z.string() }).parse(await c.req.json());
      const file = parsePromptFile(text);
      if (file.frontmatter.name !== c.req.param('name')) throw new Error('name in frontmatter must match the URL');
      return c.json(promptView(store.putPrompt(file)));
    } catch (e) { return fail(c, e); }
  });
  api.delete('/prompts/:name', (c) => { try { store.deletePrompt(c.req.param('name')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
  api.post('/prompts/:name/render', async (c) => {
    try {
      const { itemId, extra } = z.object({ itemId: z.string().optional(), extra: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json().catch(() => ({})));
      const item = itemId ? store.requireItem(itemId) : undefined;
      try { return c.json({ text: store.renderPrompt(c.req.param('name'), item, extra) }); }
      catch (e) { if (e instanceof RenderError) return c.json({ error: e.message, missing: e.missing }, 422); throw e; }
    } catch (e) { return fail(c, e); }
  });

  api.get('/releases', (c) => c.json(store.listReleases().map((r) => releaseView(store, r))));
  api.get('/releases/:version', (c) => { const r = store.getRelease(c.req.param('version')); return r ? c.json(releaseView(store, r)) : c.json({ error: 'not found' }, 404); });
  api.post('/releases', async (c) => {
    try {
      const input = z.object({ version: z.string().min(1), title: z.string().optional(), status: z.enum(RELEASE_STATUSES).optional(), date: z.string().optional() }).parse(await c.req.json());
      return c.json(releaseView(store, store.createRelease(input)), 201);
    } catch (e) { return fail(c, e); }
  });
  api.patch('/releases/:version', async (c) => {
    try {
      const body = z.object({
        fields: z.object({ version: z.string().min(1), title: z.string().nullable(), status: z.enum(RELEASE_STATUSES), date: z.string().nullable(), tag: z.string().nullable(), items: z.array(z.string()) }).partial().strict().optional(),
        sections: z.record(z.string().min(1), z.string()).optional(),
      }).parse(await c.req.json());
      return c.json(releaseView(store, store.editRelease(c.req.param('version'), body)));
    } catch (e) { return fail(c, e); }
  });
  // Renaming, cancelling or deleting a release offers to move or clear the items planned for it (#375); this applies the answer.
  api.post('/releases/:version/retarget', async (c) => {
    try {
      const { to } = z.object({ to: z.string().min(1).nullable() }).parse(await c.req.json());
      return c.json({ items: store.retargetItems(c.req.param('version'), to) });
    } catch (e) { return fail(c, e); }
  });
  api.delete('/releases/:version', (c) => { try { store.deleteRelease(c.req.param('version')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  // Schedules (#247): made and changed by the user here, which is what lets one submit what it files (#73).
  const scheduleFields = z.object({ title: z.string().min(1), description: z.string(), cron: z.string().min(1), tz: z.string().min(1), enabled: z.boolean(), skip_if_open: z.boolean(), submit: z.boolean(), kind: z.enum(KINDS), category: z.string().nullable(), priority: z.enum(PRIORITIES).nullable() }).partial().strict();
  api.get('/schedules', (c) => c.json(store.listSchedules().map((s) => scheduleView(s))));
  api.post('/schedules', async (c) => {
    try {
      const input = scheduleFields.extend({ name: z.string().min(1), title: z.string().min(1), cron: z.string().min(1), tz: z.string().min(1) }).parse(await c.req.json());
      const s = store.createSchedule({ ...input, category: input.category ?? undefined, priority: input.priority ?? undefined }, 'user');
      engine.poke();
      return c.json(scheduleView(s), 201);
    } catch (e) { return fail(c, e); }
  });
  api.patch('/schedules/:name', async (c) => { try { const s = store.editSchedule(c.req.param('name'), scheduleFields.parse(await c.req.json()), 'user'); engine.poke(); return c.json(scheduleView(s)); } catch (e) { return fail(c, e); } });
  api.delete('/schedules/:name', (c) => { try { store.deleteSchedule(c.req.param('name')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.get('/config', (c) => c.json({ config: store.config, local: publicLocal(store.local), configText: readFileSync(join(store.dataDir, 'planestro.yml'), 'utf8') }));
  // Settings writes: only keys the shared registry marks editable, validated through the schema (settingsWrite.ts).
  api.put('/config', async (c) => {
    try {
      const body = await c.req.json();
      const runs = runningKeys('config', body);
      return (runs.length && remoteRunRefusal(c, runs.join(', '))) || c.json({ config: applyConfigSettings(store, body) });
    } catch (e) { return fail(c, e); }
  });
  // The concurrency control (#330): the same write path, journaled with who and why; a raise above the recommendation needs `confirm`.
  const host = () => (opts.hostLoad ?? hostLoad)();
  const concurrencyFail = (c: Context, e: unknown) => {
    const err = e as Error & { status?: number; needs_confirm?: boolean; issues?: { path: PropertyKey[]; message: string }[] };
    const error = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') : err.message;
    return c.json({ error, ...(err.needs_confirm ? { needs_confirm: true } : {}) }, err.status === 409 ? 409 : 400);
  };
  api.get('/concurrency', async (c) => c.json(await concurrencyView(store, engine, host())));
  api.put('/concurrency', async (c) => { try { const h = host(); changeConcurrency(store, await c.req.json(), 'user', { host: h }); engine.poke(); return c.json(await concurrencyView(store, engine, h)); } catch (e) { return concurrencyFail(c, e); } });
  api.post('/concurrency/rollback', async (c) => { try { const h = host(); rollbackConcurrency(store, await c.req.json().catch(() => ({})), 'user', { host: h }); engine.poke(); return c.json(await concurrencyView(store, engine, h)); } catch (e) { return concurrencyFail(c, e); } });
  api.put('/config/models/:id', async (c) => { try { const config = putModel(store, c.req.param('id'), await c.req.json()); engine.poke(); return c.json({ config }); } catch (e) { return fail(c, e); } });
  api.delete('/config/models/:id', (c) => { try { return c.json({ config: removeModel(store, c.req.param('id')) }); } catch (e) { return fail(c, e); } });
  // Settings → Notifications → Test: the saved command, run the way its event runs it (dry-run only logs it).
  api.post('/config/notifications/test', async (c) => {
    const refused = remoteRunRefusal(c, 'running a notification command'); if (refused) return refused;
    try {
      const { event } = z.object({ event: z.enum(['on_merge', 'on_usage_pause', 'on_needs_you']) }).parse(await c.req.json());
      if (!engine.testNotification) throw new Error('no engine is running to run it');
      return c.json(await engine.testNotification(event));
    } catch (e) { return fail(c, e); }
  });
  // A model this machine's account cannot use: marked by hand (you know it is out until a reset) or cleared.
  api.put('/models/:id/unavailable', async (c) => {
    try {
      const id = c.req.param('id');
      if (!store.config.models.some((m) => m.id === id)) throw new Error(`unknown model ${id}`);
      const { until, reason } = z.object({ until: z.string().refine((v) => Number.isFinite(Date.parse(v)), 'until: an ISO date-time'), reason: z.string().optional() }).parse(await c.req.json());
      const now = new Date(Date.now());
      if (Date.parse(until) <= now.getTime()) throw new Error('until must be in the future');
      store.updateLocal({ model_unavailable: markUnavailable(store.local.model_unavailable, id, { until: new Date(until), reason: reason?.trim() || 'marked unavailable in Settings', manual: true }, now) });
      store.journal.append({ type: 'model.unavailable', actor: 'user', data: { model: id, until, reason: reason ?? '' } });
      engine.poke();
      return c.json({ local: publicLocal(store.local) });
    } catch (e) { return fail(c, e); }
  });
  api.delete('/models/:id/unavailable', (c) => {
    const id = c.req.param('id');
    const { [id]: _gone, ...rest } = store.local.model_unavailable ?? {};
    store.updateLocal({ model_unavailable: rest });
    store.journal.append({ type: 'model.available', actor: 'user', data: { model: id } });
    engine.poke();
    return c.json({ local: publicLocal(store.local) });
  });
  api.put('/config/local', async (c) => {
    try {
      const body = await c.req.json();
      const runs = runningKeys('local', body);
      return (runs.length && remoteRunRefusal(c, runs.join(', '))) || c.json({ local: publicLocal(applyLocalSettings(store, body)) });
    } catch (e) { return fail(c, e); }
  });
  // Settings → MCP servers (#237): machine-local, keys write-only (mcpServers.ts).
  api.get('/config/mcp-servers/import', (c) => { try { return c.json({ candidates: importCandidates(store) }); } catch (e) { return fail(c, e); } });
  api.post('/config/mcp-servers/import', async (c) => { const refused = remoteRunRefusal(c, 'MCP servers'); if (refused) return refused; try { const { local, added } = importMcpServers(store, await c.req.json().catch(() => ({}))); return c.json({ local: publicLocal(local), added }); } catch (e) { return fail(c, e); } });
  api.put('/config/mcp-servers/:name', async (c) => { const refused = remoteRunRefusal(c, 'MCP servers'); if (refused) return refused; try { return c.json({ local: publicLocal(putMcpServer(store, c.req.param('name'), await c.req.json())) }); } catch (e) { return fail(c, e); } });
  api.delete('/config/mcp-servers/:name', (c) => { try { return c.json({ local: publicLocal(removeMcpServer(store, c.req.param('name'))) }); } catch (e) { return fail(c, e); } });
  api.post('/config/mcp-servers/:name/test', async (c) => {
    const refused = remoteRunRefusal(c, 'testing an MCP server'); if (refused) return refused;
    const spec = store.local.mcp_servers[c.req.param('name')];
    if (!spec) return fail(c, new Error(`no MCP server ${c.req.param('name')} on this machine`));
    return c.json(await testMcpServer(spec));
  });
  api.post('/config/categories', async (c) => {
    try {
      const body = z.discriminatedUnion('op', [
        z.object({ op: z.literal('add'), name: z.string().min(1), color: z.string().regex(HEX_COLOR, 'a #rrggbb color').optional() }),
        z.object({ op: z.literal('rename'), from: z.string().min(1), to: z.string().min(1) }),
        z.object({ op: z.literal('remove'), name: z.string().min(1), reassign_to: z.string().min(1) }),
        z.object({ op: z.literal('default'), name: z.string().min(1) }),
        z.object({ op: z.literal('color'), name: z.string().min(1), color: z.string().regex(HEX_COLOR, 'a #rrggbb color') }),
      ]).parse(await c.req.json());
      let affected = 0;
      if (body.op === 'add') store.updateConfig((doc) => {
        const cats = (doc.get('categories') as YAML.YAMLSeq).toJSON() as string[];
        if (cats.includes(body.name)) return;
        doc.set('categories', [...cats, body.name]);
        doc.setIn(['category_colors', body.name], (body.color ?? suggestCategoryColor(body.name, Object.values(store.config.category_colors))).toLowerCase());
      }, `config: add category ${body.name}`);
      else if (body.op === 'color') {
        if (!store.config.categories.includes(body.name)) throw new Error(`unknown category ${body.name}`);
        store.updateConfig((doc) => { doc.setIn(['category_colors', body.name], body.color.toLowerCase()); }, `config: category ${body.name} color ${body.color.toLowerCase()}`);
      }
      else if (body.op === 'rename') affected = store.renameCategory(body.from, body.to);
      else if (body.op === 'remove') affected = store.removeCategory(body.name, body.reassign_to);
      else store.updateConfig((doc) => { doc.setIn(['defaults', 'category'], body.name); }, `config: default category ${body.name}`);
      return c.json({ config: store.config, affected });
    } catch (e) { return fail(c, e); }
  });

  api.post('/orchestrator/message', uploadLimit(store, CHAT_MAX_FILES), async (c) => {
    try {
      // JSON, or a form with `file` parts (#288): what the user pasted or picked, stored and committed before the message is.
      const files: { name: string; data: Buffer }[] = [];
      let body: unknown;
      if ((c.req.header('content-type') ?? '').includes('multipart/form-data')) {
        const form = await c.req.formData();
        if (form.getAll('file').length > CHAT_MAX_FILES) throw new TooManyFiles(`at most ${CHAT_MAX_FILES} attachments in one message`);
        for (const f of form.getAll('file')) if (f instanceof File) files.push({ name: f.name || 'paste.png', data: Buffer.from(await f.arrayBuffer()) });
        body = { text: String(form.get('text') ?? '').replace(/\r\n/g, '\n'), item: form.get('item') || undefined }; // a form sends its line breaks as CRLF
      } else body = await c.req.json();
      const { text, item } = z.object({ text: z.string(), item: z.string().optional() }).parse(body);
      if (!text.trim() && !files.length) throw new Error('nothing to send');
      const e = engine as Engine & { orchestrator?: { wake: (ev: { type: string; item?: string; data?: Record<string, unknown> }) => void; enabled: boolean } };
      if (!e.orchestrator?.enabled) throw new Error('the orchestrator is not available with this engine');
      const attachments = store.addChatAttachments(files);
      store.journal.append({ type: 'orchestrator.user_message', item, actor: 'user', data: { text, ...(attachments.length ? { attachments } : {}) } });
      e.orchestrator.wake({ type: 'user_message', item, data: { message: text, ...(attachments.length ? { attachments } : {}) } });
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  // The chat: what the user said, what the orchestrator answered or asked, and how each wake about a message ended.
  api.get('/orchestrator/chat', (c) => {
    const e = engine as Engine & { orchestrator?: { enabled: boolean } };
    const entries = store.journal.read({ types: CHAT_TYPES }).filter((j) => (j.type !== 'orchestrator.done' || ((j.data?.events as string[] | undefined) ?? []).includes('user_message'))).slice(-100);
    return c.json({ enabled: Boolean(e.orchestrator?.enabled), entries });
  });
  api.get('/orchestrator/questions', (c) => c.json(store.journal.read({ type: 'orchestrator.question', limit: 20 })));
  // Questions (#75): files with a state and a thread. Posting in a thread wakes the orchestrator
  // with the whole question; "Still relevant?" wakes it to withdraw, refresh, or leave it as it is.
  api.get('/questions', (c) => { const status = c.req.query('status'); return c.json(store.listQuestions(status === 'open' || status === 'resolved' || status === 'withdrawn' ? { status } : {}).map((q) => questionView(store, q, pending(q.id), false))); });
  api.get('/questions/:id', (c) => { const q = store.getQuestion(c.req.param('id')); return q ? c.json(questionView(store, q, pending(q.id))) : c.json({ error: 'not found' }, 404); });
  api.post('/questions/review-all', (c) => {
    try {
      const o = awake();
      const open = store.listQuestions({ status: 'open' });
      // Oldest first: the stalest are the likeliest to be moot. They coalesce into one wake.
      for (const q of [...open].reverse()) o.wake({ type: 'question_review', data: { question: q.id } });
      return c.json({ reviewing: open.map((q) => q.id) });
    } catch (e) { return fail(c, e); }
  });
  api.post('/questions/:id/messages', async (c) => {
    try {
      const id = c.req.param('id');
      const { text } = z.object({ text: z.string().trim().min(1) }).parse(await c.req.json());
      store.requireQuestion(id);
      const o = awake();
      const q = store.postToQuestion(id, 'user', text);
      o.wake({ type: 'question_message', data: { question: id, message: text } });
      return c.json(questionView(store, q, pending(id)));
    } catch (e) { return fail(c, e); }
  });
  api.post('/questions/:id/review', (c) => {
    try {
      const q = store.requireQuestion(c.req.param('id'));
      if (q.file.frontmatter.status !== 'open') throw new Error(`${q.id} is ${q.file.frontmatter.status}: reopen it first`);
      awake().wake({ type: 'question_review', data: { question: q.id } });
      return c.json(questionView(store, q, pending(q.id)));
    } catch (e) { return fail(c, e); }
  });
  api.post('/questions/:id/resolve', async (c) => {
    try {
      const { status, resolution } = z.object({ status: z.enum(['resolved', 'withdrawn']).default('resolved'), resolution: z.string().optional() }).parse(await c.req.json().catch(() => ({})));
      const cur = store.requireQuestion(c.req.param('id'));
      if (cur.file.frontmatter.status !== 'open') throw new Error(`${cur.id} is already ${cur.file.frontmatter.status}`);
      const q = store.resolveQuestion(cur.id, status, resolution?.trim() || (status === 'resolved' ? 'marked answered' : 'dismissed'), 'user');
      return c.json(questionView(store, q, pending(q.id)));
    } catch (e) { return fail(c, e); }
  });
  api.post('/questions/:id/reopen', (c) => { try { const q = store.reopenQuestion(c.req.param('id'), 'user'); return c.json(questionView(store, q, pending(q.id))); } catch (e) { return fail(c, e); } });
  // What waiting on a person cost, per item (#108): parks, time waited, what their resumes cost, the commands that park most.
  // The orchestrator's cost per wake, today and in its current conversation (#49).
  api.get('/orchestrator/spend', (c) => c.json(orchestratorSpend(store.journal.read({ type: 'orchestrator.done' }))));
  // Usage per day by provider, model and role, with the guards' crossings and pauses (#236): read from the usage.turn entries turns journal as they end.
  api.get('/usage', (c) => {
    const days = Math.min(366, Math.max(1, Math.floor(Number(c.req.query('days') ?? 30)) || 30));
    const today = isoLocal().slice(0, 10);
    const types = new Set(USAGE_REPORT_TYPES);
    return c.json(usageReport(store.journal.read({ since: dayBefore(today, days - 1), types }), { days, today }));
  });
  // The last days' items ranked by cost, by stage and by starting context (#346).
  api.get('/usage/items', (c) => {
    const days = Math.min(90, Math.max(1, Math.floor(Number(c.req.query('days') ?? 7)) || 7));
    const today = isoLocal().slice(0, 10);
    const types = new Set(EFFICIENCY_TYPES);
    return c.json(efficiencyRanking(store.journal.read({ since: dayBefore(today, days - 1), types }), { days, today }));
  });
  // CI over the last days (#182): waits and re-runs per day, p50/p90 queue and run time, from what each CI wait recorded (#179).
  api.get('/usage/ci', (c) => {
    const days = Math.min(90, Math.max(1, Math.floor(Number(c.req.query('days') ?? 7)) || 7));
    const today = isoLocal().slice(0, 10);
    const types = new Set<string>(CI_INSIGHT_TYPES);
    return c.json(ciAggregates(store.journal.read({ since: dayBefore(today, days - 1), types }), { days, today }));
  });
  // Allow rules suggested from the ruling history, replayed so none would have let a past denial through (#169). Read-only.
  api.get('/permissions/suggest', (c) => {
    const num = (k: string) => { const v = Number(c.req.query(k)); return Number.isFinite(v) && v > 0 ? v : undefined; };
    return c.json(suggestForStore(store, { minApprovals: num('min'), minItems: num('min_items') }));
  });
  api.get('/parks', (c) => c.json(parkSummary(store.journal.read({ types: (t) => t.startsWith('permission.') || t === 'op.begin' || t === 'op.end' }))));
  api.get('/engine', (c) => c.json({ mode: engine.mode, modes: modeView(store, engine.mode), paused: engine.paused, ...guardView(store, engine.paused), sessions: engine.sessions(), ...(engine.ciQueue ? { ci_queue: engine.ciQueue } : {}), ...runnerStallsView(engine), ...(engine.restartReadiness ? { restart: engine.restartReadiness() } : {}), log: engine.log.slice(-200) }));
  // The orchestrator's suggestions about planestro itself (dogfood f8): a list of their own, not buried in Activity.
  // Each with what became of it (#231): the issues it was filed as, or handled by hand.
  api.get('/orchestrator/notes', (c) => c.json(notesWithLinks(store)));
  // The read marker (#305), one for every device: it only moves forward, and every open page hears it as `journal.appended`.
  api.get('/orchestrator/notes/seen', (c) => c.json({ seen: notesSeen(store) }));
  api.post('/orchestrator/notes/seen', async (c) => {
    try {
      const { up_to } = z.object({ up_to: z.string().min(1) }).parse(await c.req.json());
      return c.json({ seen: markNotesSeen(store, up_to) });
    } catch (e) { return fail(c, e); }
  });
  // File as issue in feedback.issue_repo (#231): a marked issue is linked, a likely match is offered first unless `force`.
  api.post('/orchestrator/notes/file', async (c) => {
    try {
      const { note, force } = z.object({ note: z.string().min(1), force: z.boolean().optional() }).parse(await c.req.json());
      const gh = ghOf(engine, 'file issues');
      return c.json(await fileNote(store, gh, note, { force }));
    } catch (e) { return fail(c, e, (e as { status?: number }).status ?? 400); }
  });
  // Mark as handled (#231): issues filed by hand, or handled with none, for one note or many (a backfill). Files nothing.
  api.post('/orchestrator/notes/mark', async (c) => {
    try {
      const link = z.object({ note: z.string().min(1), issues: z.array(z.number().int().positive()).optional(), handled: z.boolean().optional(), comment: z.string().optional() });
      const { links } = z.object({ links: z.array(link).min(1) }).parse(await c.req.json());
      markNotes(store, links);
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  // The project's GitHub issues as items (#231): the open ones, each with the item already imported from it…
  api.get('/issues/importable', async (c) => { try { return c.json(await importableIssues(store, ghOf(engine, 'read issues'))); } catch (e) { return fail(c, e, (e as { status?: number }).status ?? 400); } });
  // …and the import: the issues named, or every open one with the label (issues.import_label). Idempotent; submits nothing.
  api.post('/issues/import', async (c) => {
    try {
      const body = z.object({ issues: z.array(z.number().int().positive()).optional(), label: z.string().min(1).optional(), closes: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
      return c.json(await importIssues(store, ghOf(engine, 'read issues'), body));
    } catch (e) { return fail(c, e, (e as { status?: number }).status ?? 400); }
  });
  api.post('/engine/pause', (c) => { engine.pause(); return c.json({ paused: true }); });
  // Restart preparation (f3): POST drain, then poll GET /engine until restart.idle is true; DELETE cancels it.
  // `{ by: 'update' }` is serve --watch restarting onto new planestro code (#90): the page says so and offers no cancel.
  api.post('/engine/drain', async (c) => {
    if (!engine.drain) return c.json({ error: 'this engine has nothing to drain' }, 400);
    const body = await c.req.json().catch(() => ({})) as { by?: unknown };
    engine.drain(body?.by === 'update' ? 'update' : 'user');
    return c.json(engine.restartReadiness!());
  });
  api.delete('/engine/drain', (c) => { engine.undrain?.(); return c.json(engine.restartReadiness?.() ?? { draining: false, idle: true, running: [] }); });
  api.post('/engine/resume', (c) => { engine.resume(); return c.json({ paused: false }); });
  api.get('/journal', (c) => c.json(store.journal.read({ item: c.req.query('item') ?? undefined, since: c.req.query('since') ?? undefined, type: c.req.query('type') ?? undefined, limit: journalLimit(c.req.query('limit')) })));
  api.get('/git', async (c) => c.json(await store.git.status()));
  api.post('/git/commit', async (c) => { await store.flushCommits(); return c.json({ committed: store.git.checkpoint() }); });
  api.post('/git/push', async (c) => c.json({ pushed: await store.git.push() }));

  return api;
}

/** Serve managed attachments from inside the data dir only. */
export function attachmentRoutes(store: DataStore): Hono {
  const r = new Hono();
  r.get('/:id/:file', (c) => {
    const id = c.req.param('id'), file = c.req.param('file');
    if (id !== CHAT_ATTACHMENTS_DIR && !store.getItem(id)) return c.notFound();
    try {
      const abs = managedAttachmentPath(store.dataDir, id, file);
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      const inline = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/plain', json: 'application/json' } as Record<string, string>)[ext];
      // Attachments are untrusted documents on the control API's origin. SVG/PDF/HTML
      // download; the sandbox also prevents script execution if a browser renders one.
      return c.body(readFileSync(abs), 200, {
        'content-type': inline ?? 'application/octet-stream',
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${file}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      });
    } catch { return c.notFound(); }
  });
  return r;
}
