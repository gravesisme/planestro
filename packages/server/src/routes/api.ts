import { Hono } from 'hono';
import { z } from 'zod';
import { basename, join, normalize } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { allowedTransitions, parsePromptFile, RenderError, STATUSES, PROMPT_KINDS, RELEASE_STATUSES, markUnavailable, type Status, type Actor } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Engine } from '../engine/Engine.ts';
import type { ConsoleBuffer } from '../store/ConsoleBuffer.ts';
import { itemView, promptView, releaseView, questionView, stateView, guardView, publicLocal } from './views.ts';
import { applyConfigSettings, applyLocalSettings, putModel, removeModel } from '../settingsWrite.ts';

const EDITABLE_FIELDS = z.object({
  title: z.string().min(1).optional(), category: z.string().min(1).optional(), planner: z.string().optional(), implementer: z.string().optional(),
  auto_approve_plan: z.boolean().optional(), allow_model_fallback: z.boolean().nullable().optional(), depends_on: z.array(z.string()).optional(), parent: z.string().nullable().optional(),
  merge_policy: z.enum(['app', 'watch']).nullable().optional(), base_branch_override: z.string().nullable().optional(),
  branch: z.string().nullable().optional(), pr: z.number().int().positive().nullable().optional(),
  skip_merge: z.boolean().nullable().optional(),
  budget_usd: z.number().positive().nullable().optional(), budget_turns: z.number().int().positive().nullable().optional(), budget_tokens: z.number().int().positive().nullable().optional(),
}).strict();

const CHAT_TYPES = new Set(['orchestrator.user_message', 'orchestrator.reply', 'orchestrator.question', 'orchestrator.done']);

/** The orchestrator, when this engine has one (the live engine, in live or dry-run mode; never the mock). */
type Orch = { wake: (ev: { type: string; item?: string; data?: Record<string, unknown> }) => void; enabled: boolean; questionPending?: (id: string) => boolean };
const orchestratorOf = (engine: Engine): Orch | undefined => (engine as Engine & { orchestrator?: Orch }).orchestrator;

export function apiRoutes(store: DataStore, engine: Engine, consoles?: ConsoleBuffer): Hono {
  const api = new Hono();
  const fail = (c: any, e: unknown, status = 400) => c.json({ error: (e as Error).message ?? String(e) }, status);
  const pending = (id: string) => Boolean(orchestratorOf(engine)?.questionPending?.(id));
  const awake = (): Orch => { const o = orchestratorOf(engine); if (!o?.enabled) throw new Error('the orchestrator is not available with this engine'); return o; };

  api.get('/state', async (c) => c.json(stateView(store, engine, await store.git.status())));
  api.post('/reload', async (c) => { store.reload(); return c.json({ ok: true, invalid: store.invalid }); });
  api.post('/reconcile', async (c) => { const e = engine as Engine & { reconcile?: (s: 'manual') => Promise<string[]> }; if (!e.reconcile) return c.json({ corrections: [], note: 'no reconciler with this engine' }); return c.json({ corrections: await e.reconcile('manual') }); });
  api.post('/queue/order', async (c) => { try { const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(await c.req.json()); ids.forEach((id, i) => store.mutateItem(id, [{ set: { merge_order: i + 1 } }], 'user')); store.git.commit('planestro: merge order'); engine.poke(); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.get('/items', (c) => {
    const q = c.req.query('q') ?? '';
    const status = c.req.query('status') as Status | undefined;
    const lane = c.req.query('lane') as 'board' | 'icebox' | 'done' | undefined;
    const category = c.req.query('category') ?? undefined;
    return c.json(store.search(q, { status, lane, category }).map((i) => itemView(store, i)));
  });
  api.post('/items', async (c) => {
    try {
      const body = z.object({
        title: z.string().min(1), category: z.string().optional(), description: z.string().optional(), notes: z.string().optional(),
        kind: z.enum(['item', 'epic']).optional(), parent: z.string().optional(), planner: z.string().optional(), implementer: z.string().optional(),
        status: z.enum(['NOT_YET_SUBMITTED', 'ICEBOX']).optional(), depends_on: z.array(z.string()).optional(), auto_approve_plan: z.boolean().optional(),
        allow_model_fallback: z.boolean().optional(),
      }).parse(await c.req.json());
      const { auto_approve_plan, ...input } = body;
      return c.json(itemView(store, store.createItem({ ...input, ...(auto_approve_plan ? { extra: { auto_approve_plan: true } } : {}) })), 201);
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
        if (set.parent) { const p = store.requireItem(set.parent as string); if (p.file.frontmatter.kind !== 'epic') throw new Error(`${set.parent} is not an epic`); }
        // A pull request attached by hand (finished outside planestro) must enter the merge pipeline
        // like one planestro opened: only ci_result 'pending' gets it picked up (dogfood p44).
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

  api.get('/items/:id/console', (c) => c.json({ lines: consoles?.get(c.req.param('id')) ?? [] }));
  api.get('/items/:id/transitions', (c) => {
    const it = store.requireItem(c.req.param('id'));
    // A childless epic is not offered "start": nothing would ever drive it; "plan the breakdown" is (dogfood p56, LM-2).
    const bare = it.file.frontmatter.kind === 'epic' && it.file.frontmatter.status === 'NOT_YET_SUBMITTED' && !store.derived(it).children.length;   // approving a breakdown is also → IN_PROGRESS, with no children yet
    return c.json(allowedTransitions(it.file.frontmatter.status, 'user', store.flavorOf(it.file.frontmatter)).filter((t) => !(bare && t.to === 'IN_PROGRESS')).map((t) => ({ to: t.to, label: t.label })));
  });
  api.post('/items/:id/transition', async (c) => {
    try {
      const id = c.req.param('id');
      const { to, reason } = z.object({ to: z.enum(STATUSES), reason: z.string().optional() }).parse(await c.req.json());
      const it = store.requireItem(id);
      // Closing without a PR goes through the engine: it decides what happens to the worktree and branch.
      if (to === 'PLAN_IN_PROGRESS' && it.file.frontmatter.kind === 'epic') { await engine.planEpic(id); return c.json(itemView(store, store.requireItem(id))); }
      if (to === 'FINISHED') { await engine.closeAsDone(id, reason); return c.json(itemView(store, store.requireItem(id))); }
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
  api.post('/items/:id/plan/approve', async (c) => { try { const { notes, as_item } = z.object({ notes: z.string().optional(), as_item: z.boolean().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.approvePlan(c.req.param('id'), notes, 'user', { asItem: as_item === true }); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  // Item ↔ epic while nothing has run for implementation (#69, HH-198).
  api.post('/items/:id/convert', async (c) => { try { const { to, reason } = z.object({ to: z.enum(['item', 'epic']), reason: z.string().optional() }).parse(await c.req.json()); await engine.convertKind(c.req.param('id'), to, 'user', reason); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/epic/plan', async (c) => { try { await engine.planEpic(c.req.param('id')); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
  api.post('/items/:id/breakdown/approve', async (c) => {
    try {
      const child = z.object({ title: z.string().min(1), description: z.string(), implementer: z.string(), category: z.string().optional(), depends_on: z.array(z.number().int().nonnegative()).optional() });
      const { children, queue } = z.object({ children: z.array(child).optional(), queue: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
      const created = await engine.approveBreakdown(c.req.param('id'), children, { queue });
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
    if (!buf) return c.json({ error: 'not found' }, 404);
    const ext = path.split('.').pop()!.toLowerCase();
    const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain', fbx: 'application/octet-stream' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    // SVG can carry script: serve it as an image only, never as a document.
    return new Response(new Uint8Array(buf), { headers: { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } });
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
      const { items, message } = z.object({ items: z.array(z.string()).min(1), message: z.string().min(1) }).parse(await c.req.json());
      const e = engine as Engine & { resumeAfter?: (id: string, items: string[], message: string) => Promise<string> };
      if (!e.resumeAfter) throw new Error('this engine cannot resume items');
      const r = await e.resumeAfter(c.req.param('id'), items, message);
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
  api.post('/items/:id/unblock', async (c) => { try { const { message } = z.object({ message: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); const e = engine as Engine & { unblock?: (id: string, m?: string) => Promise<void> }; if (e.unblock) await e.unblock(c.req.param('id'), message); else store.mutateItem(c.req.param('id'), [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }], 'user', { commit: `${c.req.param('id')}: unblock` }); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
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
  api.post('/items/:id/respond', async (c) => { try { await engine.respond(c.req.param('id'), await c.req.json()); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.post('/items/:id/attachments', async (c) => {
    try {
      const id = c.req.param('id');
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('multipart/form-data')) {
        const form = await c.req.formData();
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
  api.delete('/releases/:version', (c) => { try { store.deleteRelease(c.req.param('version')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

  api.get('/config', (c) => c.json({ config: store.config, local: publicLocal(store.local), configText: readFileSync(join(store.dataDir, 'planestro.yml'), 'utf8') }));
  // Settings writes: only keys the shared registry marks editable, validated through the schema (settingsWrite.ts).
  api.put('/config', async (c) => { try { return c.json({ config: applyConfigSettings(store, await c.req.json()) }); } catch (e) { return fail(c, e); } });
  api.put('/config/models/:id', async (c) => { try { const config = putModel(store, c.req.param('id'), await c.req.json()); engine.poke(); return c.json({ config }); } catch (e) { return fail(c, e); } });
  api.delete('/config/models/:id', (c) => { try { return c.json({ config: removeModel(store, c.req.param('id')) }); } catch (e) { return fail(c, e); } });
  // Settings → Notifications → Test: the saved command, run the way its event runs it (dry-run only logs it).
  api.post('/config/notifications/test', async (c) => {
    try {
      const { event } = z.object({ event: z.enum(['on_merge', 'on_usage_pause']) }).parse(await c.req.json());
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
  api.put('/config/local', async (c) => { try { return c.json({ local: publicLocal(applyLocalSettings(store, await c.req.json())) }); } catch (e) { return fail(c, e); } });
  api.post('/config/categories', async (c) => {
    try {
      const body = z.discriminatedUnion('op', [
        z.object({ op: z.literal('add'), name: z.string().min(1) }),
        z.object({ op: z.literal('rename'), from: z.string().min(1), to: z.string().min(1) }),
        z.object({ op: z.literal('remove'), name: z.string().min(1), reassign_to: z.string().min(1) }),
        z.object({ op: z.literal('default'), name: z.string().min(1) }),
      ]).parse(await c.req.json());
      let affected = 0;
      if (body.op === 'add') store.updateConfig((doc) => { const cats = (doc.get('categories') as YAML.YAMLSeq).toJSON() as string[]; if (!cats.includes(body.name)) doc.set('categories', [...cats, body.name]); }, `config: add category ${body.name}`);
      else if (body.op === 'rename') affected = store.renameCategory(body.from, body.to);
      else if (body.op === 'remove') affected = store.removeCategory(body.name, body.reassign_to);
      else store.updateConfig((doc) => { doc.setIn(['defaults', 'category'], body.name); }, `config: default category ${body.name}`);
      return c.json({ config: store.config, affected });
    } catch (e) { return fail(c, e); }
  });

  api.post('/orchestrator/message', async (c) => {
    try {
      const { text, item } = z.object({ text: z.string().min(1), item: z.string().optional() }).parse(await c.req.json());
      const e = engine as Engine & { orchestrator?: { wake: (ev: { type: string; item?: string; data?: Record<string, unknown> }) => void; enabled: boolean } };
      if (!e.orchestrator?.enabled) throw new Error('the orchestrator is not available with this engine');
      store.journal.append({ type: 'orchestrator.user_message', item, actor: 'user', data: { text } });
      e.orchestrator.wake({ type: 'user_message', item, data: { message: text } });
      return c.json({ ok: true });
    } catch (e) { return fail(c, e); }
  });
  // The chat: what the user said, what the orchestrator answered or asked, and how each wake about a message ended.
  api.get('/orchestrator/chat', (c) => {
    const e = engine as Engine & { orchestrator?: { enabled: boolean } };
    const entries = store.journal.read().filter((j) => CHAT_TYPES.has(j.type) && (j.type !== 'orchestrator.done' || ((j.data?.events as string[] | undefined) ?? []).includes('user_message'))).slice(-100);
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
  api.get('/engine', (c) => c.json({ mode: engine.mode, paused: engine.paused, ...guardView(store, engine.paused), sessions: engine.sessions(), ...(engine.restartReadiness ? { restart: engine.restartReadiness() } : {}), log: engine.log.slice(-200) }));
  // The orchestrator's suggestions about planestro itself (dogfood f8): a list of their own, not buried in Activity.
  api.get('/orchestrator/notes', (c) => c.json(store.journal.read({ type: 'orchestrator.planestro_note', limit: 100 })));
  api.post('/engine/pause', (c) => { engine.pause(); return c.json({ paused: true }); });
  // Restart preparation (f3): POST drain, then poll GET /engine until restart.idle is true; DELETE cancels it.
  api.post('/engine/drain', (c) => { if (!engine.drain) return c.json({ error: 'this engine has nothing to drain' }, 400); engine.drain(); return c.json(engine.restartReadiness!()); });
  api.delete('/engine/drain', (c) => { engine.undrain?.(); return c.json(engine.restartReadiness?.() ?? { draining: false, idle: true, running: [] }); });
  api.post('/engine/resume', (c) => { engine.resume(); return c.json({ paused: false }); });
  api.get('/journal', (c) => c.json(store.journal.read({ item: c.req.query('item') ?? undefined, since: c.req.query('since') ?? undefined, type: c.req.query('type') ?? undefined, limit: Number(c.req.query('limit') ?? 200) })));
  api.get('/git', async (c) => c.json(await store.git.status()));
  api.post('/git/commit', async (c) => { await store.flushCommits(); return c.json({ committed: store.git.checkpoint() }); });
  api.post('/git/push', async (c) => c.json({ pushed: await store.git.push() }));

  return api;
}

/** Serve managed attachments from inside the data dir only. */
export function attachmentRoutes(store: DataStore): Hono {
  const r = new Hono();
  r.get('/:id/:file', (c) => {
    const rel = normalize(join('attachments', c.req.param('id'), basename(c.req.param('file'))));
    const abs = join(store.dataDir, rel);
    if (!abs.startsWith(store.attachmentsDir) || !existsSync(abs)) return c.notFound();
    const ext = abs.split('.').pop()?.toLowerCase() ?? '';
    const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', json: 'application/json', pdf: 'application/pdf' } as Record<string, string>)[ext] ?? 'application/octet-stream';
    return c.body(readFileSync(abs), 200, { 'content-type': type });
  });
  return r;
}
