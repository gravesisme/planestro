import { resumeEstimate, resumeRates, modelCapabilities, type ResumeEstimate } from '@planestro/shared/view';
import type { ItemView } from './api.ts';
import { useStore } from './store.ts';

/**
 * What resuming this item's conversation costs before any work (#64), from the same numbers the
 * engine decides on. Undefined when there is no conversation, or nothing is known of it yet.
 */
export function useResumeEstimate(item: ItemView): ResumeEstimate | undefined {
  const state = useStore((s) => s.state);
  const fm = item.frontmatter;
  if (!state || !fm.session_id) return undefined;
  const planning = fm.status === 'PLAN_IN_PROGRESS' || fm.status === 'PLAN_READY';
  const def = state.config.models.find((m) => m.id === (planning ? fm.planner : fm.implementer));
  if (!def || modelCapabilities(def).accounting !== 'dollars') return undefined;
  return resumeEstimate(fm, { now: new Date(), model: def.claude_model, rates: resumeRates(state.items.map((i) => i.frontmatter.session_context)) });
}

/** "about $7.60 to reload 412k tokens", with the cache's state when it matters. */
export function reloadText(e: ResumeEstimate): string {
  return `about $${e.usd.toFixed(2)} to reload ${Math.round(e.tokens / 1000)}k tokens${e.isWarm ? ` (cache warm; $${e.cold.toFixed(2)} once it expires)` : ''}`;
}

/** A fresh session is for work in progress or in review, in a worktree. */
export function canUnblockFresh(item: ItemView): boolean {
  const fm = item.frontmatter;
  return Boolean(fm.worktree) && (fm.status === 'IN_PROGRESS' || fm.status === 'IN_REVIEW');
}
