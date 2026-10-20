import type { EngineModes } from './engineMode.ts';
import type { ConcurrencyAdvice, ConcurrencyChange, ConcurrencyGuard, ConcurrencyLimits, HostLoad, ItemFrontmatter, PromptFrontmatter, ReleaseFrontmatter, ReleaseStatus, Config, LocalConfig, ModelDef, Status, JournalEntry, UsageGuardState, QuestionFrontmatter, ThreadEntry, ScheduleFrontmatter, UsageReport, ItemEfficiency, EfficiencyRanking, CiAggregates } from '@planestro/shared';
import type { BreakdownChild, Priority, SourcedRule } from '@planestro/shared';

export interface OrchestratorSpend {
  wakes: { at: string; events: string[]; items: string[]; cost: number; runner?: string; tokens?: number; token_cap?: number; context_tokens?: number; model?: string; session?: string; wake?: number; fresh: boolean; summary: string; failed: boolean }[];
  today: { wakes: number; cost: number };
  conversation: { wakes: number; runner?: string; tokens?: number; cost: number; context_tokens?: number } | null;
}

/** Allow rules suggested from the ruling history (#169): see packages/server/src/engine/allowSuggest.ts. */
export interface AllowSuggestReport {
  rulings: number; allowed: number; denied: number;
  suggestions: { rule: string; shape: string; class: string; approvals: number; items: number; unlocks: number; examples: string[] }[];
  refused: { rule: string; approvals: number; denied: { item: string; at: string; command: string; reason?: string }[] }[];
  replay: { current: { allowed_now: number; still_parks: number; false_allows: number }; proposed: { allowed_now: number; still_parks: number; false_allows: number } };
  current_false_allows: { item: string; at: string; command: string }[];
  /** Kinds of command denied every time (#203): refused up front with this reason, they would not park. Reported only. */
  redirects?: { rule: string; shape: string; class: string; denials: number; items: number; message: string; examples: string[]; snippet: string }[];
  drift?: { window_days: number; recorded_since?: string; runs: number; idle_rules: { rule: string; last_matched?: string }[]; rising: { shape: string; class: string; recent: number; before: number; items: number; rule?: string }[] };
}

/** An orchestrator note about planestro and what became of it (#231): the issues it was filed as, or handled by hand. */
export type NoteView = JournalEntry & { links?: { issues: { number: number; url?: string }[]; handled: boolean; comments: string[] } };
export type FileNoteOutcome =
  | { outcome: 'filed' | 'linked'; issue: { number: number; url?: string } }
  | { outcome: 'candidates'; candidates: { number: number; title: string; url: string; state: string }[] };

/** A change to one MCP server (#237): `env` / `headers` set a value, `null` removes it, '' keeps it. */
export interface McpServerBody { command?: string | null; args?: string[]; url?: string | null; env?: Record<string, string | null>; headers?: Record<string, string | null>; enabled?: boolean }
/** A server an import could bring in: names only, never a key's value. */
export interface McpImportCandidate { source: string; name: string; kind: 'stdio' | 'http'; command?: string; url?: string; env: string[]; headers: string[]; status: 'new' | 'present' | 'duplicate' | 'removed' | 'unsupported'; note?: string }
/** The project's open GitHub issues, for Import issues (#231): each with the item already imported from it. */
export interface ImportableIssues { repo: string; label?: string; issues: { number: number; title: string; url: string; labels: string[]; item?: string }[] }
export interface ImportIssuesResult { repo: string; imported: { issue: number; item: string; title: string }[]; skipped: { issue: number; reason: string; item?: string }[] }

export interface ParkSummary { item: string; parks: number; waited_ms: number; resume_cost: number; open: number; shapes: { shape: string; parks: number; rule?: string }[] }

export interface ItemView {
  id: string; path: string; frontmatter: ItemFrontmatter;
  sections: { Description: string; Notes: string; Plan: string; Activity: string };
  activity: { at: string; actor: string; text: string }[];
  /** A parked Bash request whose kind of command this item has parked on before: the allow rule that would have let it run (#108). */
  park_hint?: { shape: string; parks: number; rule: string } | null;
  /** Items merged into its base since its plan was cut (#217): approving syncs the branch with the base first. */
  merged_since_cut?: string[];
  /** Set on a done or iceboxed item in /api/state: no Plan, Activity text or `delivered`, and only its newest Activity. `useFullItem` loads the rest. */
  summary?: true;
  derived: { lane: 'board' | 'icebox' | 'done'; needs_you: boolean; external: boolean; flavor: 'worker' | 'epic' | 'external'; base_branch?: string; base_branch_error?: string; deps_satisfied: boolean; children: string[] };
}
export interface ReviewImage { path: string; change: 'added' | 'modified' | 'deleted'; bytes?: number; width?: number; height?: number; kind?: 'image' | 'audio' | 'model' | 'text' }
/** One changed file's unified diff against the base (#233). */
export interface ReviewDiff { path: string; change: ReviewImage['change']; patch: string; binary: boolean; truncated: boolean }
/** What Undo last turn would discard (#234), or why it cannot be undone (`refusal`). */
export interface UndoTurnPreview { refusal: string | null; turn?: number; at?: string; head?: string; files?: { path: string; change: ReviewImage['change'] }[]; patch?: string; truncated?: boolean; commits?: string; expect?: string }
export interface PromptView { name: string; path: string; frontmatter: PromptFrontmatter; body: string; text?: string }
export interface ReleaseView { version: string; path: string; frontmatter: ReleaseFrontmatter; sections: { title: string; body: string }[]; candidates: string[] }
/** An orchestrator question (#75). The list leaves out `details` and `thread`; the question page has them. */
export interface QuestionView {
  id: string; path: string; frontmatter: QuestionFrontmatter; pending: boolean; item_title?: string; item_status?: Status;
  summary: string; recommendation: string; messages: number; last_at: string; closed_by?: 'you' | 'orchestrator' | 'planestro'; details?: string; thread?: ThreadEntry[];
}
/** A schedule (#247): its template, and when it next files an item (null while it is off). */
export interface ScheduleView { name: string; path: string; frontmatter: ScheduleFrontmatter; description: string; next_run: string | null }
export interface ScheduleFields { title?: string; description?: string; cron?: string; tz?: string; enabled?: boolean; skip_if_open?: boolean; submit?: boolean; kind?: 'item' | 'epic'; category?: string | null; priority?: Priority | null }
export interface ReleaseFields { version?: string; title?: string | null; status?: ReleaseStatus; date?: string | null; tag?: string | null; items?: string[] }
/** One project on this machine as the all-projects page shows it (#235): see packages/server/src/projects.ts. */
export interface ProjectRow {
  name: string; data_dir: string; self: boolean; reach: 'self' | 'ok' | 'unreachable' | 'not_running';
  url?: string; host?: string; port?: number; error?: string;
  summary?: { needs_you: number; blocked: number; in_review: number; running: number; mode?: string; paused: boolean; paused_by?: string; read_only: boolean; guards: { provider: string; window: string; status: string; resume_at?: string; resets_at?: string }[] };
}
/** "N of M" agents and what waits for a session slot (#330); `stepped_down` while the engine's auto-step-down is the last change. */
export interface SlotsView { max: number; running: number; waiting: number; stepped_down?: ConcurrencyChange }
/** The concurrency control's reading (#330): the limits, this machine, recent CI and the recommendation. */
export interface ConcurrencyView {
  limits: ConcurrencyLimits & { max_local_jobs: number };
  slots: { max: number; running: number; waiting: number; runners: Record<string, { running: number; waiting: number }> };
  host: HostLoad | null;
  ci_runner: { state: 'busy' | 'idle' | 'unknown'; labels: string[]; detail: string[] };
  advice: ConcurrencyAdvice;
  guard: ConcurrencyGuard;
  last_change: ConcurrencyChange | null;
  rollback: ConcurrencyLimits | null;
}
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }
export interface State {
  schema: string; readOnly: boolean; dataDir: string; codeRepo: string; config: Config;
  /** Toolchain files found in the code repository's root (package.json, Cargo.toml, …). */
  toolchain?: string[];
  /** planestro.local.yml without its secrets: MCP servers' keys are never sent, only that they are set. */
  local: LocalConfig;
  /** Every allow / deny rule workers run under, with where it came from: ~/.planestro/policy.yml, planestro.yml, planestro.local.yml (#229). */
  permissions?: { machine_path: string; machine_exists: boolean; machine_error?: string; rules: SourcedRule[] };
  items: ItemView[]; prompts: PromptView[]; releases?: ReleaseView[]; schedules?: ScheduleView[]; invalid: { path: string; error: string }[];
  update: { channel: string; running: string; checked_at: string; state: string; detail: string; target?: string } | null;
  engine: { mode: string; modes?: EngineModes; paused: boolean; paused_by?: 'user' | 'disk'; provider_guards?: Record<string, UsageGuardState>; disk_guard?: { free_gib: number; path: string; tripped_at: string }; ci_queue?: { queued: number; running: number }; runner_stalls?: { label: string; items: string[]; since: string }[]; sessions: SessionView[]; slots?: SlotsView; restart?: { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } };
  git: { dirty: string[]; branch: string; head?: string; ahead?: number };
  statuses: Status[];
}

/** A /api/state body worth drawing. A resumed iPhone web app can get a 200 whose body does not parse, which `req` reads as `{}`: stored, it crashed every page on `state.config.project` (#342). */
export function isState(s: unknown): s is State {
  const v = s as Partial<State> | null;
  return typeof v === 'object' && v !== null && typeof v.config?.project?.name === 'string' && Array.isArray(v.items);
}

/** A response whose body could not be read (cut off by a restart or a dropped connection, #350): the request failed, and asking again may work. */
export class UnreadableResponse extends Error { readonly retryable = true; }

export async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(url, { method, headers: raw ? undefined : { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  let text: string | undefined;
  try { text = await res.text(); } catch { /* cut off mid-body */ }
  let data: unknown = {};
  let unreadable = text === undefined;
  if (text?.trim()) try { data = JSON.parse(text); } catch { unreadable = true; }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  // Never `{}` in place of what the caller asked for: one bad answer would reach a list as an object (#350).
  if (unreadable) throw new UnreadableResponse(`the server sent an unreadable answer to ${method} ${url}; it will be asked again`);
  return data as T;
}

export const api = {
  previewProviderSwitch: (body: unknown) => req<any>('POST', '/api/providers/preview', body),
  applyProviderSwitch: (body: unknown) => req<any>('POST', '/api/providers/apply', body),
  orchestratorSelection: () => req<{ configured?: string; current?: string; pending?: boolean }>('GET', '/api/orchestrator/selection'),
  retryProvider: (runner: string) => req('POST', `/api/providers/${runner}/retry`),
  state: async () => { const s = await req<unknown>('GET', '/api/state'); if (!isState(s)) throw new Error('the server sent an unreadable state'); return s; },
  projects: () => req<{ projects: ProjectRow[] }>('GET', '/api/projects'),
  createItem: (body: { title: string; category?: string; priority?: Priority; description?: string; kind?: 'item' | 'epic'; planner?: string; parent?: string; implementer?: string; status?: 'NOT_YET_SUBMITTED' | 'ICEBOX'; auto_approve_plan?: boolean; allow_model_fallback?: boolean }) => req<ItemView>('POST', '/api/items', body),
  patchItem: (id: string, body: { fields?: Record<string, unknown>; sections?: Record<string, string> }) => req<ItemView>('PATCH', `/api/items/${id}`, body),
  deleteItem: (id: string) => req<{ ok: true }>('DELETE', `/api/items/${id}`),
  move: (id: string, op: 'top' | 'bottom' | 'before' | 'after' | 'icebox' | 'backlog', ref?: string) => req<ItemView>('POST', `/api/items/${id}/move`, { op, ref }),
  item: (id: string) => req<ItemView>('GET', `/api/items/${id}`),
  itemConsole: (id: string) => req<{ lines: string[] }>('GET', `/api/items/${id}/console`),
  transitions: (id: string) => req<{ to: Status; label: string }[]>('GET', `/api/items/${id}/transitions`),
  transition: (id: string, to: Status, reason?: string) => req<ItemView>('POST', `/api/items/${id}/transition`, { to, reason }),
  rerunCi: (id: string) => req<{ said: string }>('POST', `/api/items/${id}/rerun-ci`),
  reopenPr: (id: string) => req<{ said: string }>('POST', `/api/items/${id}/reopen-pr`),
  discardPreview: (id: string) => req<{ refusal: string | null; branch?: string; remote_sha: string | null; pr?: number }>('GET', `/api/items/${id}/discard`),
  discard: (id: string, reason: string, deleteBranch: boolean, expectSha?: string) => req<{ said: string; item: ItemView }>('POST', `/api/items/${id}/discard`, { reason, delete_branch: deleteBranch, ...(expectSha ? { expect_sha: expectSha } : {}) }),
  undoTurnPreview: (id: string) => req<UndoTurnPreview>('GET', `/api/items/${id}/undo-turn`),
  undoTurn: (id: string, expect: string) => req<{ said: string; item: ItemView }>('POST', `/api/items/${id}/undo-turn`, { expect }),
  reviewImages: (id: string) => req<ReviewImage[]>('GET', `/api/items/${id}/images`),
  reviewDiff: (id: string, path: string) => req<ReviewDiff>('GET', `/api/items/${id}/diff?path=${encodeURIComponent(path)}`),
  requestReviewChanges: (id: string, note: string) => req<ItemView>('POST', `/api/items/${id}/review/changes`, { note }),
  releaseHold: (id: string, note?: string) => req<ItemView>('POST', `/api/items/${id}/hold/release`, { note }),
  approveBreakdown: (id: string, children: BreakdownChild[], queue: boolean) => req<{ created: string[]; item: ItemView }>('POST', `/api/items/${id}/breakdown/approve`, { children, queue }),
  addChildren: (id: string, children: BreakdownChild[], queue: boolean) => req<{ created: string[]; item: ItemView }>('POST', `/api/items/${id}/children`, { children, queue }),
  /** `hold`: its pull request stays out of the merge queue until released, for this reason (#97). */
  reviewPlanAgain: (id: string) => req<{ said: string }>('POST', `/api/items/${id}/plan/review`),
  approvePlan: (id: string, notes?: string, asItem?: boolean, hold?: string, mcpBudget?: number) => req<ItemView>('POST', `/api/items/${id}/plan/approve`, { notes, ...(asItem ? { as_item: true } : {}), ...(hold?.trim() ? { hold: hold.trim() } : {}), ...(mcpBudget !== undefined ? { mcp_budget: mcpBudget } : {}) }),
  convertKind: (id: string, to: 'item' | 'epic', reason?: string) => req<ItemView>('POST', `/api/items/${id}/convert`, { to, reason }),
  rejectPlan: (id: string, message: string) => req<ItemView>('POST', `/api/items/${id}/plan/reject`, { message }),
  message: (id: string, text: string) => req<{ ok: true }>('POST', `/api/items/${id}/message`, { text }),
  epicAction: (id: string, action: 'open' | 'submit' | 'sync') => req<ItemView>('POST', `/api/items/${id}/epic/${action}`, {}),
  takeOver: (id: string, note?: string) => req<ItemView>('POST', `/api/items/${id}/take-over`, { note }),
  handBack: (id: string, note?: string) => req<ItemView>('POST', `/api/items/${id}/hand-back`, { note }),
  finishFromWorktree: (id: string) => req<ItemView>('POST', `/api/items/${id}/finish`),
  syncWithBase: (id: string) => req<ItemView & { result: string }>('POST', `/api/items/${id}/sync`, {}),
  unblock: (id: string, message?: string, fresh?: boolean) => req<ItemView>('POST', `/api/items/${id}/unblock`, { message, ...(fresh ? { fresh: true } : {}) }),
  decide: (id: string, body: { choice?: string; text?: string }) => req<ItemView>('POST', `/api/items/${id}/decision`, body),
  respond: (id: string, payload: Record<string, unknown>) => req<{ ok: true }>('POST', `/api/items/${id}/respond`, payload),
  uploadAttachment: (id: string, file: File) => { const fd = new FormData(); fd.append('file', file, file.name); return req<{ path: string }>('POST', `/api/items/${id}/attachments`, undefined, fd); },
  referenceAttachment: (id: string, path: string) => req<{ path: string }>('POST', `/api/items/${id}/attachments`, { path }),
  removeAttachment: (id: string, path: string) => req<{ ok: true }>('DELETE', `/api/items/${id}/attachments?path=${encodeURIComponent(path)}`),
  createPrompt: (body: { name: string; title: string; kind: 'template' | 'action' | 'partial'; description?: string; body: string }) => req<PromptView>('POST', '/api/prompts', body),
  favoritePrompt: (name: string, favorite: boolean) => req<PromptView>('POST', `/api/prompts/${name}/favorite`, { favorite }),
  putPrompt: (name: string, text: string) => req<PromptView>('PUT', `/api/prompts/${name}`, { text }),
  deletePrompt: (name: string) => req<{ ok: true }>('DELETE', `/api/prompts/${name}`),
  renderPrompt: (name: string, itemId?: string) => req<{ text: string }>('POST', `/api/prompts/${name}/render`, { itemId }),
  createRelease: (body: { version: string; title?: string; date?: string }) => req<ReleaseView>('POST', '/api/releases', body),
  patchRelease: (version: string, body: { fields?: ReleaseFields; sections?: Record<string, string> }) => req<ReleaseView>('PATCH', `/api/releases/${encodeURIComponent(version)}`, body),
  deleteRelease: (version: string) => req<{ ok: true }>('DELETE', `/api/releases/${encodeURIComponent(version)}`),
  createSchedule: (body: ScheduleFields & { name: string; title: string; cron: string; tz: string }) => req<ScheduleView>('POST', '/api/schedules', body),
  patchSchedule: (name: string, fields: ScheduleFields) => req<ScheduleView>('PATCH', `/api/schedules/${encodeURIComponent(name)}`, fields),
  deleteSchedule: (name: string) => req<{ ok: true }>('DELETE', `/api/schedules/${encodeURIComponent(name)}`),
  putConfig: (body: Record<string, unknown>) => req<{ config: Config }>('PUT', '/api/config', body),
  concurrency: () => req<ConcurrencyView>('GET', '/api/concurrency'),
  putConcurrency: (body: { max_sessions?: number; runner_limits?: Record<string, number>; reason?: string; confirm?: boolean }) => req<ConcurrencyView>('PUT', '/api/concurrency', body),
  rollbackConcurrency: (body: { reason?: string; confirm?: boolean }) => req<ConcurrencyView>('POST', '/api/concurrency/rollback', body),
  putLocal: (body: Record<string, unknown>) => req<{ local: LocalConfig }>('PUT', '/api/config/local', body),
  putModel: (id: string, model: Partial<ModelDef>) => req<{ config: Config }>('PUT', `/api/config/models/${encodeURIComponent(id)}`, model),
  removeModel: (id: string) => req<{ config: Config }>('DELETE', `/api/config/models/${encodeURIComponent(id)}`),
  testNotification: (event: 'on_merge' | 'on_usage_pause' | 'on_needs_you') => req<{ code: number; output: string }>('POST', '/api/config/notifications/test', { event }),
  putMcpServer: (name: string, body: McpServerBody) => req<{ local: LocalConfig }>('PUT', `/api/config/mcp-servers/${encodeURIComponent(name)}`, body),
  removeMcpServer: (name: string) => req<{ local: LocalConfig }>('DELETE', `/api/config/mcp-servers/${encodeURIComponent(name)}`),
  testMcpServer: (name: string) => req<{ ok: true; tools: string[] } | { ok: false; error: string }>('POST', `/api/config/mcp-servers/${encodeURIComponent(name)}/test`),
  mcpImportCandidates: () => req<{ candidates: McpImportCandidate[] }>('GET', '/api/config/mcp-servers/import'),
  importMcpServers: (pick?: string[]) => req<{ local: LocalConfig; added: string[] }>('POST', '/api/config/mcp-servers/import', { pick }),
  pairingCode: () => req<{ code: string; expires_at: string }>('POST', '/api/pairing/code'),
  revokeDevice: (id: string) => req<{ devices: { id: string; name: string; created_at: string }[] }>('DELETE', `/api/pairing/devices/${encodeURIComponent(id)}`),
  markModelUnavailable: (id: string, until: string, reason?: string) => req<{ local: LocalConfig }>('PUT', `/api/models/${encodeURIComponent(id)}/unavailable`, { until, reason }),
  clearModelUnavailable: (id: string) => req<{ local: LocalConfig }>('DELETE', `/api/models/${encodeURIComponent(id)}/unavailable`),
  categories: (body: { op: 'add'; name: string; color?: string } | { op: 'rename'; from: string; to: string } | { op: 'remove'; name: string; reassign_to: string } | { op: 'default' | 'color'; name: string; color?: string }) => req<{ config: Config; affected: number }>('POST', '/api/config/categories', body),
  pause: () => req<{ paused: boolean }>('POST', '/api/engine/pause'),
  drain: () => req<{ draining: boolean; idle: boolean; running: string[] }>('POST', '/api/engine/drain'),
  undrain: () => req<{ draining: boolean; idle: boolean; running: string[] }>('DELETE', '/api/engine/drain'),
  resume: () => req<{ paused: boolean }>('POST', '/api/engine/resume'),
  usage: (days: number) => req<UsageReport>('GET', `/api/usage?days=${days}`),
  usageItems: (days: number) => req<EfficiencyRanking>('GET', `/api/usage/items?days=${days}`),
  usageCi: (days: number) => req<CiAggregates>('GET', `/api/usage/ci?days=${days}`),
  itemEfficiency: (id: string) => req<ItemEfficiency>('GET', `/api/items/${encodeURIComponent(id)}/efficiency`),
  orchestratorSpend: () => req<OrchestratorSpend>('GET', '/api/orchestrator/spend'),
  parks: () => req<ParkSummary[]>('GET', '/api/parks'),
  allowSuggest: () => req<AllowSuggestReport>('GET', '/api/permissions/suggest'),
  journal: (q: { item?: string; limit?: number }) => req<JournalEntry[]>('GET', `/api/journal?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  reload: () => req<{ ok: true }>('POST', '/api/reload'),
  reconcile: () => req<{ corrections: string[] }>('POST', '/api/reconcile'),
  queueOrder: (ids: string[]) => req<{ ok: true }>('POST', '/api/queue/order', { ids }),
  resumeAfter: (id: string, items: string[], message: string, prs: number[] = []) => req<ItemView>('POST', `/api/items/${encodeURIComponent(id)}/resume-after`, { items, message, prs }),
  cancelResumeAfter: (id: string) => req<ItemView>('DELETE', `/api/items/${encodeURIComponent(id)}/resume-after`),
  orchestratorMessage: (text: string, item?: string, files: File[] = []) => {
    if (!files.length) return req<{ ok: true }>('POST', '/api/orchestrator/message', { text, item });
    const fd = new FormData(); fd.append('text', text); if (item) fd.append('item', item);
    for (const f of files) fd.append('file', f, f.name);
    return req<{ ok: true }>('POST', '/api/orchestrator/message', undefined, fd);
  },
  orchestratorChat: () => req<{ enabled: boolean; entries: JournalEntry[] }>('GET', '/api/orchestrator/chat'),
  orchestratorQuestions: () => req<JournalEntry[]>('GET', '/api/orchestrator/questions'),
  questions: (status?: 'open' | 'resolved' | 'withdrawn') => req<QuestionView[]>('GET', `/api/questions${status ? `?status=${status}` : ''}`),
  question: (id: string) => req<QuestionView>('GET', `/api/questions/${encodeURIComponent(id)}`),
  postToQuestion: (id: string, text: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/messages`, { text }),
  reviewQuestion: (id: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/review`),
  reviewAllQuestions: () => req<{ reviewing: string[] }>('POST', '/api/questions/review-all'),
  resolveQuestion: (id: string, status: 'resolved' | 'withdrawn' = 'resolved', resolution?: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/resolve`, { status, resolution }),
  reopenQuestion: (id: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/reopen`),
  orchestratorNotes: () => req<NoteView[]>('GET', '/api/orchestrator/notes'),
  notesSeen: () => req<{ seen: string }>('GET', '/api/orchestrator/notes/seen'),
  markNotesSeen: (upTo: string) => req<{ seen: string }>('POST', '/api/orchestrator/notes/seen', { up_to: upTo }),
  importableIssues: () => req<ImportableIssues>('GET', '/api/issues/importable'),
  importIssues: (body: { issues?: number[]; label?: string; closes?: boolean }) => req<ImportIssuesResult>('POST', '/api/issues/import', body),
  fileNote: (note: string, force?: boolean) => req<FileNoteOutcome>('POST', '/api/orchestrator/notes/file', { note, ...(force ? { force: true } : {}) }),
  markNotes: (links: { note: string; issues?: number[]; handled?: boolean; comment?: string }[]) => req<{ ok: true }>('POST', '/api/orchestrator/notes/mark', { links }),
  gitCommit: () => req<{ committed: boolean }>('POST', '/api/git/commit'),
  gitPush: () => req<{ pushed: boolean }>('POST', '/api/git/push'),
};
