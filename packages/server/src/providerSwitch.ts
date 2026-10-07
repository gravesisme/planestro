import { z } from 'zod';
import { canPlan, findModel, unavailableEntry, type ModelDef, type ItemFrontmatter } from '@planestro/shared';
import type { DataStore, ItemOp } from './store/DataStore.ts';
import type { Engine } from './engine/Engine.ts';
import { applyConfigSettings } from './settingsWrite.ts';

export const SwitchRequest = z.strictObject({
  model: z.string(), orchestrator: z.boolean().default(false), defaults: z.boolean().default(false),
  items: z.array(z.string()).default([]), resume: z.boolean().default(false),
});
export type SwitchRequest = z.infer<typeof SwitchRequest>;
export interface SwitchItem { id: string; title: string; eligible: boolean; summary: string; pr?: { number: number; url: string }; result?: 'applied' | 'skipped' | 'failed' }
/** Remove only the usage stop and the decision card filed for that stop. */
export function clearUsageStopOps(fm: ItemFrontmatter): ItemOp[] {
  const decision = fm.awaiting_data?.decision as { reason?: string } | undefined;
  return [
    { unset: ['blocked', 'blocked_reason', 'triage'] },
    ...(fm.awaiting === 'user' && (!decision || decision.reason === fm.blocked_reason) ? [{ unset: ['awaiting', 'awaiting_data'] } as ItemOp] : []),
  ];
}
export function switchRefusal(store: DataStore, engine: Engine, id: string): string | undefined {
  const fm = store.requireItem(id).file.frontmatter;
  if (fm.taken_over) return 'cannot switch yet; waiting for the user to hand the item back';
  if (engine.modelSwitchRefusal?.(id) || engine.sessions().some((s) => s.item === id) || (fm.op && !['awaiting_ci'].includes(fm.op)))
    return 'cannot switch yet; waiting for its running turn or engine operation to finish';
  if (['FINISHED', 'MERGED', 'ICEBOX'].includes(fm.status)) return 'cannot switch; this item is outside the unfinished backlog';
}
function target(store: DataStore, model: string): ModelDef {
  const m = findModel(store.config, model);
  if (!m || !canPlan(m)) throw new Error('Choose a model that can plan and orchestrate');
  if (store.local.engine.provider_guards?.[m.runner]) throw new Error(`${m.runner} is paused for usage`);
  if (unavailableEntry(store.local.model_unavailable, m.id, new Date())) throw new Error(`${m.label} is unavailable`);
  return m;
}
function fieldsFor(store: DataStore, id: string, model: string) {
  const fm = store.requireItem(id).file.frontmatter;
  const impl = findModel(store.config, fm.implementer);
  // Art assignments and legacy exec threads are never moved by the bulk switch.
  const keepWorker = fm.kind === 'epic' || impl?.user_approves_plans || (impl?.runner === 'codex' && impl.codex_transport !== 'app-server');
  return { planner: model, ...(!keepWorker ? { implementer: model } : {}) };
}
export function previewSwitch(store: DataStore, engine: Engine, raw: unknown) {
  const req = SwitchRequest.parse(raw); const m = target(store, req.model);
  const items: SwitchItem[] = [...new Set(req.items)].map((id) => {
    const fm = store.requireItem(id).file.frontmatter;
    const refusal = switchRefusal(store, engine, id);
    const fields = fieldsFor(store, id, m.id);
    const keep = !fields.implementer;
    const futurePlan = keep && fm.status !== 'PLAN_IN_PROGRESS';
    const unchanged = Object.entries(fields).every(([key, value]) => fm[key] === value);
    const waiting = fm.awaiting && !['usage_exhausted', 'provider_usage', 'rate_limited'].includes(fm.blocked_reason ?? '')
      ? `; still waits for ${fm.awaiting === 'plan_approval' ? 'plan approval' : fm.awaiting === 'permission' ? 'a permission decision' : 'the pending decision'}` : '';
    return { id, title: fm.title, eligible: !refusal,
      summary: refusal ?? (unchanged ? `already uses ${m.label}; no changes needed` : `${futurePlan ? 'future planning will start' : keep ? 'planning continues' : 'continues'} on ${m.runner === 'codex' ? 'Codex' : 'Claude'} from a fresh brief; ${fm.pr ? `PR #${fm.pr}${fm.skip_merge ? ' and its hold are' : ' is'} kept; ` : ''}status, edits, approvals and conditions, dependencies and budgets are kept${keep ? '; existing worker model and transport are kept' : ''}${waiting}`),
      ...(fm.pr && store.config.code_repo.github ? { pr: { number: fm.pr, url: `https://github.com/${store.config.code_repo.github}/pull/${fm.pr}` } } : {}) };
  });
  return { request: { ...req, model: m.id }, provider: m.runner, items, orchestrator: req.orchestrator ? 'Applies to the next wake. No restart required.' : undefined };
}

/** Same validator for individual model edits and bulk switches. No lifecycle reset. */
export function itemModelSwitchOps(store: DataStore, engine: Engine, id: string, fields: { planner?: string; implementer?: string }): ItemOp[] {
  const fm = store.requireItem(id).file.frontmatter;
  const changed = Object.entries(fields).filter(([k, v]) => v !== undefined && v !== fm[k]);
  if (!changed.length) return [];
  const refusal = switchRefusal(store, engine, id); if (refusal) throw new Error(refusal);
  for (const [role, ref] of changed) {
    const m = findModel(store.config, ref!);
    if (!m || (role === 'planner' && !canPlan(m))) throw new Error(`Model ${ref} cannot serve as ${role}`);
  }
  const plannerOnly = changed.every(([role]) => role === 'planner');
  const planning = fm.status === 'PLAN_IN_PROGRESS' || plannerOnly;
  const old = findModel(store.config, planning ? fm.planner : fm.implementer);
  const newRef = planning ? fields.planner : fields.implementer;
  const next = findModel(store.config, newRef);
  const handoff = Boolean(fm.worktree && next && !next.external && old && (next.id !== old.id));
  const ops: ItemOp[] = [{ set: Object.fromEntries(changed) }];
  const futurePlan = plannerOnly && fm.status !== 'PLAN_IN_PROGRESS';
  if (handoff && futurePlan) {
    // Invalidate future planning context, not the current art/implementation turn.
    // No task or old question is captured before that future plan exists.
    const data = { ...fm.op_data };
    if ((data.fresh_brief as { role?: string } | undefined)?.role === 'plan') delete data.fresh_brief;
    ops.push({ set: { op_data: { ...data, fresh_plan: true } } });
  }
  if (handoff && !futurePlan) ops.push({ set: { op_data: { ...fm.op_data, fresh_brief: {
    task: 'Continue the current phase from persisted state. Preserve the approved plan, review conditions, and all unfinished work.',
    from_session: fm.agent_sessions?.[old!.runner]?.session_id ?? (old!.runner === 'claude' ? fm.session_id : undefined),
    from_provider: old!.runner, to_provider: next!.runner, question_context: fm.awaiting_data,
    ...(plannerOnly ? { role: 'plan' } : {}),
  } } } });
  // A usage stop is the only decision a provider switch may remove.
  if (handoff && (!plannerOnly || fm.status === 'PLAN_IN_PROGRESS') && ['usage_exhausted', 'provider_usage', 'rate_limited'].includes(fm.blocked_reason ?? '')) {
    ops.push(...clearUsageStopOps(fm));
  }
  ops.push({ activity: { actor: 'app', text: `model changed: ${changed.map(([k, v]) => `${k} → ${v}`).join(', ')}; current state and decisions preserved${handoff ? futurePlan ? '; future planning starts from current state; existing worker is unchanged' : '; next turn starts from a fresh brief' : ''}` } });
  return ops;
}
export function applySwitch(store: DataStore, engine: Engine, raw: unknown) {
  const preview = previewSwitch(store, engine, raw); // validate every id and selection before writing
  const req = preview.request;
  if (req.orchestrator || req.defaults) applyConfigSettings(store, {
    ...(req.orchestrator ? { orchestrator: { model: req.model } } : {}),
    ...(req.defaults ? { defaults: { planner: req.model, implementer: req.model } } : {}),
  });
  const items = preview.items.map((item): SwitchItem => {
    if (!item.eligible) return { ...item, result: 'skipped' };
    try {
      const refusal = switchRefusal(store, engine, item.id);
      if (refusal) return { ...item, summary: refusal, result: 'skipped' };
      const ops = itemModelSwitchOps(store, engine, item.id, fieldsFor(store, item.id, req.model));
      if (ops.length) store.mutateItem(item.id, ops, 'user', { commit: `${item.id}: switch provider` });
      return { ...item, result: ops.length ? 'applied' : 'skipped' };
    } catch (e) { return { ...item, result: 'failed', summary: `${item.summary}; failed: ${(e as Error).message}` }; }
  });
  for (const item of items) if (item.result === 'applied') engine.continueAfterProviderSwitch?.(item.id);
  if (req.resume) engine.resume();
  engine.poke();
  return { ...preview, items };
}
