import { Hono } from 'hono';
import { z } from 'zod';
import { basename, join, normalize } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { allowedTransitions, parsePromptFile, RenderError, STATUSES, PROMPT_KINDS, type Status, type Actor } from '@planestro/shared';
import type { DataStore, ItemOp } from '../store/DataStore.ts';
import type { Engine } from '../engine/Engine.ts';
import type { ConsoleBuffer } from '../store/ConsoleBuffer.ts';
import { itemView, promptView, stateView } from './views.ts';

const EDITABLE_FIELDS = z.object({
  title: z.string().min(1).optional(), category: z.string().min(1).optional(), planner: z.string().optional(), implementer: z.string().optional(),
  auto_approve_plan: z.boolean().optional(), depends_on: z.array(z.string()).optional(), parent: z.string().nullable().optional(),
  merge_policy: z.enum(['app', 'watch']).nullable().optional(), base_branch_override: z.string().nullable().optional(),
  branch: z.string().nullable().optional(), pr: z.number().int().positive().nullable().optional(),
  skip_merge: z.boolean().nullable().optional(),
}).strict();

export function apiRoutes(store: DataStore, engine: Engine, consoles?: ConsoleBuffer): Hono {
  const api = new Hono();
  const fail = (c: any, e: unknown, status = 400) => c.json({ error: (e as Error).message ?? String(e) }, status);

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
        if (Object.keys(set).length) ops.push({ set });
        if (unset.length) ops.push({ unset });
      }
      for (const [name, text] of Object.entries(body.sections ?? {})) if (text !== undefined) ops.push({ section: name, body: text });
      if (!ops.length) return c.json(itemView(store, store.requireItem(id)));
      return c.json(itemView(store, store.editItem(id, ops)));
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
    return c.json(allowedTransitions(it.file.frontmatter.status, 'user', store.flavorOf(it.file.frontmatter)).map((t) => ({ to: t.to, label: t.label })));
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
      if (to === 'IN_PROGRESS' && it.file.frontmatter.kind === 'epic' && e.openEpic) { await e.openEpic(id); return c.json(itemView(store, store.requireItem(id))); }
      const stored = store.transition(id, to, 'user' as Actor);
      if (to === 'QUEUED') engine.poke();
      return c.json(itemView(store, stored));
    } catch (e) { return fail(c, e); }
  });
  api.post('/items/:id/plan/approve', async (c) => { try { const { notes } = z.object({ notes: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); await engine.approvePlan(c.req.param('id'), notes); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
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
    const first = (await engine.reviewImages(id).catch(() => [])).find((f) => f.change !== 'deleted' && !/\.svg$/i.test(f.path));
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
    const type = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
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
      if (action === 'open' && e.openEpic) await e.openEpic(id);
      else if (action === 'submit' && e.submitEpic) await e.submitEpic(id);
      else if (action === 'sync' && e.syncBase) await e.syncBase(id);
      else throw new Error(`epic action ${action} is not available`);
      return c.json(itemView(store, store.requireItem(id)));
    } catch (e) { return fail(c, e); }
  });
  api.post('/items/:id/unblock', async (c) => { try { const { message } = z.object({ message: z.string().optional() }).parse(await c.req.json().catch(() => ({}))); const e = engine as Engine & { unblock?: (id: string, m?: string) => Promise<void> }; if (e.unblock) await e.unblock(c.req.param('id'), message); else store.mutateItem(c.req.param('id'), [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }], 'user', { commit: `${c.req.param('id')}: unblock` }); return c.json(itemView(store, store.requireItem(c.req.param('id')))); } catch (e) { return fail(c, e); } });
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

  api.get('/config', (c) => c.json({ config: store.config, local: store.local, configText: readFileSync(join(store.dataDir, 'planestro.yml'), 'utf8') }));
  api.put('/config', async (c) => {
    try {
      const body = z.object({
        defaults: z.object({ planner: z.string(), implementer: z.string(), category: z.string() }).partial().optional(),
        concurrency: z.object({ max_sessions: z.number().int().positive(), max_local_jobs: z.number().int().positive() }).partial().optional(),
        ci: z.object({ mode: z.enum(['github', 'github-or-local']), require_green_base: z.boolean(), local_check_command: z.string() }).partial().optional(),
        engine: z.object({ mode: z.enum(['live', 'dry-run']) }).partial().optional(),
        notifications: z.object({ on_merge: z.string() }).partial().optional(),
        orchestrator: z.object({ may_approve_plans: z.boolean(), max_plan_revisions: z.number().int().nonnegative(), may_decide_permissions: z.boolean() }).partial().optional(),
      }).parse(await c.req.json());
      const cfg = store.updateConfig((doc) => { for (const [section, values] of Object.entries(body)) for (const [k, v] of Object.entries(values ?? {})) if (v !== undefined) doc.setIn([section, k], v); }, 'config: update settings');
      return c.json({ config: cfg });
    } catch (e) { return fail(c, e); }
  });
  api.put('/config/local', async (c) => {
    try { const body = z.object({ code_repo_path: z.string().optional(), worktrees_root: z.string().optional(), codex_bin: z.string().optional(), claude_bin: z.string().optional(), anthropic_api_key: z.string().optional() }).parse(await c.req.json()); return c.json({ local: store.updateLocal(body) }); }
    catch (e) { return fail(c, e); }
  });
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
  api.get('/orchestrator/questions', (c) => c.json(store.journal.read({ type: 'orchestrator.question', limit: 20 })));
  api.get('/engine', (c) => c.json({ mode: engine.mode, paused: engine.paused, sessions: engine.sessions(), log: engine.log.slice(-200) }));
  api.post('/engine/pause', (c) => { engine.pause(); return c.json({ paused: true }); });
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
