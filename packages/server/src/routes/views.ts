import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSection, parseActivity, serializePromptFile, releaseCandidates, getQuestionSection, parseThread, TOOLCHAINS, nextRun, scheduleDescription, type Status, type LocalConfig } from '@planestro/shared';
import { readUpdateStatus } from '../autoUpdate.ts';
import { parkHint, permissionGrantRefusal } from '../engine/parks.ts';
import type { DataStore, StoredItem, StoredPrompt, StoredRelease, StoredQuestion, StoredSchedule } from '../store/DataStore.ts';
import type { Engine, SessionView } from '../engine/Engine.ts';
import { lastConcurrencyChange, slotUsageOf } from '../concurrency.ts';

/** JSON shape of an item as the UI sees it: frontmatter + sections + derived values. */
export function itemView(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  return {
    id: fm.id,
    path: item.path,
    frontmatter: fm.awaiting_data?.tool === 'CodexApproval' ? codexApprovalView(fm) : fm,
    sections: { Description: getSection(item.file, 'Description'), Notes: getSection(item.file, 'Notes'), Plan: getSection(item.file, 'Plan'), Activity: getSection(item.file, 'Activity') },
    activity: parseActivity(item.file),
    derived: store.derived(item),
    park_hint: parkHintOf(store, item),
    // What merged into its base since its plan was cut (#217): the approval card says approving syncs it first.
    merged_since_cut: store.mergedSinceCut(item),
  };
}

/** The newest Activity lines a summary keeps: the preview drawer shows six. */
export const SUMMARY_ACTIVITY = 6;

/**
 * An item as /api/state lists it. A done or iceboxed item is a summary (`summary: true`): its Description and Notes (the
 * board searches them), its newest Activity, and no Plan, Activity text or `delivered`; the page asks /api/items/:id for the
 * rest when it is opened. Their full text made the state 19 MB on HH (460 finished items), which a resumed iPhone web app
 * cut short and could not read. The Activity section's text is never listed: `activity` holds it parsed.
 */
export function listedItemView(store: DataStore, item: StoredItem) {
  const v = itemView(store, item);
  const sections = { ...v.sections, Activity: '' };
  if (v.derived.lane === 'board') return { ...v, sections };
  const { delivered: _delivered, ...frontmatter } = v.frontmatter;
  return { ...v, frontmatter, sections: { ...sections, Plan: '' }, activity: v.activity.slice(-SUMMARY_ACTIVITY), summary: true as const };
}

/** A Codex approval as the card shows it: whether allow is possible, and if not why and what can be done (#297). Derived, never persisted. */
function codexApprovalView<T extends { awaiting_data?: Record<string, unknown> }>(fm: T): T {
  const refusal = permissionGrantRefusal({ tool: 'CodexApproval', input: (fm.awaiting_data?.input ?? {}) as Record<string, unknown> });
  return { ...fm, awaiting_data: { ...fm.awaiting_data, grantable: !refusal, ...(refusal ? { grant_refusal: refusal } : {}) } };
}

/** A parked Bash request on an item that has parked on the same kind of command before: the rule that would have allowed it (#108). */
function parkHintOf(store: DataStore, item: StoredItem) {
  const fm = item.file.frontmatter;
  const d = fm.awaiting_data;
  const permission = fm.awaiting === 'permission' || (fm.awaiting === 'orchestrator' && d?.kind === 'permission');
  if (!permission || d?.tool !== 'Bash') return null;
  const command = String((d.input as { command?: unknown } | undefined)?.command ?? '');
  return parkHint(store.journal.read({ item: fm.id, type: 'permission.parked' }), command, store.permissionRules().allow) ?? null;
}
export type ItemView = ReturnType<typeof itemView>;

/** A schedule as the Schedules page shows it: its template, when it runs next, and what each recent slot did. */
export function scheduleView(s: StoredSchedule, now = new Date()) {
  let next: string | null = null; try { next = nextRun(s.file.frontmatter, now) ?? null; } catch { /* a hand edit the store refused already shows as invalid */ }
  return { name: s.name, path: s.path, frontmatter: s.file.frontmatter, description: scheduleDescription(s.file), next_run: next };
}
export type ScheduleView = ReturnType<typeof scheduleView>;

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
  return { provider_guards: e.provider_guards, ...(paused ? { paused_by: e.paused_by, ...(e.paused_by === 'disk' && e.disk_guard ? { disk_guard: e.disk_guard } : {}) } : {}) };
}

/** planestro.local.yml as the web sees it: MCP servers' keys are secrets, so the page learns only that they are set. */
export function publicLocal(local: LocalConfig): LocalConfig {
  const hide = (m: Record<string, string>) => Object.fromEntries(Object.keys(m).map((k) => [k, '(set)']));
  return { ...local, mcp_servers: Object.fromEntries(Object.entries(local.mcp_servers ?? {}).map(([name, s]) => [name, { ...s, env: hide(s.env ?? {}), headers: hide(s.headers ?? {}) }])) };
}

/** One banner per runner label that looks stalled or offline (#216), with the items waiting on it. */
export function runnerStallsView(engine: { runnerStalls?(): { label: string; items: string[]; since: string }[] }) {
  const stalls = engine.runnerStalls?.().map(({ label, items, since }) => ({ label, items, since })) ?? [];
  return stalls.length ? { runner_stalls: stalls } : {};
}

/** The rules workers run under, each with where it came from (#229); the machine policy file is shown, never written. */
export function permissionsView(store: DataStore) {
  const machine = store.machinePolicy.current();
  return { machine_path: machine.path, machine_exists: machine.exists, ...(machine.error ? { machine_error: machine.error } : {}), rules: store.permissionRules().rules };
}

/** "N of M" and how many wait for a slot (#330), with the engine's step-down while it is the last change (a day at most). */
export function slotsView(store: DataStore, engine: Pick<Engine, 'sessions' | 'slotUsage'>) {
  const { running, waiting } = slotUsageOf(engine as Engine);
  const last = lastConcurrencyChange(store);
  const stepped = last?.auto && Date.now() - Date.parse(last.at) < 24 * 3_600_000 ? last : undefined;
  return { max: store.config.concurrency.max_sessions, running, waiting, ...(stepped ? { stepped_down: stepped } : {}) };
}

export function stateView(store: DataStore, engine: { mode: string; paused: boolean; ciQueue?: { queued: number; running: number }; runnerStalls?(): { label: string; items: string[]; since: string }[]; sessions(): SessionView[]; slotUsage?: Engine['slotUsage']; restartReadiness?(): { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } }, git: unknown) {
  return {
    schema: store.schema,
    readOnly: store.readOnly,
    dataDir: store.dataDir,
    codeRepo: store.codeRepoPath(),
    /** Which toolchain files the code repository has, for the allow rules Settings offers (#96). */
    toolchain: TOOLCHAINS.map((t) => t.marker).filter((m) => existsSync(join(store.codeRepoPath(), m))),
    config: store.config,
    local: publicLocal(store.local),
    permissions: permissionsView(store),
    items: store.listItems().map((i) => listedItemView(store, i)),
    prompts: store.listPrompts().map(promptView),
    releases: store.listReleases().map((r) => releaseView(store, r)),
    schedules: store.listSchedules().map((x) => scheduleView(x)),
    invalid: store.invalid,
    /** What serve --watch last found when it looked for a newer planestro (#103); absent when it never has. */
    update: readUpdateStatus(store.dataDir) ?? null,
    engine: { mode: engine.mode, paused: engine.paused, ...guardView(store, engine.paused), sessions: engine.sessions(), slots: slotsView(store, engine), ...(engine.ciQueue ? { ci_queue: engine.ciQueue } : {}), ...runnerStallsView(engine), ...(engine.restartReadiness ? { restart: engine.restartReadiness() } : {}) },
    git,
    statuses: ['NOT_YET_SUBMITTED', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED', 'FINISHED', 'ICEBOX'] satisfies Status[],
  };
}
