/**
 * What resuming a conversation costs before it does any work (#64), and which way a turn should
 * therefore go. A resumed session sends its whole window again: written to the prompt cache when
 * the cache has expired, read from it (far cheaper) when it has not. HH-184 was given +$15 to fix a
 * one-step conflict and spent it reloading; HH-181 reloaded a long session to run `git clean`.
 * Pure: the engine, the orchestrator's packets and the page all read the same numbers.
 */
import type { Config } from './schema.ts';

/** What the engine recorded about an item's conversation when its last turn ended. */
// A type, not an interface: it is stored in frontmatter, whose objects pass unknown keys through.
export type SessionContext = {
  /** The conversation this describes. A record for another id says nothing about the current one. */
  session: string;
  /** The model that turn ran on: a cache belongs to its model, and so does a price. */
  model: string;
  /** The window of its last response: what the next resume sends again. */
  tokens: number;
  /** When that turn ended. */
  at: string;
  /** How long its cache writes live, in seconds. */
  ttl_s?: number;
  /** What writing a million tokens to the cache costs on that model, from the CLI's own quote. */
  write_usd_per_mtok?: number;
  /** The running total the conversation last reported: a resume reports it again, and only what is above it is new. */
  total_usd?: number;
};

/** Less than this left is too little for a Claude turn to finish anything (dogfood p36). */
export const MIN_TURN_USD = 1;
/** What a fresh conversation needs: its system prompt and brief written once, and room to do a small job. */
export const FRESH_FLOOR_USD = 3;
/** Room for the work itself on top of a reload, when a raise is sized. */
export const WORK_ROOM_USD = 3;
/** A cache read against a cache write, at most (0.1× input against 1.25×): the estimate errs high. */
export const WARM_SHARE = 0.08;
/** Cache lifetime when the turn did not say: the short one. */
export const DEFAULT_CACHE_TTL_S = 300;
/** A cache this close to expiring is taken as expired: the turn has to start first. */
export const CACHE_MARGIN_S = 60;

export interface ResumeEstimate {
  tokens: number;
  /** Reloading with the cache expired. */
  cold: number;
  /** Reloading from a live cache. */
  warm: number;
  /** The one that applies now. */
  usd: number;
  isWarm: boolean;
  /** `quoted`: priced by the CLI for this conversation. `borrowed`: at the rate last quoted for the same model on another item. */
  basis: 'quoted' | 'borrowed';
}

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * The estimate for resuming an item's conversation on `model` now. Undefined when nothing is known:
 * no record, a record for another conversation, or no price for the model (then the engine behaves
 * as it did before there was an estimate).
 */
export function resumeEstimate(fm: { session_id?: string; session_context?: SessionContext }, o: { now: Date; model?: string; rates?: Record<string, number> }): ResumeEstimate | undefined {
  const c = fm.session_context;
  if (!c || !fm.session_id || c.session !== fm.session_id || !(c.tokens > 0)) return undefined;
  const model = o.model ?? c.model;
  const own = model === c.model ? c.write_usd_per_mtok : undefined;
  const rate = own ?? o.rates?.[model];
  if (!rate || !(rate > 0)) return undefined;
  const age = (o.now.getTime() - Date.parse(c.at)) / 1000;
  const isWarm = model === c.model && Number.isFinite(age) && age >= 0 && age < (c.ttl_s ?? DEFAULT_CACHE_TTL_S) - CACHE_MARGIN_S;
  const cold = cents(c.tokens * rate / 1e6);
  const warm = cents(cold * WARM_SHARE);
  return { tokens: c.tokens, cold, warm, usd: isWarm ? warm : cold, isWarm, basis: own ? 'quoted' : 'borrowed' };
}

/** The newest quoted rate per model across these records, for an item whose own conversation was never quoted. */
export function resumeRates(contexts: (SessionContext | undefined)[]): Record<string, number> {
  const newest = new Map<string, SessionContext>();
  for (const c of contexts) {
    if (!c?.write_usd_per_mtok || !(c.write_usd_per_mtok > 0)) continue;
    const had = newest.get(c.model);
    if (!had || had.at < c.at) newest.set(c.model, c);
  }
  return Object.fromEntries([...newest].map(([m, c]) => [m, c.write_usd_per_mtok!]));
}

/** An item's dollar cap: its own `budget_usd` when set, else the project's. */
export function budgetUsdOf(fm: { budget_usd?: number }, config: Pick<Config, 'budget_usd_per_item'>): number { return fm.budget_usd ?? config.budget_usd_per_item; }

export type TurnPath =
  | { path: 'resume' }
  /** A new conversation with a brief, instead of the old one. */
  | { path: 'fresh'; why: string }
  /** Nothing can be started on what is left. */
  | { path: 'stop'; why: string };

/**
 * Which way a turn goes, from what is left and what the reload costs. The cheap path is taken
 * without asking anyone: a resume that cannot be paid for, or whose reload is above the project's
 * threshold, becomes a fresh conversation when the turn allows one; only when neither fits does it stop.
 */
export function chooseTurnPath(o: {
  left: number;
  /** For the conversation that would be resumed; undefined when there is none, or nothing is known of it. */
  estimate?: ResumeEstimate;
  hasSession: boolean;
  /** `true`: asked for. `'auto'`: the turn's prompt stands on its own, so the engine may choose. */
  fresh?: true | 'auto';
  /** `budget_usd_fresh_above`; 0 turns the automatic choice by price off. */
  freshAboveUsd: number;
  /** The conversation's context in tokens, when it is known; priced or not. */
  contextTokens?: number;
  /** `fresh_above_context_tokens`; 0 or unset turns the automatic choice by size off (#464). */
  freshAboveTokens?: number;
}): TurnPath {
  const $ = (n: number) => `$${n.toFixed(2)}`;
  if (o.left < MIN_TURN_USD) return { path: 'stop', why: `${$(Math.max(0, o.left))} is left, too little for a turn` };
  if (o.fresh === true && o.hasSession) return { path: 'fresh', why: 'asked for' };
  const mayChoose = o.fresh === 'auto' && o.left >= FRESH_FLOOR_USD;
  // A warm reload is cheap once, but every call in the resumed turn reads the whole window again (#464: HH-578
  // ran 88 turns in one conversation up to 875k tokens). Past this size, a prompt that stands on its own starts fresh.
  const size = o.contextTokens ?? o.estimate?.tokens;
  if (o.hasSession && mayChoose && o.freshAboveTokens && size !== undefined && size > o.freshAboveTokens) return { path: 'fresh', why: `its conversation holds ${Math.round(size / 1000)}k tokens, above fresh_above_context_tokens (${Math.round(o.freshAboveTokens / 1000)}k), and every call in a resumed turn reads all of it again` };
  if (!o.hasSession || !o.estimate) return { path: 'resume' };
  const e = o.estimate;
  const reload = `reloading its conversation (${Math.round(e.tokens / 1000)}k tokens${e.isWarm ? ', cache still warm' : ''}) costs about ${$(e.usd)} before any work`;
  if (o.left < e.usd + MIN_TURN_USD) return { path: mayChoose ? 'fresh' : 'stop', why: `${reload} and ${$(o.left)} is left` };
  if (mayChoose && o.freshAboveUsd > 0 && e.usd > o.freshAboveUsd) return { path: 'fresh', why: `${reload}, above budget_usd_fresh_above ($${o.freshAboveUsd})` };
  return { path: 'resume' };
}

/**
 * The least a "+$N" option may raise an item's budget by so that answering it can finish the work:
 * the reload with the cache expired (the answer comes later) plus room for the work, or what a fresh
 * conversation needs; less whatever is still left. Whole dollars, at least one.
 */
export function minRaiseUsd(estimate: ResumeEstimate | undefined, left: number, fresh: boolean): number {
  const need = fresh ? FRESH_FLOOR_USD : (estimate?.cold ?? 0) + WORK_ROOM_USD;
  return Math.max(1, Math.ceil(need - Math.max(0, left)));
}
