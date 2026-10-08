import { basename } from 'node:path';
import { readRegistry, type RegisteredProject } from './config.ts';
import { commandOf, listInstances, localUrl, servesDataDir, unrecordedHolder } from './instances.ts';

// ---- the all-projects overview (#235) ----
// Each project runs its own server, so nothing showed them together. Any instance can list them all: the project
// registry (~/.planestro/projects.yml) names the projects, the instance records (and, for a server started with
// plain `serve`, its data dir's lock) say where each one listens, and this server asks each of them for its
// /api/state with a short timeout. Read-only: nothing here acts on another project, and a server that does not
// answer is shown unreachable rather than failing the page.

export interface Address { url: string; host: string; port: number }
export interface GuardSummary { provider: string; window: string; status: string; resume_at?: string; resets_at?: string }
export interface ProjectSummary {
  name?: string; needs_you: number; blocked: number; in_review: number; running: number;
  mode?: string; paused: boolean; paused_by?: string; read_only: boolean; guards: GuardSummary[];
}
export interface ProjectRow {
  name: string; data_dir: string; self: boolean;
  /** self: this server; ok: its server answered; unreachable: it is recorded as running but did not answer; not_running: no server found. */
  reach: 'self' | 'ok' | 'unreachable' | 'not_running';
  url?: string; host?: string; port?: number; error?: string; summary?: ProjectSummary;
}
export interface OverviewDeps {
  registry: () => RegisteredProject[];
  instances: () => (Address & { data_dir: string })[];
  /** Where a planestro that `start` did not record serves this data dir, when one does. */
  unrecorded: (dataDir: string) => Address | undefined;
  fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  timeoutMs: number;
}

/** The registry, the live instance records and the data-dir locks of this machine, read without pruning anything. */
export const liveOverviewDeps = (): OverviewDeps => ({
  registry: () => { try { return readRegistry(); } catch { return []; } },
  instances: () => listInstances({ prune: false }).live,
  unrecorded: (dataDir) => {
    const pid = unrecordedHolder(dataDir);
    const command = pid ? commandOf(pid) : undefined;
    if (!command || !servesDataDir(command, dataDir)) return undefined;
    const port = Number(/--port[= ](\d+)/.exec(command)?.[1] ?? 4300);
    const host = /--host[= ](\S+)/.exec(command)?.[1] ?? '127.0.0.1';
    return { url: localUrl(host, port), host, port };
  },
  fetch: (url, init) => fetch(url, init),
  timeoutMs: 2500,
});

/** What the overview shows of one project's /api/state; it reads it loosely, since another instance may run another version. */
export function summarizeState(state: any): ProjectSummary {
  const items: any[] = Array.isArray(state?.items) ? state.items : [];
  const board = items.filter((i) => i?.derived?.lane === 'board');
  const e = state?.engine ?? {};
  return {
    ...(state?.config?.project?.name ? { name: String(state.config.project.name) } : {}),
    // As the header's "Needs you" counts them: the board's items waiting on a person.
    needs_you: board.filter((i) => i.derived.needs_you).length,
    blocked: board.filter((i) => i.frontmatter?.blocked).length,
    in_review: items.filter((i) => i?.frontmatter?.status === 'IN_REVIEW').length,
    running: Array.isArray(e.sessions) ? e.sessions.filter((s: any) => s?.busy).length : 0,
    ...(e.mode ? { mode: String(e.mode) } : {}),
    paused: Boolean(e.paused), ...(e.paused && e.paused_by ? { paused_by: String(e.paused_by) } : {}),
    read_only: Boolean(state?.readOnly),
    guards: Object.entries((e.provider_guards ?? {}) as Record<string, any>).map(([provider, g]) => ({
      provider, window: String(g?.window ?? ''), status: String(g?.status ?? ''),
      ...(g?.resume_at ? { resume_at: String(g.resume_at) } : {}), ...(g?.resets_at ? { resets_at: String(g.resets_at) } : {}),
    })),
  };
}

async function ask(at: Address, deps: OverviewDeps): Promise<Pick<ProjectRow, 'reach' | 'error' | 'summary'>> {
  try {
    const r = await deps.fetch(`${at.url}/api/state`, { signal: AbortSignal.timeout(deps.timeoutMs) });
    if (!r.ok) return { reach: 'unreachable', error: `HTTP ${r.status}` };
    return { reach: 'ok', summary: summarizeState(await r.json()) };
  } catch (e) {
    const err = e as Error;
    return { reach: 'unreachable', error: err.name === 'TimeoutError' ? `did not answer within ${deps.timeoutMs} ms` : err.message || String(e) };
  }
}

/** Every project on this machine: this one from memory, the others from their own servers, at once. */
export async function projectsOverview(self: { dataDir: string; name: string; state: () => unknown }, deps: OverviewDeps): Promise<{ projects: ProjectRow[] }> {
  const names = new Map<string, string>();
  for (const p of deps.registry()) if (p?.data_dir) names.set(p.data_dir, p.name);
  const running = new Map(deps.instances().map((i) => [i.data_dir, i] as const));
  const dirs = [...new Set([...names.keys(), ...running.keys()])].filter((d) => d !== self.dataDir);
  const others = await Promise.all(dirs.map(async (dir): Promise<ProjectRow> => {
    const rec = running.get(dir);
    const at = rec ? { url: rec.url, host: rec.host, port: rec.port } : deps.unrecorded(dir);
    const base = { data_dir: dir, self: false };
    if (!at) return { ...base, name: names.get(dir) ?? basename(dir), reach: 'not_running' };
    // A project that answers goes by its own name (planestro.yml), which may have changed since it was registered.
    const got = await ask(at, deps);
    return { ...base, name: got.summary?.name ?? names.get(dir) ?? basename(dir), ...at, ...got };
  }));
  const mine: ProjectRow = { name: self.name, data_dir: self.dataDir, self: true, reach: 'self', summary: summarizeState(self.state()) };
  return { projects: [mine, ...others.sort((a, b) => a.name.localeCompare(b.name))] };
}
