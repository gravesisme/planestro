import type { ItemFrontmatter, PromptFrontmatter, ReleaseFrontmatter, ReleaseStatus, Config, LocalConfig, BillingMode, ModelDef, Status, JournalEntry, UsageGuardState, QuestionFrontmatter, ThreadEntry } from '@planestro/shared';
import type { BreakdownChild } from '@planestro/shared';

export interface ItemView {
  id: string; path: string; frontmatter: ItemFrontmatter;
  sections: { Description: string; Notes: string; Plan: string; Activity: string };
  activity: { at: string; actor: string; text: string }[];
  derived: { lane: 'board' | 'icebox' | 'done'; needs_you: boolean; external: boolean; flavor: 'worker' | 'epic' | 'external'; base_branch?: string; base_branch_error?: string; deps_satisfied: boolean; children: string[] };
}
export interface ReviewImage { path: string; change: 'added' | 'modified' | 'deleted'; bytes?: number; width?: number; height?: number; kind?: 'image' | 'audio' | 'model' }
export interface PromptView { name: string; path: string; frontmatter: PromptFrontmatter; body: string; text?: string }
export interface ReleaseView { version: string; path: string; frontmatter: ReleaseFrontmatter; sections: { title: string; body: string }[]; candidates: string[] }
/** An orchestrator question (#75). The list leaves out `details` and `thread`; the question page has them. */
export interface QuestionView {
  id: string; path: string; frontmatter: QuestionFrontmatter; pending: boolean; item_title?: string; item_status?: Status;
  summary: string; recommendation: string; messages: number; last_at: string; details?: string; thread?: ThreadEntry[];
}
export interface ReleaseFields { version?: string; title?: string | null; status?: ReleaseStatus; date?: string | null; tag?: string | null; items?: string[] }
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }
export interface State {
  schema: string; readOnly: boolean; dataDir: string; codeRepo: string; config: Config;
  /** Toolchain files found in the code repository's root (package.json, Cargo.toml, …). */
  toolchain?: string[];
  /** planestro.local.yml without its secrets: the API key is never sent, only whether one is set (`api_key`). */
  local: LocalConfig;
  /** Whether budget dollars are an API-price yardstick on a Claude plan or real charges to an API account (#83). */
  billing?: BillingMode; api_key?: 'local' | 'env' | 'none';
  items: ItemView[]; prompts: PromptView[]; releases?: ReleaseView[]; invalid: { path: string; error: string }[];
  update: { channel: string; running: string; checked_at: string; state: string; detail: string; target?: string } | null;
  engine: { mode: string; paused: boolean; paused_by?: 'user' | 'usage_guard'; usage_guard?: UsageGuardState; sessions: SessionView[]; restart?: { draining: boolean; by?: 'user' | 'update'; idle: boolean; running: string[] } };
  git: { dirty: string[]; branch: string; head?: string; ahead?: number };
  statuses: Status[];
}

async function req<T>(method: string, url: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const res = await fetch(url, { method, headers: raw ? undefined : { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  state: () => req<State>('GET', '/api/state'),
  createItem: (body: { title: string; category?: string; description?: string; kind?: 'item' | 'epic'; planner?: string; parent?: string; implementer?: string; status?: 'NOT_YET_SUBMITTED' | 'ICEBOX'; auto_approve_plan?: boolean; allow_model_fallback?: boolean }) => req<ItemView>('POST', '/api/items', body),
  patchItem: (id: string, body: { fields?: Record<string, unknown>; sections?: Record<string, string> }) => req<ItemView>('PATCH', `/api/items/${id}`, body),
  deleteItem: (id: string) => req<{ ok: true }>('DELETE', `/api/items/${id}`),
  move: (id: string, op: 'top' | 'bottom' | 'before' | 'after' | 'icebox' | 'backlog', ref?: string) => req<ItemView>('POST', `/api/items/${id}/move`, { op, ref }),
  itemConsole: (id: string) => req<{ lines: string[] }>('GET', `/api/items/${id}/console`),
  transitions: (id: string) => req<{ to: Status; label: string }[]>('GET', `/api/items/${id}/transitions`),
  transition: (id: string, to: Status, reason?: string) => req<ItemView>('POST', `/api/items/${id}/transition`, { to, reason }),
  reviewImages: (id: string) => req<ReviewImage[]>('GET', `/api/items/${id}/images`),
  requestReviewChanges: (id: string, note: string) => req<ItemView>('POST', `/api/items/${id}/review/changes`, { note }),
  releaseHold: (id: string, note?: string) => req<ItemView>('POST', `/api/items/${id}/hold/release`, { note }),
  approveBreakdown: (id: string, children: BreakdownChild[], queue: boolean) => req<{ created: string[]; item: ItemView }>('POST', `/api/items/${id}/breakdown/approve`, { children, queue }),
  /** `hold`: its pull request stays out of the merge queue until released, for this reason (#97). */
  approvePlan: (id: string, notes?: string, asItem?: boolean, hold?: string) => req<ItemView>('POST', `/api/items/${id}/plan/approve`, { notes, ...(asItem ? { as_item: true } : {}), ...(hold?.trim() ? { hold: hold.trim() } : {}) }),
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
  putConfig: (body: Record<string, unknown>) => req<{ config: Config }>('PUT', '/api/config', body),
  putLocal: (body: Record<string, unknown>) => req<{ local: LocalConfig }>('PUT', '/api/config/local', body),
  putModel: (id: string, model: Partial<ModelDef>) => req<{ config: Config }>('PUT', `/api/config/models/${encodeURIComponent(id)}`, model),
  removeModel: (id: string) => req<{ config: Config }>('DELETE', `/api/config/models/${encodeURIComponent(id)}`),
  testNotification: (event: 'on_merge' | 'on_usage_pause') => req<{ code: number; output: string }>('POST', '/api/config/notifications/test', { event }),
  markModelUnavailable: (id: string, until: string, reason?: string) => req<{ local: LocalConfig }>('PUT', `/api/models/${encodeURIComponent(id)}/unavailable`, { until, reason }),
  clearModelUnavailable: (id: string) => req<{ local: LocalConfig }>('DELETE', `/api/models/${encodeURIComponent(id)}/unavailable`),
  categories: (body: Record<string, string>) => req<{ config: Config; affected: number }>('POST', '/api/config/categories', body),
  pause: () => req<{ paused: boolean }>('POST', '/api/engine/pause'),
  drain: () => req<{ draining: boolean; idle: boolean; running: string[] }>('POST', '/api/engine/drain'),
  undrain: () => req<{ draining: boolean; idle: boolean; running: string[] }>('DELETE', '/api/engine/drain'),
  resume: () => req<{ paused: boolean }>('POST', '/api/engine/resume'),
  journal: (q: { item?: string; limit?: number }) => req<JournalEntry[]>('GET', `/api/journal?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  reload: () => req<{ ok: true }>('POST', '/api/reload'),
  reconcile: () => req<{ corrections: string[] }>('POST', '/api/reconcile'),
  queueOrder: (ids: string[]) => req<{ ok: true }>('POST', '/api/queue/order', { ids }),
  resumeAfter: (id: string, items: string[], message: string) => req<ItemView>('POST', `/api/items/${encodeURIComponent(id)}/resume-after`, { items, message }),
  cancelResumeAfter: (id: string) => req<ItemView>('DELETE', `/api/items/${encodeURIComponent(id)}/resume-after`),
  orchestratorMessage: (text: string, item?: string) => req<{ ok: true }>('POST', '/api/orchestrator/message', { text, item }),
  orchestratorChat: () => req<{ enabled: boolean; entries: JournalEntry[] }>('GET', '/api/orchestrator/chat'),
  orchestratorQuestions: () => req<JournalEntry[]>('GET', '/api/orchestrator/questions'),
  questions: (status?: 'open' | 'resolved' | 'withdrawn') => req<QuestionView[]>('GET', `/api/questions${status ? `?status=${status}` : ''}`),
  question: (id: string) => req<QuestionView>('GET', `/api/questions/${encodeURIComponent(id)}`),
  postToQuestion: (id: string, text: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/messages`, { text }),
  reviewQuestion: (id: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/review`),
  reviewAllQuestions: () => req<{ reviewing: string[] }>('POST', '/api/questions/review-all'),
  resolveQuestion: (id: string, status: 'resolved' | 'withdrawn' = 'resolved', resolution?: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/resolve`, { status, resolution }),
  reopenQuestion: (id: string) => req<QuestionView>('POST', `/api/questions/${encodeURIComponent(id)}/reopen`),
  orchestratorNotes: () => req<JournalEntry[]>('GET', '/api/orchestrator/notes'),
  gitCommit: () => req<{ committed: boolean }>('POST', '/api/git/commit'),
  gitPush: () => req<{ pushed: boolean }>('POST', '/api/git/push'),
};
