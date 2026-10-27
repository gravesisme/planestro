import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { STATUSES, PRIORITIES, KINDS, decisionOf } from '@planestro/shared';
import { actingAs, type DataStore, type StoredItem, type ItemOp } from '../store/DataStore.ts';
import { notesWithLinks, fileNote, markNotes } from '../engine/feedback.ts';
import type { GhPort } from '../engine/ports.ts';
import type { Engine } from '../engine/Engine.ts';
import { TOOL_VERSION } from '../config.ts';
import { listInstances, readInstance, pgidOf, uptime, type Instance } from '../instances.ts';
import { itemView } from './views.ts';
import { allowedHosts, hostnameOf } from '../guard.ts';

// ---- the operator MCP endpoint (#175, step 2) ----
// `/mcp` on the running server: the backlog for whoever operates planestro from an MCP client
// (Claude Code, Codex, Cursor), registered at user scope. Read-only, unless the project sets
// `operator_mcp.allow_writes`: then `create_item` too, which files to NOT_YET_SUBMITTED and nothing
// more (#232): submitting stays the user's word (#73). `operator_mcp.allow_actions`, a separate opt-in,
// adds the item actions a supervising session needs (#365), each through the same engine call as the
// board's route and written to Activity as `[operator]`, not `[user]`; plan approval, merges and
// discards stay on the board unless `operator_mcp.allow_decisions`, a third opt-in, offers them too (approve or send back
// a plan, discard, close as done). Item edits and the feedback notes ride the first two. It is a different thing from
// the in-process `planestro` server each worker and the orchestrator get (submit_plan, report_done,
// …), and must never reach them: workers never touch planning state (invariant 1). They run with
// strictMcpConfig (Claude) or --ignore-user-config (Codex), so a user-scope registration is not
// inherited, and a project's own MCP servers may not point at an operator endpoint (operatorMcpUrl).

/** The tools this endpoint always offers. */
export const OPERATOR_READ_TOOLS = ['list_items', 'get_item', 'get_state', 'list_notes'] as const;
/** Listed only with `operator_mcp.allow_writes` (#232); off, they are unknown tools. Files only: nothing starts work. */
export const OPERATOR_WRITE_TOOLS = ['create_item', 'edit_item', 'mark_note'] as const;
/** Listed only with `operator_mcp.allow_actions` (#365); off, they are unknown tools. */
export const OPERATOR_ACTION_TOOLS = ['unblock_item', 'send_message', 'answer_question', 'answer_decision', 'decide_permission', 'sync_item', 'rerun_ci', 'file_note'] as const;
/** Listed only with `operator_mcp.allow_decisions`: the board's decisions about an item's run, for a supervising session the user directs. */
export const OPERATOR_DECISION_TOOLS = ['approve_plan', 'reject_plan', 'discard_item', 'close_as_done'] as const;
/** Every tool this endpoint can offer; operatorMcp.test.ts pins that a worker session gets none of them. */
export const OPERATOR_TOOLS = [...OPERATOR_READ_TOOLS, ...OPERATOR_WRITE_TOOLS, ...OPERATOR_ACTION_TOOLS, ...OPERATOR_DECISION_TOOLS] as const;

/** Whether a URL is some planestro server's operator endpoint: `/mcp` on a host and port a recorded instance serves, or any loopback `/mcp` on a known port. */
export function operatorMcpUrl(url: string, instances: (Pick<Instance, 'port'> & Partial<Pick<Instance, 'host' | 'url'>>)[] = [], aliases: readonly string[] = []): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.pathname.replace(/\/+$/, '') !== '/mcp') return false;
  const knownHosts = allowedHosts('0.0.0.0', aliases);
  // Wildcard bind addresses can also route to the local server. They are not UI
  // Host-header allowances, but must never be exposed as worker MCP endpoints.
  knownHosts.add('0.0.0.0'); knownHosts.add('::');
  for (const i of instances) {
    if (i.host) knownHosts.add(hostnameOf(i.host));
    if (i.url) { try { knownHosts.add(hostnameOf(new URL(i.url).hostname)); } catch { /* invalid stale record */ } }
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return knownHosts.has(hostnameOf(u.hostname)) && instances.some((i) => i.port === port);
}

/** One line per item, enough to triage from: the rest is in get_item. */
function itemSummary(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  const d = store.derived(item);
  return {
    id: fm.id, title: fm.title, kind: fm.kind, status: fm.status, category: fm.category, ...(fm.priority ? { priority: fm.priority } : {}),
    ...(fm.parent ? { epic: fm.parent } : {}),
    ...(fm.blocked ? { blocked: fm.blocked_reason ?? true } : {}),
    ...(fm.awaiting ? { awaiting: fm.awaiting } : {}),
    ...(d.needs_you ? { needs_you: true } : {}),
    ...(fm.op ? { op: fm.op } : {}),
    ...(fm.pr ? { pr: fm.pr, ci: fm.ci_result } : {}),
    ...(fm.skip_merge ? { held: fm.hold_reason ?? true } : {}),
    ...(fm.taken_over ? { taken_over: true } : {}),
    updated_at: fm.updated_at,
  };
}

/** This server's own `planestro start` record, when it was started that way; the other live instances on the machine. */
function instancesView(dataDir: string) {
  const own = readInstance(dataDir);
  // This process, or the --watch supervisor that leads its group: a record left by an earlier run is not us.
  const self = own && (own.pid === process.pid || own.pgid === pgidOf(process.pid)) ? own : undefined;
  const others = listInstances({ prune: false }).live.filter((i) => i.data_dir !== dataDir);
  const show = (i: Instance) => ({ data_dir: i.data_dir, url: i.url, mcp: `${i.url}/mcp`, pid: i.pid, pgid: i.pgid, watch: i.watch, up: uptime(i.started_at), log: i.log });
  return { this: self ? show(self) : null, others: others.map(show) };
}

function stateSummary(store: DataStore, engine: Engine) {
  const items = store.listItems();
  const count = (pick: (i: StoredItem) => boolean) => items.filter(pick).map((i) => i.id);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.file.frontmatter.status === s).length]).filter(([, n]) => n));
  const fm = (i: StoredItem) => i.file.frontmatter;
  return {
    project: { name: store.config.project.name, id_prefix: store.config.project.id_prefix, data_dir: store.dataDir, code_repo: store.codeRepoPath() },
    planestro: TOOL_VERSION,
    engine: { mode: engine.mode, paused: engine.paused, read_only: store.readOnly, sessions: engine.sessions() },
    counts: byStatus,
    running: count((i) => ['PLAN_IN_PROGRESS', 'IN_PROGRESS'].includes(fm(i).status) && !fm(i).blocked),
    queued: count((i) => fm(i).status === 'QUEUED'),
    blocked: items.filter((i) => fm(i).blocked).map((i) => ({ id: i.id, reason: fm(i).blocked_reason })),
    needs_you: count((i) => Boolean(store.derived(i).needs_you)),
    awaiting_review: count((i) => fm(i).status === 'PLAN_READY' || (fm(i).status === 'IN_REVIEW' && Boolean(fm(i).skip_merge))),
    open_prs: items.filter((i) => fm(i).pr && fm(i).status === 'IN_REVIEW').map((i) => ({ id: i.id, pr: fm(i).pr, ci: fm(i).ci_result })),
    invalid_files: store.invalid.length,
    instances: instancesView(store.dataDir),
  };
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const FILES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** An item action (#365): it may start a session, push a branch or re-run CI, so it reaches past the backlog's files. */
const ACTS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/** What the engine answers in words when it declines (`not now: …`), said back as an error. */
const DECLINED = /^(not now|not possible|refused|nothing to)/;

/** The engine calls the board's routes make that are not on every engine (MockEngine has none of them). */
type ActingEngine = Engine & {
  unblock?: (id: string, message?: string, by?: 'user', opts?: { fresh?: boolean }) => Promise<void>;
  syncWithBase?: (id: string, opts?: { by?: 'user' }) => Promise<string>;
  answerDecision?: (id: string, answer: { choice?: string; text?: string }) => Promise<void>;
};

export function operatorServer(store: DataStore, engine: Engine): McpServer {
  // Read per request (the server is made per request), so turning the key off in Settings takes effect at once.
  const { allow_writes: writes, allow_actions: actions, allow_decisions: decisions } = store.config.operator_mcp;
  const offers = [writes && 'create_item, which files a new item for the user to submit, edit_item and mark_note', actions && 'item actions (unblock_item, send_message, answer_question, answer_decision, decide_permission, sync_item, rerun_ci, file_note) that act as the board does, recorded in Activity as [operator]', decisions && 'decisions (approve_plan, reject_plan, discard_item, close_as_done) as the board makes them'].filter(Boolean).join(', and ');
  const server = new McpServer({ name: 'planestro', version: TOOL_VERSION }, { instructions: `The backlog of ${store.config.project.name} (${store.dataDir}), ${offers ? `with ${offers}` : 'read-only'}. get_state for the overview, list_items to find items, get_item for one.` });
  server.registerTool('list_items', {
    description: 'List backlog items, one summary line each (id, title, kind, status, priority, epic, blocked reason, awaiting, needs_you, PR and CI). Filters combine.',
    inputSchema: {
      status: z.enum(STATUSES).optional().describe('Only items in this status'),
      epic: z.string().optional().describe('Only the children of this epic id'),
      queued: z.boolean().optional().describe('true: only items waiting in the queue (QUEUED); false: everything else'),
      q: z.string().optional().describe('Text to search titles and bodies for'),
      priority: z.enum(PRIORITIES).optional().describe('Only items with this priority'),
    },
    annotations: READ_ONLY,
  }, async ({ status, epic, queued, q, priority }) => {
    let items = store.search(q ?? '', { ...(status ? { status } : {}), ...(priority ? { priority } : {}) });
    if (epic) items = items.filter((i) => i.file.frontmatter.parent === epic);
    if (queued !== undefined) items = items.filter((i) => (i.file.frontmatter.status === 'QUEUED') === queued);
    return json(items.map((i) => itemSummary(store, i)));
  });
  server.registerTool('get_item', {
    description: 'One backlog item in full: frontmatter, Description, Notes, Plan, Activity, and derived values (base branch, lane, needs_you).',
    inputSchema: { id: z.string().describe('The item id, e.g. HH-143') },
    annotations: READ_ONLY,
  }, async ({ id }) => {
    const item = store.getItem(id);
    if (!item) return { ...json({ error: `no item ${id}` }), isError: true };
    const { park_hint: _hint, ...view } = itemView(store, item);
    return json(view);
  });
  server.registerTool('get_state', {
    description: 'The backlog at a glance: project, engine mode and pause, counts by status, what is running, queued, blocked, needs you, awaiting review, open PRs, and the planestro instances running on this machine.',
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => json(stateSummary(store, engine)));
  if (writes) server.registerTool('create_item', {
    description: 'File a new backlog item (a follow-up, a bug seen in passing). It lands in Not yet submitted for the user to read, edit and submit: nothing starts work on it.',
    inputSchema: {
      title: z.string().trim().min(1).describe('A short title'),
      description: z.string().optional().describe('What is wanted and why, in Markdown: what the planner will read'),
      kind: z.enum(KINDS).optional().describe('item (default), or epic for work that breaks into several items'),
      category: z.string().optional().describe(`One of the project's categories (${store.config.categories.join(', ')}); omitted, ${store.config.defaults.category}`),
      priority: z.enum(PRIORITIES).optional().describe('high, medium or low; omitted, unset'),
    },
    annotations: FILES,
  }, async ({ title, description, kind, category, priority }) => {
    try {
      // Never the user's word (#73): `created_by` says where it came from, and the actor is not the user.
      const item = store.createItem({ title, ...(description ? { description } : {}), ...(kind ? { kind } : {}), ...(category ? { category } : {}), ...(priority ? { priority } : {}), extra: { created_by: 'operator_mcp' }, created_line: 'created through the operator MCP' }, 'engine');
      return json(itemSummary(store, item));
    } catch (e) { return { ...json({ error: (e as Error).message }), isError: true }; }
  });
  server.registerTool('list_notes', {
    description: "The orchestrator's notes about planestro itself (the Console's Planestro feedback), oldest first, each with what became of it: the issues it was filed as, handled with none, or open. `open` lists only those nothing was done with.",
    inputSchema: { open: z.boolean().optional().describe('true: only notes not yet filed or handled') },
    annotations: READ_ONLY,
  }, async ({ open }) => json(notesWithLinks(store).filter((n) => !open || !(n.links.handled || n.links.issues.length)).map((n) => ({ ts: n.ts, ...(n.item ? { item: n.item } : {}), text: n.data?.text, ...n.links }))));
  if (writes) registerWrites(server, store);
  if (actions) registerItemActions(server, store, engine as ActingEngine);
  if (decisions) registerDecisions(server, store, engine);
  return server;
}

const opError = (e: unknown) => ({ ...json({ error: (e as Error).message }), isError: true });

/** Edits and note links (`allow_writes`): file changes that start, stop or merge nothing. */
function registerWrites(server: McpServer, store: DataStore): void {
  server.registerTool('edit_item', {
    description: "Edit an item's planning fields and its Description or Notes, as the board's edit does. Nothing here starts, stops or merges work: status, holds, branch, PR, models and the Plan stay on the board. A null clears priority, release or parent.",
    inputSchema: {
      id: z.string().describe('The item id, e.g. HH-143'),
      title: z.string().trim().min(1).optional(),
      category: z.string().optional().describe(`One of ${store.config.categories.join(', ')}`),
      priority: z.enum(PRIORITIES).nullable().optional(),
      release: z.string().min(1).nullable().optional().describe('A release version, or null to clear'),
      parent: z.string().nullable().optional().describe('The epic it belongs to, or null to take it out'),
      depends_on: z.array(z.string()).optional().describe('Item ids it waits on (replaces the list)'),
      description: z.string().optional().describe('The new Description, whole, in Markdown'),
      notes: z.string().optional().describe('The new Notes, whole, in Markdown'),
    },
    annotations: FILES,
  }, async ({ id, description, notes, ...fields }) => {
    try {
      const cur = store.requireItem(id);
      const set: Record<string, unknown> = {}; const unset: string[] = [];
      for (const [k, v] of Object.entries(fields)) { if (v === null) unset.push(k); else if (v !== undefined) set[k] = v; }
      if (set.category && !store.config.categories.includes(set.category as string)) throw new Error(`unknown category ${set.category}`);
      if (set.release) store.requireRelease(set.release as string);
      if (set.parent && store.requireItem(set.parent as string).file.frontmatter.kind !== 'epic') throw new Error(`${set.parent} is not an epic`);
      for (const d of (set.depends_on as string[] | undefined) ?? []) if (!store.getItem(d)) throw new Error(`no item ${d}`);
      const ops: ItemOp[] = [...(Object.keys(set).length ? [{ set }] : []), ...(unset.length ? [{ unset }] : []), ...(description !== undefined ? [{ section: 'Description', body: description }] : []), ...(notes !== undefined ? [{ section: 'Notes', body: notes }] : [])];
      if (!ops.length) return json(itemSummary(store, cur));
      const edited = await actingAs('operator', async () => store.editItem(id, ops));
      store.journal.append({ type: 'operator_mcp.action', item: id, actor: 'operator', data: { tool: 'edit_item', fields: [...Object.keys(set), ...unset, ...(description !== undefined ? ['Description'] : []), ...(notes !== undefined ? ['Notes'] : [])] } });
      return json(itemSummary(store, edited));
    } catch (e) { return opError(e); }
  });
  server.registerTool('mark_note', {
    description: 'Record what became of an orchestrator note about planestro (list_notes): the issues it was filed as by hand, or handled with no issue. Creates nothing on GitHub.',
    inputSchema: { note: z.string().describe("The note's ts, as list_notes gives it"), issues: z.array(z.number().int().positive()).optional().describe('Issue numbers it became'), handled: z.boolean().optional().describe('true: dealt with, no issue'), comment: z.string().optional() },
    annotations: FILES,
  }, async ({ note, issues, handled, comment }) => {
    try { markNotes(store, [{ note, ...(issues ? { issues } : {}), ...(handled ? { handled } : {}), ...(comment ? { comment } : {}) }]); return json(notesWithLinks(store).find((n) => n.ts === note)!.links); }
    catch (e) { return opError(e); }
  });
}

/**
 * The board's decisions about an item's run (`allow_decisions`), each through the engine call its route makes, written to
 * Activity as `[operator]`. What the board keeps to a person's tick stays there: an epic's plan approved as one item, the
 * remote branch's deletion on a discard.
 */
function registerDecisions(server: McpServer, store: DataStore, engine: Engine): void {
  const id = z.string().describe('The item id, e.g. HH-143');
  const decide = async (tool: string, itemId: string, args: Record<string, unknown>, fn: () => Promise<string | void>) => {
    try {
      if (!store.getItem(itemId)) throw new Error(`no item ${itemId}`);
      const said = await actingAs('operator', fn);
      store.journal.append({ type: 'operator_mcp.action', item: itemId, actor: 'operator', data: { tool, ...args } });
      return json({ ...(said ? { said } : {}), item: itemSummary(store, store.requireItem(itemId)) });
    } catch (e) { return opError(e); }
  };
  server.registerTool('approve_plan', {
    description: "Approve an item's plan (PLAN_READY), as the board's Approve does: implementation starts. `notes` go to the implementer; `hold` keeps its PR out of the merge until the user releases it. A plan that reads as an epic is refused: approving it as one item stays on the board.",
    inputSchema: { id, notes: z.string().optional().describe('Approval notes for the implementer'), hold: z.string().trim().min(1).optional().describe('Why its PR must wait for the user') },
    annotations: ACTS,
  }, ({ id: itemId, notes, hold }) => decide('approve_plan', itemId, { ...(notes ? { notes } : {}), ...(hold ? { hold } : {}) }, () => engine.approvePlan(itemId, notes, 'user', { ...(hold ? { hold } : {}) })));
  server.registerTool('reject_plan', {
    description: "Send an item's plan back to its planner with what to change, as the board's Request changes does.",
    inputSchema: { id, message: z.string().trim().min(1).describe('What the planner should change') },
    annotations: ACTS,
  }, ({ id: itemId, message }) => decide('reject_plan', itemId, { message }, () => engine.rejectPlan(itemId, message)));
  server.registerTool('discard_item', {
    description: "Discard work no longer wanted (QUEUED through IN_REVIEW), as the board's Discard does: the turn stops, its PR is closed with the reason, it leaves its epic and goes to the Icebox. Its remote branch is kept: deleting it is the user's tick on the board.",
    inputSchema: { id, reason: z.string().trim().min(1).describe('Why, for the PR and Activity') },
    annotations: { ...ACTS, destructiveHint: true },
  }, ({ id: itemId, reason }) => decide('discard_item', itemId, { reason }, () => engine.discard(itemId, reason, { deleteBranch: false })));
  server.registerTool('close_as_done', {
    description: "Close an item as done for work that landed some other way, as the board's Close as done does. Up to IN_REVIEW; its worktree and branch go only when clean with nothing ahead of the base.",
    inputSchema: { id, reason: z.string().optional().describe('Where the work landed') },
    annotations: { ...ACTS, destructiveHint: true },
  }, ({ id: itemId, reason }) => decide('close_as_done', itemId, { ...(reason ? { reason } : {}) }, () => engine.closeAsDone(itemId, reason)));
}

/**
 * The item actions (#365), each the engine call its board route makes, run as the user but written to Activity as `[operator]`
 * (actingAs) and journaled once (`operator_mcp.action`), so a supervising session's unblock never reads as the designer's click.
 */
function registerItemActions(server: McpServer, store: DataStore, engine: ActingEngine): void {
  const id = z.string().describe('The item id, e.g. HH-143');
  const act = async (tool: string, itemId: string, args: Record<string, unknown>, fn: () => Promise<string | void>) => {
    try {
      if (!store.getItem(itemId)) throw new Error(`no item ${itemId}`);
      const said = await actingAs('operator', fn);
      store.journal.append({ type: 'operator_mcp.action', item: itemId, actor: 'operator', data: { tool, ...args } });
      return json({ ...(said ? { said } : {}), item: itemSummary(store, store.requireItem(itemId)) });
    } catch (e) { return { ...json({ error: (e as Error).message }), isError: true }; }
  };
  const said = (r: string) => { if (DECLINED.test(r)) throw new Error(r); return r; };

  server.registerTool('unblock_item', {
    description: "Unblock an item, as the board's Unblock does. Without a message it carries on from where it stopped (opens the PR, re-enters the merge pipeline, resumes the session); with one, the message goes to its session as a decision. `fresh` gives the message to a new conversation.",
    inputSchema: { id, message: z.string().optional().describe('What the session should do now'), fresh: z.boolean().optional().describe('Start a fresh conversation for the message') },
    annotations: ACTS,
  }, ({ id: itemId, message, fresh }) => act('unblock_item', itemId, { ...(message ? { message } : {}), ...(fresh ? { fresh } : {}) }, async () => {
    if (engine.unblock) await engine.unblock(itemId, message, 'user', { fresh });
    else store.mutateItem(itemId, [{ unset: ['blocked', 'blocked_reason', 'awaiting', 'awaiting_data'] }, { activity: { actor: 'user', text: `unblocked${message ? `: ${message}` : ''}` } }], 'user', { commit: `${itemId}: unblock` });
  }));
  server.registerTool('send_message', {
    description: "Send a message to an item's session, as the board's message box does: it resumes the session, or is queued for it while a turn runs or it waits on a question.",
    inputSchema: { id, message: z.string().trim().min(1).describe('The message, in Markdown') },
    annotations: ACTS,
  }, ({ id: itemId, message }) => act('send_message', itemId, { message }, () => engine.message(itemId, message)));
  server.registerTool('answer_question', {
    description: "Answer the questions an item's session parked on (awaiting: question), each question's text to its answer, as the board's answer form does. The session resumes with them.",
    inputSchema: { id, answers: z.record(z.string(), z.string().min(1)).refine((a) => Object.keys(a).length > 0, 'at least one answer').describe('Each question, as asked, to its answer') },
    annotations: ACTS,
  }, ({ id: itemId, answers }) => act('answer_question', itemId, { answers }, () => engine.respond(itemId, { kind: 'question', answers })));
  server.registerTool('answer_decision', {
    description: "Answer the decision card an item waits on: one of its option labels, your own words where it allows them, or both, as the board's card does. An option that carries an action (filing or submitting an item, a discard) is the user's to pick on the board.",
    inputSchema: { id, choice: z.string().optional().describe('The label of the option picked, exactly'), text: z.string().optional().describe('Your answer in words') },
    annotations: ACTS,
  }, ({ id: itemId, choice, text }) => act('answer_decision', itemId, { ...(choice ? { choice } : {}), ...(text ? { text } : {}) }, async () => {
    if (!engine.answerDecision) throw new Error('decisions need the live engine');
    // An option's action is performed as the user when it is picked: never on an operator session's word (#73).
    const option = decisionOf(store.requireItem(itemId).file.frontmatter)?.options.find((o) => o.label === choice?.trim());
    if (option?.action) throw new Error(`"${option.label}" carries an action (${option.action.tool}); pick it on the board`);
    await engine.answerDecision(itemId, { choice, text });
  }));
  server.registerTool('decide_permission', {
    description: `Decide the permission request an item's session parked on: deny it (with a reason the session reads)${store.config.operator_mcp.allow_permissions ? ', or allow it once' : '. Allowing needs operator_mcp.allow_permissions, which is off'}. Never adds an allow rule: that stays on the board.`,
    inputSchema: { id, decision: z.enum(['allow', 'deny']).describe('allow: this request once; deny: refuse it'), reason: z.string().optional().describe('Why, for the session') },
    annotations: ACTS,
  }, ({ id: itemId, decision, reason }) => act('decide_permission', itemId, { decision, ...(reason ? { reason } : {}) }, async () => {
    // Read per call, like allow_writes: turning it off applies at once.
    if (decision === 'allow' && !store.config.operator_mcp.allow_permissions) throw new Error('allowing a permission request needs operator_mcp.allow_permissions; it is off, so allow it on the board, or deny it');
    await engine.respond(itemId, { kind: 'permission', decision, ...(reason ? { reason } : {}) });
  }));
  server.registerTool('sync_item', {
    description: "Bring an item's branch up to date with its base between turns, as the board's Sync with base does. A conflict goes to the session.",
    inputSchema: { id },
    annotations: ACTS,
  }, ({ id: itemId }) => act('sync_item', itemId, {}, async () => {
    if (!engine.syncWithBase) throw new Error('syncing a branch needs the live engine');
    return said(await engine.syncWithBase(itemId, { by: 'user' }));
  }));
  server.registerTool('file_note', {
    description: "File an orchestrator note about planestro (list_notes) as an issue in feedback.issue_repo, as the Console's File as issue does: an issue carrying the note's marker is linked instead, and a likely match is offered first (`candidates`) unless `force`.",
    inputSchema: { note: z.string().describe("The note's ts, as list_notes gives it"), force: z.boolean().optional().describe('File even though likely matches were offered') },
    annotations: ACTS,
  }, async ({ note, force }) => {
    try {
      const gh = (engine as Engine & { orchestrator?: { gh?: GhPort } }).orchestrator?.gh;
      if (!gh) throw new Error('filing issues needs the live engine');
      return json(await fileNote(store, gh, note, { ...(force ? { force } : {}) }));
    } catch (e) { return { ...json({ error: (e as Error).message }), isError: true }; }
  });
  server.registerTool('rerun_ci', {
    description: "Re-run the head's red or cancelled CI run, as the board's Re-run CI does; its new attempt is the verdict that counts.",
    inputSchema: { id },
    annotations: ACTS,
  }, ({ id: itemId }) => act('rerun_ci', itemId, {}, async () => said(await engine.rerunCi(itemId, 'user'))));
}

/** Streamable HTTP, stateless: a server and transport per request, JSON responses (nothing here streams). */
export function operatorMcpRoutes(store: DataStore, engine: Engine): Hono {
  const app = new Hono();
  app.all('/', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = operatorServer(store, engine);
    await server.connect(transport);
    try { return await transport.handleRequest(c.req.raw); } finally { void server.close(); }
  });
  return app;
}
