import { findModel, resolveTurnModel, unavailableEntry, type ItemFrontmatter } from '@planestro/shared';
import type { State } from './api.ts';

/** Explain a saved instruction without exposing its prompt or permission rules on the board. */
export function pendingTurnWait(fm: ItemFrontmatter, state?: State | null, now = new Date()): string | undefined {
  const turn = fm.op_data?.pending_turn as { phase?: string } | undefined;
  if (!turn) return undefined;
  const planning = turn.phase === 'plan';
  const phaseMatches = planning ? ['PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status) : ['IN_PROGRESS', 'IN_REVIEW'].includes(fm.status);
  if (!phaseMatches) return `The saved ${planning ? 'planning' : 'work'} instruction does not match this item's phase. Review its status before continuing.`;
  if (fm.taken_over) return 'Waiting for you to hand this item back.';
  if (fm.blocked || fm.awaiting) return 'Waiting for this item’s block or pending decision to be resolved.';
  if (fm.resume_after) return 'Waiting for the items named in “resumes after” to merge.';
  if (state) {
    const id = planning ? fm.planner : fm.implementer;
    const model = findModel(state.config, id);
    if (!model) return id ? `The saved instruction needs model ${id}, which is no longer configured. Choose an available model.` : 'The saved instruction needs a model. Choose an available model.';
    if (model.external) return 'The saved instruction needs an automated model; the current model is external.';
    const pick = resolveTurnModel(state.config, model, { allow: fm.allow_model_fallback === true, unavailable: state.local.model_unavailable, now });
    if (state.engine.provider_guards?.[pick.def.runner]) return `Waiting for the ${pick.def.runner} usage pause to end.`;
    const unavailable = unavailableEntry(state.local.model_unavailable, pick.def.id, now);
    if (unavailable) return `Waiting for model usage to return (next retry: ${pick.exhaustedUntil ?? unavailable.until}). You can choose another available model.`;
    if (state.engine.paused) return 'Waiting for automation to resume.';
    if (state.engine.restart?.draining) return 'Waiting for the restart to finish.';
  }
  return 'The instruction is saved and will run when this item and a session slot are available.';
}
