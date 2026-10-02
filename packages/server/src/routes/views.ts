import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSection, parseActivity, serializePromptFile, releaseCandidates, getQuestionSection, parseThread, billingMode, TOOLCHAINS, type Status, type LocalConfig } from '@planestro/shared';
import { readUpdateStatus } from '../autoUpdate.ts';
import { parkHint } from '../engine/parks.ts';
import type { DataStore, StoredItem, StoredPrompt, StoredRelease, StoredQuestion } from '../store/DataStore.ts';

/** JSON shape of an item as the UI sees it: frontmatter + sections + derived values. */
export function itemView(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  return {
    id: fm.id,
    path: item.path,
    frontmatter: fm,
    sections: { Description: getSection(item.file, 'Description'), Notes: getSection(item.file, 'Notes'), Plan: getSection(item.file, 'Plan'), Activity: getSection(item.file, 'Activity') },
    activity: parseActivity(item.file),
    derived: store.derived(item),
    park_hint: parkHintOf(store, item),
  };
}

/** A parked Bash request on an item that has parked on the same kind of command before: the rule that would have allowed it (#108). */
function parkHintOf(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  const d = fm.awaiting_data;
  const permission = fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && d?.kind === 'permission');
  if (!permission || d?.tool !== 'Bash') return null;
  const command = String((d.input as { command?: unknown } | undefined)?.command ?? '');
  return parkHint(store.journal.read({ item: fm.id, type: 'permission.parked' }), command, store.config.permissions.allow) ?? null;
}
export type ItemView = ReturnType<typeof itemView>;

export function promptView(p: StoredPrompt) {
  return { name: p.name, path: p.path, frontmatter: p.file.frontmatter, body: p.file.body, text: serializePromptFile(p.file) };
}

/** A release with its sections by title, and the finished work in its window that no release holds yet. */
export function releaseView(store: DataStore, r: StoredRelease) {
  const releases = store.listReleases().map((x) => x.file);
  const items = store.listItems().map((i) => ({ id: i.id, fm: i.file.frontmatter }));
  return {
    version: r.version, path: r.path, frontmatter: r.file.frontmatter,
    sections: r.file.sections.filter((s) => s.title).map((s) => ({ title: s.title, body: s.body })),
    candidates: releaseCandidates(r.version, releases, items).map((i) => i.id),
  };
}
export type ReleaseView = ReturnType<typeof releaseView>;

/**
 * A question as its page shows it. `pending`: a wake about it is queued or running (the engine's
 * memory, not the file's). The list leaves out the details and the thread, which only the page reads.
 */
/** Who closed a question, from its last "resolved by …" / "withdrawn by …" line: planestro when its item finished or was iceboxed (settleQuestions). */
function closedBy(thread: { actor: string; text: string }[]): 'you' | 'orchestrator' | 'planestro' | undefined {
  const m = [...thread].reverse().find((t) => t.actor === 'app' && /^(resolved|withdrawn) by /.test(t.text))?.text.match(/^(?:resolved|withdrawn) by (you|the orchestrator|planestro):/);
  return m ? (m[1] === 'the orchestrator' ? 'orchestrator' : m[1] as 'you' | 'planestro') : undefined;
}

export function questionView(store: DataStore, q: StoredQuestion, pending: boolean, full = true) {
  const fm = q.file.frontmatter;
  const thread = parseThread(q.file);
  const item = fm.item ? store.getItem(fm.item)?.file.frontmatter : undefined;
  return {
    id: fm.id, path: q.path, frontmatter: fm, pending,
    item_title: item?.title, item_status: item?.status,
    summary: getQuestionSection(q.file, 'Summary'), recommendation: getQuestionSection(q.file, 'Recommendation'),
    messages: thread.length, last_at: thread.at(-1)?.at ?? fm.updated_at,
    // Who closed it, from the thread's own line (DataStore.resolveQuestion): the chat says on the card what became of it.
    closed_by: fm.status === 'open' ? undefined : closedBy(thread),
    ...(full ? { details: getQuestionSection(q.file, 'Details'), thread } : {}),
  };
}
export type QuestionView = ReturnType<typeof questionView>;

/** Who paused automation and, for a usage-guard pause, the window reading that did it. */
export function guardView(store: DataStore, paused: boolean) {
  const e = store.local.engine;
  return paused ? { paused_by: e.paused_by, ...(e.paused_by === 'usage_guard' && e.usage_guard ? { usage_guard: e.usage_guard } : {}), ...(e.paused_by === 'disk' && e.disk_guard ? { disk_guard: e.disk_guard } : {}) } : {};
}

/** ANTHROPIC_API_KEY as the server started with it: the sessions it starts inherit this, not a later shell's. */
const STARTUP_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * planestro.local.yml as the web sees it: the API key and MCP servers' keys are secrets, so the page
 * learns only whether they are set (`api_key` in the state) and never gets a value back.
 */
export function publicLocal(local: LocalConfig): LocalConfig {
  const { anthropic_api_key: _secret, ...rest } = local;
  const hide = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).map((k) => [k, '(set)']));
  return { ...rest, mcp_servers: Object.fromEntries(Object.entries(local.mcp_servers ?? {}).map(([name, s]) => [name, { ...s, env: hide(s.env ?? {}), headers: hide(s.headers ?? {}) }])) };
}

export function stateView(store: DataStore, engine: { mode: string; paused: boolean; ciQueue?: { queued: number; running: number }; sessions(): unknown[]; restartReadiness?(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } }, git: unknown, envApiKey = STARTUP_API_KEY) {
  const localKey = store.local.anthropic_api_key?.trim();
  return {
    schema: store.schema,
    readOnly: store.readOnly,
    dataDir: store.dataDir,
    codeRepo: store.codeRepoPath(),
    /** Which toolchain files the code repository has, for the allow rules Settings offers (#96). */
    toolchain: TOOLCHAINS.map((t) => t.marker).filter((m) => existsSync(join(store.codeRepoPath(), m))),
    config: store.config,
    local: publicLocal(store.local),
    /** Whether the dollars planestro counts are an API-price yardstick on a Claude plan, or real charges to an API account (#83). */
    billing: billingMode(localKey, envApiKey),
    api_key: localKey ? 'local' as const : envApiKey?.trim() ? 'env' as const : 'none' as const,
    items: store.listItems().map((i) => itemView(store, i)),
    prompts: store.listPrompts().map(promptView),
    releases: store.listReleases().map((r) => releaseView(store, r)),
    invalid: store.invalid,
    /** What serve --watch last found when it looked for a newer planestro (#103); absent when it never has. */
    update: readUpdateStatus(store.dataDir) ?? null,
    engine: { mode: engine.mode, paused: engine.paused, ...guardView(store, engine.paused), sessions: engine.sessions(), ...(engine.ciQueue ? { ci_queue: engine.ciQueue } : {}), ...(engine.restartReadiness ? { restart: engine.restartReadiness() } : {}) },
    git,
    statuses: ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX'] satisfies Status[],
  };
}
