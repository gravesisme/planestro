import { UsageProviderSwitch } from './UsageProviderSwitch.tsx';
import { blockHelp } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { FINISH_HINT, promptFinishFromWorktree } from './QuickActions.tsx';
import { Markdown } from './Markdown.tsx';
import { decisionOf } from '@planestro/shared';
import { TriageNote } from './DecisionCard.tsx';
import { ResumeAfterButton } from './ResumeAfter.tsx';
import { canUnblockFresh, reloadText, useResumeEstimate } from '../resumeCost.ts';

export const FRESH_HINT = 'Starts a new conversation that gets a brief (the item, its plan, what is committed and what is not) and your message as its task, instead of reloading the old conversation. It becomes the item\'s conversation.';

/**
 * Why an item is blocked, in words: what the engine (or the agent) said when it stopped, what that
 * reason means, and what unblocking will do. The reason code alone sent people to the Activity log.
 */
export function BlockedPanel({ item, compact = false }: { item: ItemView; compact?: boolean }) {
  const fm = item.frontmatter;
  const estimate = useResumeEstimate(item);
  if (!fm.blocked || decisionOf(fm)) return null; // a decision card carries the block's details itself
  const reason = fm.blocked_reason ?? 'blocked';
  const said = [...item.activity].reverse().find((a) => a.text.startsWith(`BLOCKED (${reason}): `) || (reason === 'orchestrator' && a.text.startsWith('blocked for the user: ')));
  const detail = said?.text.replace(/^BLOCKED \([a-z_]+\): |^blocked for the user: /, '');
  const help = blockHelp(reason);
  const unblock = () => { const m = prompt(`Unblock ${item.id} (${reason}). Optional message for the session:`); if (m !== null) void act(() => api.unblock(item.id, m || undefined)); };
  const unblockFresh = () => { const m = prompt(`Unblock ${item.id} in a fresh session. It gets a brief from the item and git, and this as its task (required):`); if (m?.trim()) void act(() => api.unblock(item.id, m.trim(), true)); };
  const fresh = canUnblockFresh(item) && <button title={FRESH_HINT} onClick={unblockFresh}>Unblock in a fresh session…</button>;
  // A red run judged a flake is re-run as it stands, with nothing to fix (#139): only the head's own red run, while nothing else runs.
  // A run still cancelled after planestro's own re-run (#174) is re-run whole, the same way.
  const rerun = fm.status === 'IN_REVIEW' && reason === 'ci_cancelled' && !!fm.op_data?.last_cancelled ? <button title="Re-runs this head's cancelled CI run, once what cancelled it (a job time limit, a concurrency group) is fixed. The new attempt's verdict is the one that counts." onClick={() => void act(() => api.rerunCi(item.id))}>Re-run cancelled CI</button>
    : fm.status === 'IN_REVIEW' && /^ci_red/.test(reason) && !!fm.op_data?.last_red && <button title="Re-runs the failed jobs of this head's red CI run: for a flake, when nothing in the branch needs fixing. The new attempt's verdict is the one that counts." onClick={() => void act(() => api.rerunCi(item.id))}>Re-run failed CI jobs</button>;
  if (fm.triage) return (
    <div className="blocked-panel triaging" id="blocked">
      <TriageNote item={item} />
      {detail && <details className="decision-details"><summary>details</summary><p className="blocked-said">{detail}</p></details>}
      {!compact && <div className="row">{rerun}<UsageProviderSwitch item={item} /><button onClick={unblock}>Unblock it myself…</button>{fresh}</div>}
    </div>
  );
  return (
    <div className="blocked-panel" id="blocked" data-wait>
      <h2>Blocked: {reason.replace(/_/g, ' ')}{said && <span className="small muted"> since {said.at.slice(0, 16).replace('T', ' ')}</span>}</h2>
      {detail && <p className="blocked-said">{detail}</p>}
      {help && <div className="small"><Markdown text={`**What it means.** ${help.meaning}\n\n**What to do.** ${help.todo}`} /></div>}
      {estimate && <p className="small muted">Resuming its conversation costs {reloadText(estimate)}, before any work. A fresh session gets a brief instead and needs no reload.</p>}
      {!compact && <div className="row">{rerun}<UsageProviderSwitch item={item} /><button className="danger" onClick={unblock}>Unblock…</button>{fresh}{fm.status === 'IN_PROGRESS' && fm.worktree && <button title={FINISH_HINT} onClick={() => promptFinishFromWorktree(item.id)}>Finish from here…</button>}<ResumeAfterButton item={item} /><button onClick={() => useStore.getState().openChat({ item: item.id, draft: `Why is ${item.id} blocked (${reason}), and what should I do? If an instruction to the worker would fix it, unblock it with one.` })}>Ask the orchestrator</button><span className="small muted">Unblocking retries from where it stopped; with a message, the session is resumed with it.</span></div>}
    </div>
  );
}
