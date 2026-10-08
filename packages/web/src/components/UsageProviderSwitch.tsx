import { Link } from 'react-router';
import { canPlan, findModel } from '@planestro/shared';
import type { ItemView } from '../api.ts';
import { useStore } from '../store.ts';

/** Open a scoped preview; navigation never changes a model or resumes work. */
export function UsageProviderSwitch({ item }: { item: ItemView }) {
  const config = useStore((s) => s.state?.config);
  const fm = item.frontmatter;
  if (!config || !fm.blocked || !['usage_exhausted', 'provider_usage', 'rate_limited'].includes(fm.blocked_reason ?? '')) return null;
  const planning = ['PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status);
  const current = findModel(config, planning ? fm.planner : fm.implementer);
  const provider = current?.runner === 'codex' ? 'claude' : 'codex';
  if (!config.models.some((m) => m.runner === provider && canPlan(m))) return null;
  return <Link className="button" to={`/switch-provider?provider=${provider}&item=${encodeURIComponent(item.id)}`}>Switch to {provider === 'codex' ? 'Codex' : 'Claude'}…</Link>;
}
