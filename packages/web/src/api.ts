import type { ItemFrontmatter, PromptFrontmatter, Config, LocalConfig, Status, JournalEntry } from '@planestro/shared';

export interface ItemView {
  id: string; path: string; frontmatter: ItemFrontmatter;
  sections: { Description: string; Notes: string; Plan: string; Activity: string };
  activity: { at: string; actor: string; text: string }[];
  derived: { lane: 'board' | 'icebox' | 'done'; needs_you: boolean; external: boolean; flavor: 'worker' | 'epic' | 'external'; base_branch?: string; base_branch_error?: string; deps_satisfied: boolean; children: string[] };
}
export interface PromptView { name: string; path: string; frontmatter: PromptFrontmatter; body: string }
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }
export interface State {
  schema: string; readOnly: boolean; dataDir: string; codeRepo: string; config: Config; local: LocalConfig;
  items: ItemView[]; prompts: PromptView[]; invalid: { path: string; error: string }[];
  engine: { mode: string; paused: boolean; sessions: SessionView[] };
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
  createItem: (body: { title: string; category?: string; description?: string; kind?: 'item' | 'epic'; parent?: string; status?: 'NOT_YET_SUBMITTED' | 'ICEBOX' }) => req<ItemView>('POST', '/api/items', body),
  patchItem: (id: string, body: { fields?: Record<string, unknown>; sections?: Record<string, string> }) => req<ItemView>('PATCH', `/api/items/${id}`, body),
  deleteItem: (id: string) => req<{ ok: true }>('DELETE', `/api/items/${id}`),
  move: (id: string, op: 'top' | 'bottom' | 'before' | 'after' | 'icebox' | 'backlog', ref?: string) => req<ItemView>('POST', `/api/items/${id}/move`, { op, ref }),
  transitions: (id: string) => req<{ to: Status; label: string }[]>('GET', `/api/items/${id}/transitions`),
  transition: (id: string, to: Status) => req<ItemView>('POST', `/api/items/${id}/transition`, { to }),
  approvePlan: (id: string, notes?: string) => req<ItemView>('POST', `/api/items/${id}/plan/approve`, { notes }),
  rejectPlan: (id: string, message: string) => req<ItemView>('POST', `/api/items/${id}/plan/reject`, { message }),
  message: (id: string, text: string) => req<{ ok: true }>('POST', `/api/items/${id}/message`, { text }),
  unblock: (id: string, message?: string) => req<ItemView>('POST', `/api/items/${id}/unblock`, { message }),
  respond: (id: string, payload: Record<string, unknown>) => req<{ ok: true }>('POST', `/api/items/${id}/respond`, payload),
  uploadAttachment: (id: string, file: File) => { const fd = new FormData(); fd.append('file', file, file.name); return req<{ path: string }>('POST', `/api/items/${id}/attachments`, undefined, fd); },
  referenceAttachment: (id: string, path: string) => req<{ path: string }>('POST', `/api/items/${id}/attachments`, { path }),
  removeAttachment: (id: string, path: string) => req<{ ok: true }>('DELETE', `/api/items/${id}/attachments?path=${encodeURIComponent(path)}`),
  putPrompt: (name: string, text: string) => req<PromptView>('PUT', `/api/prompts/${name}`, { text }),
  deletePrompt: (name: string) => req<{ ok: true }>('DELETE', `/api/prompts/${name}`),
  renderPrompt: (name: string, itemId?: string) => req<{ text: string }>('POST', `/api/prompts/${name}/render`, { itemId }),
  putConfig: (body: Record<string, Record<string, unknown>>) => req<{ config: Config }>('PUT', '/api/config', body),
  putLocal: (body: Record<string, string>) => req<{ local: LocalConfig }>('PUT', '/api/config/local', body),
  categories: (body: Record<string, string>) => req<{ config: Config; affected: number }>('POST', '/api/config/categories', body),
  pause: () => req<{ paused: boolean }>('POST', '/api/engine/pause'),
  resume: () => req<{ paused: boolean }>('POST', '/api/engine/resume'),
  journal: (q: { item?: string; limit?: number }) => req<JournalEntry[]>('GET', `/api/journal?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  reload: () => req<{ ok: true }>('POST', '/api/reload'),
  gitCommit: () => req<{ committed: boolean }>('POST', '/api/git/commit'),
  gitPush: () => req<{ pushed: boolean }>('POST', '/api/git/push'),
};
