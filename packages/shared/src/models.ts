/**
 * Model fallback: which model a turn actually runs on. A model row may name a `fallback` (another
 * row, same runner). When an item allows it and the requested model is out of usage, the turn runs
 * on the first available model down that chain. "Out of usage" is remembered per machine in
 * `planestro.local.yml` (`model_unavailable`) until the provider's reset, so later turns skip the
 * failed attempt. Pure: no I/O, no clock of its own. Project-neutral: nothing names a model.
 */
import type { Config, ModelDef, ModelUnavailable } from './schema.ts';
import { canPlan } from './schemaView.ts';

/** How long a model is skipped when the provider does not say when its usage resets. */
export const DEFAULT_UNAVAILABLE_MINUTES = 60;

/**
 * The start of every message the Claude CLI shows when a usage limit is genuinely reached. The
 * Agent SDK exports the authoritative list as `USAGE_LIMIT_ERROR_PREFIXES` (marked alpha); the port
 * merges it with this copy so a renamed export never silently disables detection.
 */
export const KNOWN_USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your", "You've reached your", "You're out of usage credits",
  'Your org is out of usage', "Your seat type doesn't include usage", 'Your usage allocation has been disabled',
  "Your group's usage limit is set to $0", "You're out of extra usage", "Your seat type doesn't include extra usage",
];

/** Assistant-message error codes that mean "this model cannot serve you now" rather than a transient blip. */
export const USAGE_ERROR_CODES: readonly string[] = ['rate_limit', 'billing_error', 'model_not_found'];

/** Whether `text` is a usage-limit message: it starts with a known prefix, or names a model that "requires usage credits". */
export function isUsageLimitText(text: string | undefined, prefixes: readonly string[] = KNOWN_USAGE_LIMIT_PREFIXES): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return prefixes.some((p) => t.startsWith(p)) || /^\S.{0,60} requires usage credits/.test(t);
}

/** A reset time from the SDK: epoch seconds or milliseconds. */
export function resetTime(v: unknown): Date | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** A model row by id, or by its runner model string (the orchestrator setting has accepted both). */
/**
 * Whether a new item starts with "let the orchestrator approve the plan" ticked: defaults.auto_approve_plan, for an
 * item (never an epic) whose implementer supports planning and does not require human plan approval.
 */
export function planReviewByDefault(config: Pick<Config, 'models' | 'defaults'>, implementer: string | undefined, kind: 'item' | 'epic' = 'item'): boolean {
  if (kind === 'epic' || !config.defaults.auto_approve_plan) return false;
  const m = findModel(config, implementer ?? config.defaults.implementer);
  return Boolean(m) && canPlan(m!) && !m!.user_approves_plans;
}

export function findModel(config: Pick<Config, 'models'>, ref: string | undefined): ModelDef | undefined {
  if (!ref) return undefined;
  return config.models.find((m) => m.id === ref) ?? config.models.find((m) => m.claude_model === ref || m.codex_model === ref);
}

/** The runner's own model string for a row (`claude_model` / `codex_model`). */
export function runnerModel(def: ModelDef): string | undefined {
  return (def.runner ?? 'claude') === 'claude' ? def.claude_model : def.codex_model;
}

/** The entry that keeps `id` unavailable at `now`, if any. */
export function unavailableEntry(map: Record<string, ModelUnavailable> | undefined, id: string, now: Date): ModelUnavailable | undefined {
  const e = map?.[id];
  if (!e) return undefined;
  const until = Date.parse(e.until);
  return Number.isFinite(until) && until > now.getTime() ? e : undefined;
}

/** The row's fallback, when it names a real row on the same runner. */
export function fallbackOf(config: Pick<Config, 'models'>, def: ModelDef): ModelDef | undefined {
  if (!def.fallback) return undefined;
  const next = config.models.find((m) => m.id === def.fallback);
  if (!next || next.external || (next.runner ?? 'claude') !== (def.runner ?? 'claude')) return undefined;
  return next;
}

/** The whole chain from `def` (itself first), stopping at a cycle. */
export function fallbackChain(config: Pick<Config, 'models'>, def: ModelDef): ModelDef[] {
  const chain: ModelDef[] = [def];
  const seen = new Set([def.id]);
  for (let next = fallbackOf(config, def); next && !seen.has(next.id); next = fallbackOf(config, next)) { chain.push(next); seen.add(next.id); }
  return chain;
}

export interface ModelPick {
  /** The row the turn runs on. */
  def: ModelDef;
  /** Its runner model string. */
  model?: string;
  /** The row the item asked for, when the turn runs on a fallback instead. */
  fellBackFrom?: ModelDef;
  /** Why the requested model was skipped, and until when. */
  skipped?: ModelUnavailable;
  /** The next available model's runner string, for the SDK's own overload fallback. */
  sdkFallback?: string;
  /** Every model in the chain is out of usage: the earliest time one of them comes back. */
  exhaustedUntil?: string;
}

/**
 * Choose the model for a turn. Without `allow`, always the requested row (a remembered outage is
 * only information: the user may have bought more usage). With it, the first row in the fallback
 * chain that is not marked unavailable; when every row is, `exhaustedUntil`.
 */
export function resolveTurnModel(
  config: Pick<Config, 'models'>,
  requested: ModelDef,
  opts: { allow: boolean; unavailable?: Record<string, ModelUnavailable>; now: Date },
): ModelPick {
  if (!opts.allow) return { def: requested, model: runnerModel(requested) };
  const chain = fallbackChain(config, requested);
  const idx = chain.findIndex((m) => !unavailableEntry(opts.unavailable, m.id, opts.now));
  if (idx < 0) {
    const earliest = chain.map((m) => Date.parse(opts.unavailable![m.id].until)).reduce((a, b) => Math.min(a, b));
    return { def: requested, model: runnerModel(requested), exhaustedUntil: new Date(earliest).toISOString() };
  }
  const def = chain[idx];
  const after = chain.slice(idx + 1).find((m) => !unavailableEntry(opts.unavailable, m.id, opts.now));
  return {
    def, model: runnerModel(def),
    ...(idx > 0 ? { fellBackFrom: requested, skipped: unavailableEntry(opts.unavailable, requested.id, opts.now) } : {}),
    ...(after && runnerModel(after) ? { sdkFallback: runnerModel(after) } : {}),
  };
}

/**
 * When a model that just failed on usage comes back: the provider's reset, unless it is missing or
 * not in the future (clock skew would expire the entry at once and send the retry straight back to
 * the same model), in which case the default window.
 */
export function unavailableUntil(resetsAt: string | undefined, now: Date): Date {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(t) && t > now.getTime() + 60_000 ? new Date(t) : new Date(now.getTime() + DEFAULT_UNAVAILABLE_MINUTES * 60_000);
}

/** A new `model_unavailable` map with `id` marked until `until`, dropping entries that have expired. */
export function markUnavailable(
  map: Record<string, ModelUnavailable> | undefined, id: string,
  entry: { until: Date; reason: string; manual?: boolean }, now: Date,
): Record<string, ModelUnavailable> {
  const next: Record<string, ModelUnavailable> = {};
  for (const [k, v] of Object.entries(map ?? {})) if (k !== id && unavailableEntry(map, k, now)) next[k] = v;
  next[id] = { until: entry.until.toISOString(), reason: entry.reason.slice(0, 300), since: now.toISOString(), ...(entry.manual ? { manual: true } : {}) };
  return next;
}

/** Problems with the models' fallbacks, as sentences (unknown target, another runner, a cycle). */
export function fallbackProblems(config: Pick<Config, 'models'>): string[] {
  const out: string[] = [];
  for (const m of config.models) {
    if (!m.fallback) continue;
    const t = config.models.find((x) => x.id === m.fallback);
    if (!t) out.push(`model ${m.id}: fallback ${m.fallback} is not a model id`);
    else if ((t.runner ?? 'claude') !== (m.runner ?? 'claude')) out.push(`model ${m.id}: fallback ${t.id} runs on ${t.runner ?? 'claude'}, not ${m.runner ?? 'claude'}`);
    else if (t.id === m.id) out.push(`model ${m.id}: falls back to itself`);
  }
  for (const m of config.models) {
    const chain = fallbackChain(config, m);
    const last = chain.at(-1)!;
    const next = fallbackOf(config, last);
    if (next && chain.some((c) => c.id === next.id) && next.id !== last.id) out.push(`model ${m.id}: fallback chain loops back to ${next.id}`);
  }
  return [...new Set(out)];
}

/**
 * The MCP servers a text names (#366): by a tool (`mcp__<server>__<tool>`) or by the server's own name as a word, matched
 * case-insensitively against `servers` (the ones configured on this machine or listed on a model). planestro is never one.
 */
export function mcpServersNamed(text: string, servers: readonly string[]): string[] {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\bmcp__([A-Za-z0-9-]+)__/g)) if (m[1].toLowerCase() !== 'planestro') out.set(m[1].toLowerCase(), servers.find((s) => s.toLowerCase() === m[1].toLowerCase()) ?? m[1]);
  for (const s of servers) {
    if (s.toLowerCase() === 'planestro' || out.has(s.toLowerCase())) continue;
    if (new RegExp(`(?<![A-Za-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text)) out.set(s.toLowerCase(), s);
  }
  return [...out.values()];
}

/**
 * MCP servers a plan calls on that its implementer's sessions do not get (#155, HH-338: a plan
 * built on mcp__ElevenLabs__text_to_sound_effects went to Opus, which has no MCP servers, and the sound phase went undone).
 * Each with the models that do have it. planestro's own tools are never missing. Server names compare case-insensitively.
 * A server the plan names only in words (`servers`: the machine's configured ones; the models' are always known) comes back
 * with no tools (#366, HH-538: "generate the takes with ElevenLabs" went to a worker with no ElevenLabs, and nothing said so).
 */
export function planToolsMissing(plan: string, implementer: Pick<ModelDef, 'mcp'> | undefined, models: readonly Pick<ModelDef, 'id' | 'mcp'>[], servers: readonly string[] = []): { server: string; tools: string[]; models: string[] }[] {
  const named = new Map<string, Set<string>>();
  for (const m of plan.matchAll(/\bmcp__([A-Za-z0-9-]+)__([A-Za-z0-9_-]+)/g)) {
    if (m[1].toLowerCase() === 'planestro') continue;
    const k = m[1]; if (!named.has(k)) named.set(k, new Set()); named.get(k)!.add(m[2]);
  }
  const known = [...new Set([...servers, ...models.flatMap((m) => m.mcp)])];
  for (const s of mcpServersNamed(plan, known)) if (![...named.keys()].some((k) => k.toLowerCase() === s.toLowerCase())) named.set(s, new Set());
  const has = (mdl: Pick<ModelDef, 'mcp'> | undefined, server: string) => (mdl?.mcp ?? []).some((x) => x.toLowerCase() === server.toLowerCase());
  return [...named].filter(([server]) => !has(implementer, server)).map(([server, tools]) => ({ server, tools: [...tools], models: models.filter((m) => has(m, server)).map((m) => m.id) }));
}

/** The number a plan states on its `MCP budget:` line (#157), offered as the budget at approval; undefined when it states none. */
export function mcpBudgetOf(plan: string): number | undefined {
  const m = /^\s*(?:[-*]\s*)?\**MCP budget:?\**:?\s*\**\s*(\d+)/im.exec(plan);
  return m ? Number(m[1]) : undefined;
}
