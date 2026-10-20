import { decisionOf, findModel, heldReasonOf, modelCapabilities, waitsFor, type ItemFrontmatter } from '@planestro/shared/view';
import type { ItemView, State } from './api.ts';
import { agentStateOf } from './agentState.ts';

// ---- the quick view of an active item opens on what is happening now (#314) ----

/** How the Now strip is coloured: running is #299's green; the rest take their state's colour. */
export type NowTone = 'running' | 'wait' | 'ci' | 'you' | 'blocked' | 'triage' | 'held' | 'yours' | 'idle';
export interface Now { tone: NowTone; text: string; output?: string; title?: string }

const ACTIVE = ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW'];

/** An item something is happening to: in flight, or with a session, a step, a block, a wait or a triage on it. */
export function isActiveItem(item: ItemView, state: State | null | undefined): boolean {
  const fm = item.frontmatter;
  return ACTIVE.includes(fm.status) || !!state?.engine.sessions.some((s) => s.item === item.id) || !!fm.op || !!fm.blocked || !!fm.awaiting
    || !!fm.triage || !!fm.taken_over || !!fm.op_data?.pending_turn;
}

/** "<1 min", "6 min", "1 h", "2 h 5 min", "3 d 4 h". */
export function span(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}
const since = (at: string | undefined, now: Date) => at ? span(now.getTime() - Date.parse(at)) : undefined;
const words = (s: string) => s.replace(/_/g, ' ');

/** The user's half of each wait, as the strip names it. */
const AWAITING_SAYS: Record<string, string> = {
  plan_approval: 'plan approval', breakdown_approval: 'breakdown approval', permission: 'a permission ruling', question: 'an answer',
  audition: 'picking takes', review: 'your review', user: 'a reply',
};
/** A step the engine is taking, in words. */
const OP_SAYS: Record<string, string> = {
  creating_worktree: 'creating the worktree…', importing: 'importing…', planning_turn: 'starting the planning turn…', implement_turn: 'starting the turn…',
  pushing: 'pushing…', creating_pr: 'opening the pull request…', rebasing: 'rebasing…', syncing_base: 'syncing with base…',
  running_local_checks: 'running local checks…', merging: 'merging…', cleaning_up: 'cleaning up…',
};

/** Turn n of the item's cap, for a runner counted in turns (the engine counts no turns for a dollar-metered one). */
function turnOf(fm: ItemFrontmatter, state: State): string | undefined {
  const def = findModel(state.config, ['PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status) ? fm.planner : fm.implementer);
  if (!def || modelCapabilities(def).accounting !== 'tokens') return undefined;
  return `turn ${(fm.agent_turns ?? 0) + 1} of ${fm.budget_turns ?? state.config.budget_turns_per_item}`;
}

/** The one sentence the strip says: what runs now, or what the item waits on, reusing #299's words for a saved instruction. */
export function nowOf(item: ItemView, state: State | null | undefined, now = new Date()): Now {
  const fm = item.frontmatter;
  const agent = agentStateOf(item, state);
  if (agent?.kind === 'running') {
    const session = state!.engine.sessions.find((s) => s.item === item.id)!;
    const text = [agent.label, since(session.started_at, now), turnOf(fm, state!)].filter(Boolean).join(' · ');
    return { tone: 'running', text, ...(agent.output ? { output: agent.output } : {}) };
  }
  if (fm.taken_over) return { tone: 'yours', text: `yours: you are finishing it by hand${fm.taken_over.note ? ` (${fm.taken_over.note})` : ''}` };
  const decision = decisionOf(fm);
  if (decision) return { tone: 'you', text: 'waiting on you: a decision', title: decision.question };
  if (fm.triage) return { tone: 'triage', text: `orchestrator triaging: ${words(fm.triage.reason)}` };
  if (fm.blocked) return { tone: 'blocked', text: `blocked: ${words(fm.blocked_reason ?? 'no reason given')}` };
  if (fm.awaiting) {
    if (fm.awaiting === 'orchestrator') return { tone: 'triage', text: 'waiting on the orchestrator' };
    return { tone: 'you', text: `waiting on you: ${AWAITING_SAYS[fm.awaiting] ?? words(fm.awaiting)}` };
  }
  if (agent?.kind === 'slot') {
    const busy = state!.engine.sessions.filter((s) => s.busy).length;
    return { tone: 'wait', text: `waiting for a slot (${busy} of ${state!.config.concurrency.max_sessions} busy)`, title: agent.reason };
  }
  if (agent?.kind === 'wait') return { tone: 'wait', text: agent.reason };
  if (fm.op === 'awaiting_ci') {
    const rerun = fm.op_data?.ci_rerun as { sha?: string; runId?: number } | undefined;
    const run = rerun?.runId && rerun.sha === fm.ci_head_sha ? `run ${rerun.runId}` : undefined;
    return { tone: 'ci', text: ['CI running', run, since(fm.op_started_at, now)].filter(Boolean).join(' · ') };
  }
  if (fm.op) return { tone: 'idle', text: [OP_SAYS[fm.op] ?? `${words(fm.op)}…`, since(fm.op_started_at, now)].filter(Boolean).join(' · ') };
  if (fm.skip_merge) return { tone: 'held', text: `held: ${heldReasonOf(fm) ?? 'out of the merge queue'}${fm.status === 'IN_REVIEW' ? ` · CI ${fm.ci_result ?? 'pending'}` : ''}` };
  if (fm.resume_after) return { tone: 'wait', text: `resumes after ${waitsFor(fm.resume_after)} merge`, title: fm.resume_after.message };
  switch (fm.status) {
    case 'IN_REVIEW': return fm.ci_result === 'red' ? { tone: 'blocked', text: 'CI red' } : fm.ci_result === 'green' ? { tone: 'ci', text: 'CI green · waiting to merge' } : { tone: 'ci', text: `in review · CI ${fm.ci_result ?? 'not started'}` };
    case 'PLAN_READY': return { tone: 'idle', text: 'plan ready' };
    case 'MERGED': return { tone: 'idle', text: 'merged · cleaning up next' };
    default: return { tone: 'idle', text: 'idle between turns: nothing is driving it right now' };
  }
}

export type PhaseState = 'done' | 'current' | 'todo';
export interface PhaseStep { label: string; state: PhaseState; spent?: string }

/** The lifecycle's steps with the stamp each starts at; a step's time is from its stamp to the next one's (or now). */
const PHASES: { label: string; at: keyof ItemFrontmatter; statuses: string[] }[] = [
  { label: 'Queued', at: 'queued_at', statuses: ['QUEUED'] },
  { label: 'Planning', at: 'started_at', statuses: ['PLAN_IN_PROGRESS'] },
  { label: 'Plan ready', at: 'plan_ready_at', statuses: ['PLAN_READY'] },
  { label: 'Implementing', at: 'plan_approved_at', statuses: ['IN_PROGRESS'] },
  { label: 'Review/CI', at: 'pr_created_at', statuses: ['IN_REVIEW'] },
  { label: 'Merged', at: 'merged_at', statuses: ['MERGED', 'FINISHED'] },
];

/** Where the item is: Queued → … → Merged, the current step lit and each step's time where its stamps say. */
export function phaseTrack(fm: ItemFrontmatter, now = new Date()): PhaseStep[] {
  const current = PHASES.findIndex((p) => p.statuses.includes(fm.status));
  return PHASES.map((p, i) => {
    const state: PhaseState = current < 0 ? 'todo' : i < current ? 'done' : i === current ? (i === PHASES.length - 1 ? 'done' : 'current') : 'todo';
    const from = fm[p.at] as string | undefined;
    const to = i === current ? now.toISOString() : (fm[PHASES[i + 1]?.at] as string | undefined);
    const spent = state !== 'todo' && i < PHASES.length - 1 && from && to ? span(Date.parse(to) - Date.parse(from)) : undefined;
    return { label: p.label, state, ...(spent ? { spent } : {}) };
  });
}
