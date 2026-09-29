import type { Status, ItemFrontmatter, ModelDef } from './schema.ts';

export type Actor = 'user' | 'engine' | 'orchestrator';
/** Which lifecycle a row applies to: planestro-driven worker items, epics, or externally driven items. */
export type Flavor = 'worker' | 'epic' | 'external';
export type TimestampKey = 'queued_at' | 'started_at' | 'plan_ready_at' | 'plan_approved_at' | 'pr_created_at' | 'merged_at' | 'finished_at' | 'iceboxed_at';

export interface Transition { from: Status; to: Status; by: readonly Actor[]; flavors: readonly Flavor[]; sets?: TimestampKey; label: string }

const ALL: readonly Flavor[] = ['worker', 'epic', 'external'];
const U: readonly Actor[] = ['user'];
const UO: readonly Actor[] = ['user', 'orchestrator'];
const E: readonly Actor[] = ['engine'];
const UE: readonly Actor[] = ['user', 'engine'];
export const CLOSE_AS_DONE = 'close as done';

export const TRANSITIONS: readonly Transition[] = [
  { from: 'NOT_YET_SUBMITTED', to: 'QUEUED', by: UO, flavors: ['worker'], sets: 'queued_at', label: 'queue' },
  { from: 'NOT_YET_SUBMITTED', to: 'ICEBOX', by: U, flavors: ALL, sets: 'iceboxed_at', label: 'icebox' },
  { from: 'NOT_YET_SUBMITTED', to: 'IN_PROGRESS', by: UE, flavors: ['epic', 'external'], sets: 'started_at', label: 'start' },
  // An epic can be planned: the planner proposes its children, the user approves the breakdown, and only then does it open.
  { from: 'NOT_YET_SUBMITTED', to: 'PLAN_IN_PROGRESS', by: UE, flavors: ['epic'], sets: 'started_at', label: 'plan the breakdown' },
  { from: 'ICEBOX', to: 'NOT_YET_SUBMITTED', by: U, flavors: ALL, label: 'move to backlog' },
  { from: 'ICEBOX', to: 'QUEUED', by: U, flavors: ['worker'], sets: 'queued_at', label: 'queue' },
  { from: 'QUEUED', to: 'NOT_YET_SUBMITTED', by: U, flavors: ['worker'], label: 'cancel' },
  { from: 'QUEUED', to: 'ICEBOX', by: U, flavors: ['worker'], sets: 'iceboxed_at', label: 'icebox' },
  { from: 'QUEUED', to: 'PLAN_IN_PROGRESS', by: E, flavors: ['worker'], sets: 'started_at', label: 'start planning' },
  { from: 'PLAN_IN_PROGRESS', to: 'PLAN_READY', by: E, flavors: ['worker', 'epic'], sets: 'plan_ready_at', label: 'plan submitted' },
  { from: 'PLAN_IN_PROGRESS', to: 'ICEBOX', by: U, flavors: ['worker', 'epic'], sets: 'iceboxed_at', label: 'icebox' },
  { from: 'PLAN_READY', to: 'PLAN_IN_PROGRESS', by: UO, flavors: ['worker', 'epic'], label: 'request changes' },
  { from: 'PLAN_READY', to: 'IN_PROGRESS', by: UO, flavors: ['worker'], sets: 'plan_approved_at', label: 'approve plan' },
  // Approving a breakdown creates items and spends money on them: the user's call alone, never the orchestrator's.
  { from: 'PLAN_READY', to: 'IN_PROGRESS', by: U, flavors: ['epic'], sets: 'plan_approved_at', label: 'approve breakdown' },
  { from: 'PLAN_READY', to: 'ICEBOX', by: U, flavors: ['worker', 'epic'], sets: 'iceboxed_at', label: 'icebox' },
  { from: 'IN_PROGRESS', to: 'IN_REVIEW', by: UE, flavors: ALL, sets: 'pr_created_at', label: 'open PR' },
  { from: 'IN_PROGRESS', to: 'ICEBOX', by: U, flavors: ['worker'], sets: 'iceboxed_at', label: 'icebox' },
  { from: 'IN_REVIEW', to: 'MERGED', by: E, flavors: ALL, sets: 'merged_at', label: 'merge' },
  { from: 'MERGED', to: 'FINISHED', by: E, flavors: ALL, sets: 'finished_at', label: 'finish' },
  { from: 'FINISHED', to: 'NOT_YET_SUBMITTED', by: U, flavors: ALL, label: 'reopen' },
  // "Close as done": the work landed some other way (or was never needed), so there is no PR to
  // merge. User-only — nobody but the human can vouch for work planestro did not integrate — and
  // not from IN_REVIEW/MERGED, where a pull request already decides the outcome. An epic in
  // progress owns an integration branch and children, so it is excluded too.
  ...(['NOT_YET_SUBMITTED', 'ICEBOX'] as const).map((from): Transition => ({ from, to: 'FINISHED', by: U, flavors: ALL, sets: 'finished_at', label: CLOSE_AS_DONE })),
  { from: 'QUEUED', to: 'FINISHED', by: U, flavors: ['worker'], sets: 'finished_at', label: CLOSE_AS_DONE },
  ...(['PLAN_IN_PROGRESS', 'PLAN_READY'] as const).map((from): Transition => ({ from, to: 'FINISHED', by: U, flavors: ['worker', 'epic'], sets: 'finished_at', label: CLOSE_AS_DONE })),
  { from: 'IN_PROGRESS', to: 'FINISHED', by: U, flavors: ['worker', 'external'], sets: 'finished_at', label: CLOSE_AS_DONE },
];

export function flavorOf(item: Pick<ItemFrontmatter, 'kind' | 'implementer'>, models: readonly Pick<ModelDef, 'id' | 'external'>[]): Flavor {
  if (item.kind === 'epic') return 'epic';
  const m = models.find((x) => x.id === item.implementer);
  return m?.external ? 'external' : 'worker';
}

export function findTransition(from: Status, to: Status, actor: Actor, flavor: Flavor): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to && t.by.includes(actor) && t.flavors.includes(flavor));
}

export function allowedTransitions(from: Status, actor: Actor, flavor: Flavor): Transition[] {
  return TRANSITIONS.filter((t) => t.from === from && t.by.includes(actor) && t.flavors.includes(flavor));
}

export class TransitionError extends Error {}

/**
 * Apply a transition to a frontmatter copy: sets `status`, the row's timestamp, and clears
 * transient engine state that cannot outlive a status change. Throws TransitionError if illegal.
 */
export function applyTransition(fm: ItemFrontmatter, to: Status, actor: Actor, flavor: Flavor, now: string): ItemFrontmatter {
  const t = findTransition(fm.status, to, actor, flavor);
  if (!t) throw new TransitionError(`${actor} may not move a ${flavor} item from ${fm.status} to ${to}`);
  const next: ItemFrontmatter = { ...fm, status: to };
  if (t.sets) (next as any)[t.sets] = now;
  // Leaving a running state parks whatever was pending; the engine re-derives it.
  if (to === 'ICEBOX' || to === 'NOT_YET_SUBMITTED' || to === 'FINISHED') { delete next.awaiting; delete next.awaiting_data; delete next.triage; delete next.op; delete next.op_started_at; delete next.op_data; }
  if (to === 'PLAN_READY') { next.awaiting = flavor === 'epic' ? 'breakdown_approval' : 'plan_approval'; }
  if (to === 'IN_PROGRESS' && fm.status === 'PLAN_READY') { delete next.awaiting; delete next.awaiting_data; }
  if (to === 'PLAN_IN_PROGRESS' && fm.status === 'PLAN_READY') { delete next.awaiting; delete next.awaiting_data; }
  if (to === 'FINISHED') { delete next.worktree; delete next.blocked; delete next.blocked_reason; }
  // Off the board, nothing drives the item anyway; a take-over left on it would silently hold it back when it is queued again.
  if (to === 'ICEBOX' || to === 'NOT_YET_SUBMITTED' || to === 'FINISHED') delete next.taken_over;
  // A hold is about one pull request: once that has merged, or the item has left the board, it would silently hold the next one (#97).
  if (to === 'MERGED' || to === 'ICEBOX' || to === 'NOT_YET_SUBMITTED' || to === 'FINISHED') { delete next.skip_merge; delete next.hold_reason; }
  return next;
}

// ---- item ↔ epic (#69, HH-198) ----

/**
 * Where a kind can still change: nothing has run for implementation, so nothing is lost. An item can
 * become an epic up to its plan's approval (it goes back to be broken down instead); an epic can become
 * an item until its breakdown is approved, which is when its children and integration branch appear.
 */
export const CONVERTIBLE_FROM: Record<'item' | 'epic', readonly Status[]> = {
  epic: ['NOT_YET_SUBMITTED', 'ICEBOX', 'QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY'],
  item: ['NOT_YET_SUBMITTED', 'ICEBOX', 'PLAN_IN_PROGRESS', 'PLAN_READY'],
};

/** Why this item cannot be converted to `to` (an item to an epic or back), or null when it can. The page shows the button from the same answer. */
export function kindConversionRefusal(fm: Pick<ItemFrontmatter, 'id' | 'kind' | 'status' | 'parent' | 'pr' | 'plan_approved_at' | 'taken_over' | 'op'>, to: 'item' | 'epic', children: number): string | null {
  if ((fm.kind ?? 'item') === to) return `${fm.id} is already ${to === 'epic' ? 'an epic' : 'an item'}`;
  if (fm.taken_over) return `${fm.id} is yours (taken over): hand it back first`;
  if (to === 'item' && children) return `${fm.id} has ${children} child item${children === 1 ? '' : 's'}: an epic with children stays an epic`;
  if (to === 'epic' && fm.parent) return `${fm.id} is a child of ${fm.parent}, and epics do not nest`;
  if (fm.pr) return `${fm.id} has pull request #${fm.pr}: its work has run`;
  if (fm.plan_approved_at) return `${fm.id}'s ${fm.kind === 'epic' ? 'breakdown' : 'plan'} was approved (${fm.plan_approved_at.slice(0, 16).replace('T', ' ')}): ${fm.kind === 'epic' ? 'its children and branch exist' : 'implementation has run'}`;
  if (!CONVERTIBLE_FROM[to].includes(fm.status)) return `${fm.id} is ${fm.status}: only ${CONVERTIBLE_FROM[to].join(', ')} can become ${to === 'epic' ? 'an epic' : 'an item'}`;
  if (fm.op) return `${fm.id} has a step running (${fm.op.replace(/_/g, ' ')}): convert it once that is done`;
  return null;
}

// ---- derived values (never persisted) ----

export type Lane = 'board' | 'icebox' | 'done';
export function laneOf(status: Status): Lane {
  if (status === 'ICEBOX') return 'icebox';
  if (status === 'FINISHED') return 'done';
  return 'board';
}

export const NEEDS_YOU_AWAITING = new Set(['plan_approval', 'breakdown_approval', 'permission', 'question', 'review', 'user']);
/** A stop the orchestrator is still triaging is not yours yet: it resolves it, or comes back with one decision. */
export function needsYou(fm: Pick<ItemFrontmatter, 'blocked' | 'awaiting' | 'triage'> & Partial<Pick<ItemFrontmatter, 'status' | 'skip_merge' | 'ci_result' | 'op_data' | 'taken_over'>>): boolean {
  // You took it over: you are already on it, and nothing on it waits for anyone else.
  if (fm.triage || fm.taken_over) return false;
  if (fm.blocked || (fm.awaiting !== undefined && NEEDS_YOU_AWAITING.has(fm.awaiting))) return true;
  // A held pull request whose CI is green waits for exactly one thing, a person releasing the hold:
  // nothing automatic moves it, so it is yours (dogfood p44: HH-162 sat held and green at NEEDS YOU 0).
  // A held PR kept as a draft (ci.draft_while_held) never goes green, since CI waits for the release: same wait.
  return fm.status === 'IN_REVIEW' && Boolean(fm.skip_merge) && (fm.ci_result === 'green' || fm.op_data?.pr_draft === true);
}

export function isDone(status: Status): boolean {
  return status === 'MERGED' || status === 'FINISHED';
}

/** `base_branch_override ?? parent.branch ?? default_branch` */
export function baseBranchOf(fm: Pick<ItemFrontmatter, 'base_branch_override' | 'parent'>, parent: Pick<ItemFrontmatter, 'branch'> | undefined, defaultBranch: string): string {
  if (fm.base_branch_override) return fm.base_branch_override;
  if (fm.parent) {
    if (!parent?.branch) throw new Error(`parent ${fm.parent} has no integration branch yet`);
    return parent.branch;
  }
  return defaultBranch;
}

export function depsSatisfied(fm: Pick<ItemFrontmatter, 'depends_on'>, lookup: (id: string) => Pick<ItemFrontmatter, 'status'> | undefined): boolean {
  return fm.depends_on.every((id) => { const d = lookup(id); return d !== undefined && isDone(d.status); });
}

export const ACTIVE_STATUSES: readonly Status[] = ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'];
