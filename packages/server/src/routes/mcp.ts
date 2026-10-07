import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { STATUSES, PRIORITIES } from '@planestro/shared';
import type { DataStore, StoredItem } from '../store/DataStore.ts';
import type { Engine } from '../engine/Engine.ts';
import { TOOL_VERSION } from '../config.ts';
import { listInstances, readInstance, pgidOf, uptime, type Instance } from '../instances.ts';
import { itemView } from './views.ts';
import { allowedHosts, hostnameOf } from '../guard.ts';

// ---- the operator MCP endpoint (#175, step 2) ----
// `/mcp` on the running server: the backlog for whoever operates planestro from an MCP client
// (Claude Code, Codex, Cursor), registered at user scope. Read-only. It is a different thing from
// the in-process `planestro` server each worker and the orchestrator get (submit_plan, report_done,
// …), and must never reach them: workers never touch planning state (invariant 1). They run with
// strictMcpConfig (Claude) or --ignore-user-config (Codex), so a user-scope registration is not
// inherited, and a project's own MCP servers may not point at an operator endpoint (operatorMcpUrl).

/** The tools this endpoint offers; operatorMcp.test.ts pins that a worker session gets none of them. */
export const OPERATOR_TOOLS = ['list_items', 'get_item', 'get_state'] as const;

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

export function operatorServer(store: DataStore, engine: Engine): McpServer {
  const server = new McpServer({ name: 'planestro', version: TOOL_VERSION }, { instructions: `The backlog of ${store.config.project.name} (${store.dataDir}), read-only. get_state for the overview, list_items to find items, get_item for one.` });
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
  return server;
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
