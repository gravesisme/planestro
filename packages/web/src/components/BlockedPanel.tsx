import { blockHelp } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act } from '../store.ts';
import { Markdown } from './Markdown.tsx';

/**
 * Why an item is blocked, in words: what the engine (or the agent) said when it stopped, what that
 * reason means, and what unblocking will do. The reason code alone sent people to the Activity log.
 */
export function BlockedPanel({ item, compact = false }: { item: ItemView; compact?: boolean }) {
  const fm = item.frontmatter;
  if (!fm.blocked) return null;
  const reason = fm.blocked_reason ?? 'blocked';
  const said = [...item.activity].reverse().find((a) => a.text.startsWith(`BLOCKED (${reason}): `) || (reason === 'orchestrator' && a.text.startsWith('blocked for the user: ')));
  const detail = said?.text.replace(/^BLOCKED \([a-z_]+\): |^blocked for the user: /, '');
  const help = blockHelp(reason);
  const unblock = () => { const m = prompt(`Unblock ${item.id} (${reason}). Optional message for the session:`); if (m !== null) void act(() => api.unblock(item.id, m || undefined)); };
  return (
    <div className="blocked-panel">
      <h2>Blocked: {reason.replace(/_/g, ' ')}{said && <span className="small muted"> since {said.at.slice(0, 16).replace('T', ' ')}</span>}</h2>
      {detail && <p className="blocked-said">{detail}</p>}
      {help && <div className="small"><Markdown text={`**What it means.** ${help.meaning}\n\n**What to do.** ${help.todo}`} /></div>}
      {!compact && <div className="row"><button className="danger" onClick={unblock}>Unblock…</button><span className="small muted">Unblocking retries from where it stopped; with a message, the session is resumed with it.</span></div>}
    </div>
  );
}
