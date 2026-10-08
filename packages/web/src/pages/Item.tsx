import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PRIORITIES, canPlan, findModel, modelCapabilities, connectionDropOf, decisionOf, DISCARD, planToolsMissing, mcpBudgetOf, dollarHint, epicFlagOf, heldReasonOf, holdShapeOf, kindConversionRefusal, previewOf, loopLine, loopGreen, type Status } from '@planestro/shared';
import { api, type ItemView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { reloadText, useResumeEstimate } from '../resumeCost.ts';
import { Markdown } from '../components/Markdown.tsx';
import { statusLabel } from '../components/ItemCard.tsx';
import { ItemConsole } from '../components/ItemConsole.tsx';
import { CLOSE_HINT, SYNC_HINT, canSyncWithBase, confirmMove, movingLabel, promptCloseAsDone, promptSyncWithBase } from '../components/QuickActions.tsx';
import { ActionButton, ActionGroup } from '../components/ActionButton.tsx';
import { ReviewPanel } from '../components/ReviewPanel.tsx';
import { fallbackHint, KIND_HINT } from '../components/NewItemDialog.tsx';
import { BreakdownPanel } from '../components/BreakdownPanel.tsx';
import { BlockedPanel } from '../components/BlockedPanel.tsx';
import { WaitingPanel } from '../components/ResumeAfter.tsx';
import { TakeOverButton, TakenOverPanel } from '../components/TakeOver.tsx';
import { DiscardButton, DiscardPanel } from '../components/Discard.tsx';
import { AwaitingPanels } from '../components/AwaitingPanels.tsx';
import { PartsStrip } from '../components/PartsStrip.tsx';
import { DecisionCard } from '../components/DecisionCard.tsx';
import { ChildrenTable } from '../components/EpicChildren.tsx';
import { prepareUpload } from '../uploadImage.ts';
import { setTitle as setTabTitle } from '../tabBadge.ts';
import { useLandOnWait } from '../deepLink.ts';

function useAutosave(id: string, section: 'Description' | 'Notes' | 'Plan', initial: string) {
  const [text, setText] = useState(initial);
  const saved = useRef(initial);
  useEffect(() => { if (initial !== saved.current) { setText(initial); saved.current = initial; } }, [initial]);
  const save = () => { if (text === saved.current) return; saved.current = text; return act(() => api.patchItem(id, { sections: { [section]: text } })); };
  return { text, setText, save, dirty: text !== saved.current };
}

export function ItemPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const state = useStore((s) => s.state);
  const item = state?.items.find((i) => i.id === id);
  const [transitions, setTransitions] = useState<{ to: Status; label: string }[]>([]);
  useEffect(() => { if (item) void api.transitions(id).then(setTransitions).catch(() => setTransitions([])); }, [id, item?.frontmatter.status]);
  if (!state) return <p className="muted">Loading…</p>;
  if (!item) return <p>Unknown item {id}. <Link to="/">Back to board</Link></p>;
  return <ItemBody key={id} item={item} transitions={transitions} onDeleted={() => nav('/')} />;
}

function ItemBody({ item, transitions, onDeleted }: { item: ItemView; transitions: { to: Status; label: string }[]; onDeleted: () => void }) {
  const state = useStore((s) => s.state)!;
  const fm = item.frontmatter; const d = item.derived;
  const desc = useAutosave(item.id, 'Description', item.sections.Description);
  const notes = useAutosave(item.id, 'Notes', item.sections.Notes);
  const [editPlan, setEditPlan] = useState(false);
  const plan = useAutosave(item.id, 'Plan', item.sections.Plan);
  const [title, setTitle] = useState(fm.title);
  // The tab (and an installed web app, which has no address bar) says which item this is.
  useEffect(() => { setTabTitle(`${item.id} · ${fm.title}`); return () => setTabTitle('planestro'); }, [item.id, fm.title]);
  // A link to what it waits for (`#plan`, `#decision`, …, #226) opens on that panel.
  useLandOnWait();
  // The title wraps instead of running off a narrow screen, so its box grows to fit what it holds.
  const titleBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const fit = () => { const t = titleBox.current; if (t) { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; } };
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [title]);
  const [approval, setApproval] = useState('');
  /** What the hold waits for, once the user has typed over what the plan states; null until then. */
  const [holdFor, setHoldFor] = useState<string | null>(null);
  const [reject, setReject] = useState('');
  const [msg, setMsg] = useState('');
  const [discarding, setDiscarding] = useState(false);
  const [refPath, setRefPath] = useState('');
  const session = state.engine.sessions.find((s) => s.item === item.id);
  const children = d.children.map((c) => state.items.find((i) => i.id === c)).filter(Boolean) as ItemView[];
  const epics = state.items.filter((i) => i.frontmatter.kind === 'epic' && i.id !== item.id);
  const others = state.items.filter((i) => i.id !== item.id && i.derived.lane !== 'done');
  const field = (fields: Record<string, unknown>) => act(() => api.patchItem(item.id, { fields }));
  const budget = { usd: fm.budget_usd ?? state.config.budget_usd_per_item, turns: fm.budget_turns ?? state.config.budget_turns_per_item, tokens: fm.budget_tokens ?? state.config.budget_tokens_per_item };
  /** A number typed into a budget box: empty clears the item's own cap (back to the project default). */
  /** The loop's iteration budget (#171): a number turns loop mode on or changes its budget, empty turns it off. */
  const setLoop = (raw: string) => { const n = Number(raw); const cur = fm.loop?.max_iterations; if (raw.trim() === '') { if (cur !== undefined) void field({ loop: null }); } else if (Number.isInteger(n) && n > 0 && n !== cur) void field({ loop: { ...(fm.loop ?? {}), max_iterations: n } }); };
  const setBudget = (key: 'budget_usd' | 'budget_turns' | 'budget_tokens', raw: string) => { const n = Number(raw); const cur = fm[key]; if (raw.trim() === '' ? cur !== undefined : n > 0 && n !== cur) void field({ [key]: raw.trim() === '' ? null : n }); };
  const implementerDef = state.config.models.find((m) => m.id === fm.implementer);
  const estimate = useResumeEstimate(item);
  const orch = state.config.orchestrator;
  const canClose = transitions.some((t) => t.to === 'FINISHED');
  const closeAsDone = () => promptCloseAsDone(item.id);
  const maxBytes = state.config.attachments.managed_max_bytes;
  // Phones can't paste from the photo library, so the picker is the mobile path; both go through prepareUpload (HEIC → JPEG, shrink to the size limit).
  const upload = (files: File[]) => { for (const f of files) void act(async () => api.uploadAttachment(item.id, await prepareUpload(f, maxBytes))); };
  const onPaste = (e: React.ClipboardEvent) => { const f = [...e.clipboardData.files][0]; if (f) { e.preventDefault(); upload([f]); } };
  const picker = useRef<HTMLInputElement>(null);
  // Item ↔ epic while nothing has run for implementation (#69, HH-198); the rule is the server's, shared.
  const other = fm.kind === 'epic' ? 'item' : 'epic';
  const convertible = !session && !kindConversionRefusal(fm, other, d.children.length);
  const epicShaped = fm.status === 'PLAN_READY' ? epicFlagOf(fm) : undefined;
  // A plan that says its pull request must wait (#97): read from the plan as it stands, offered at approval.
  // A plan that calls MCP tools its implementer's sessions will not get (#155, HH-338): said before it is approved.
  // Paid MCP calls (#157): the plan's `MCP budget:` line is offered; a model whose plans are the user's needs a number to approve.
  const paid = (implementerDef?.mcp.length ?? 0) > 0;
  const [budgetText, setBudgetText] = useState<string | null>(null);
  const budgetShown = budgetText ?? String(fm.mcp_budget ?? mcpBudgetOf(item.sections.Plan ?? '') ?? '');
  const mcpCalls = /^\d+$/.test(budgetShown.trim()) ? Number(budgetShown.trim()) : undefined;
  const needsBudget = paid && Boolean(implementerDef?.user_approves_plans) && mcpCalls === undefined;
  const lacks = fm.status === 'PLAN_READY' && fm.kind !== 'epic' ? planToolsMissing(item.sections.Plan ?? '', implementerDef, state.config.models) : [];
  const statedHold = fm.status === 'PLAN_READY' && fm.kind !== 'epic' && !epicShaped ? holdShapeOf(item.sections.Plan ?? '') : null;
  const holdText = holdFor ?? statedHold?.reason ?? '';
  const heldFor = heldReasonOf(fm);
  const preview = previewOf(fm);
  const drop = connectionDropOf(fm);
  const convert = (to: 'item' | 'epic') => {
    const carries = item.sections.Plan.trim() ? ` Its ${fm.kind === 'epic' ? 'breakdown' : 'plan'} moves into Notes for the new planner.` : '';
    const next = ['QUEUED', 'PLAN_IN_PROGRESS', 'PLAN_READY'].includes(fm.status) ? (to === 'epic' ? ' Its breakdown is planned at once.' : ' It is queued to be planned as one item.') : '';
    if (confirm(`Convert ${item.id} to ${to === 'epic' ? 'an epic' : 'an item'}?\n\n${KIND_HINT[to]}\n\nThe description stays.${carries}${next}`)) return act(() => api.convertKind(item.id, to));
  };

  return (
    <div className="item-page" onPaste={onPaste}>
      <div>
        <Link className="back phone-only" to={d.lane === 'icebox' ? '/icebox' : d.lane === 'done' ? '/done' : '/'}>‹ {d.lane === 'icebox' ? 'Icebox' : d.lane === 'done' ? 'Done' : 'Board'}</Link>
        <h1><span className="title-id">{item.id}</span><textarea ref={titleBox} rows={1} aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} onBlur={() => title.trim() && title !== fm.title && field({ title: title.trim() })} /></h1>
        <DecisionCard item={item} />
        <div className="controls"><ActionGroup>
          <span className="pill">{statusLabel(fm.status)}</span>
          {fm.blocked && <span className="pill blocked">BLOCKED{fm.blocked_reason ? ` · ${fm.blocked_reason}` : ''}</span>}
          {fm.awaiting && <span className={`pill ${d.needs_you ? 'await' : ''}`}>{decisionOf(fm) ? 'your decision' : `awaiting ${fm.awaiting.replace(/_/g, ' ')}`}</span>}
          {fm.triage && <span className="pill triage">orchestrator triaging</span>}
          {fm.taken_over && <span className="pill yours">yours · by hand</span>}
          {fm.op && <span className="pill">{fm.op.replace(/_/g, ' ')}</span>}
          <TakeOverButton item={item} />
          <DiscardButton item={item} open={discarding} onOpen={() => setDiscarding(true)} />
          {transitions.filter((t) => t.label !== DISCARD && !(t.to === 'IN_PROGRESS' && fm.status === 'PLAN_READY') && !(t.to === 'PLAN_IN_PROGRESS' && fm.status === 'PLAN_READY')).map((t) => (
            t.to === 'FINISHED'
              ? <ActionButton key={t.to} title={CLOSE_HINT} working="Closing…" onAct={closeAsDone}>{t.label}…</ActionButton>
              : <ActionButton key={t.to} disabled={t.to === 'QUEUED' && (!d.deps_satisfied || !!d.base_branch_error)} title={d.base_branch_error ?? (!d.deps_satisfied ? 'dependencies not merged' : '')} working={movingLabel(t.to)} onAct={() => { if (confirmMove(item, t.to, t.label)) return act(() => api.transition(item.id, t.to)); }}>{t.label}</ActionButton>
          ))}
          {canSyncWithBase(item, !!session) && <ActionButton title={SYNC_HINT} working="Syncing…" onAct={() => promptSyncWithBase(item)}>Sync with {d.base_branch ?? 'base'}…</ActionButton>}
          {convertible && !epicShaped && <ActionButton title={KIND_HINT[other]} working="Converting…" onAct={() => convert(other)}>Convert to {other}…</ActionButton>}
        </ActionGroup></div>
        {discarding && <DiscardPanel item={item} onClose={() => setDiscarding(false)} />}
        <div className="controls">
          <label>category <select value={fm.category} onChange={(e) => field({ category: e.target.value })}>{state.config.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label title="Each column, and the queue, takes high before medium before low before none; rank orders items within a priority">priority <select value={fm.priority ?? ''} onChange={(e) => field({ priority: e.target.value || null })}><option value="">none</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
          {fm.kind !== 'epic' && <label>planner <select value={fm.planner ?? ''} onChange={(e) => field({ planner: e.target.value })}>{state.config.models.filter(canPlan).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>}
          {fm.kind !== 'epic' && <label>implementer <select value={fm.implementer ?? ''} onChange={(e) => field({ implementer: e.target.value })}>{state.config.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.external ? ' (external)' : (m.runner ?? 'claude') !== 'claude' ? ` (${m.runner})` : ''}</option>)}</select></label>}
          {fm.kind !== 'epic' && implementerDef && (implementerDef.runner ?? 'claude') !== 'claude' && <span className="small muted" title="Claude workers get a per-command permission policy with parked requests. This runner has no such callback: its turns run inside its own sandbox (writes confined to the worktree, no network for its commands) and planestro verifies the result afterwards.">runs on {implementerDef.runner}: sandboxed, not per-command permissions ⓘ</span>}
          {fm.kind !== 'epic' && <label>parent epic <select value={fm.parent ?? ''} onChange={(e) => field({ parent: e.target.value || null })}><option value="">none</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.id} {e.frontmatter.title}</option>)}</select></label>}
          {fm.kind !== 'epic' && !d.external && <label title={orch.may_approve_plans ? `The orchestrator reviews the plan and approves it, sends it back with fixes (up to ${orch.max_plan_revisions} round${orch.max_plan_revisions === 1 ? '' : 's'}), or leaves it to you` : 'Turn on "the orchestrator may approve plans" in Settings first'}><input type="checkbox" checked={!!fm.auto_approve_plan} disabled={!orch.may_approve_plans} onChange={(e) => field({ auto_approve_plan: e.target.checked })} /> let the orchestrator approve the plan{orch.may_approve_plans ? ` (up to ${orch.max_plan_revisions} fix round${orch.max_plan_revisions === 1 ? '' : 's'}, then you)` : ' — off in Settings'}</label>}
          {!d.external && <label title="While the planner's or implementer's model is out of usage, turns run on its fallback (models: fallback in planestro.yml) instead of blocking as usage_exhausted"><input type="checkbox" checked={!!fm.allow_model_fallback} onChange={(e) => field({ allow_model_fallback: e.target.checked })} /> allow fallback model{fallbackHint(state.config, [fm.planner, fm.kind !== 'epic' ? fm.implementer : undefined])}{fm.kind === 'epic' ? ' — children created from its breakdown inherit this' : ''}</label>}
          {d.external && <label>merge policy <select value={fm.merge_policy ?? 'watch'} onChange={(e) => field({ merge_policy: e.target.value })}><option value="watch">watch (someone else merges)</option><option value="app">app (planestro merges)</option></select></label>}
          <span className="deps">depends on
            {fm.depends_on.length === 0 && <span className="muted"> nothing</span>}
            {fm.depends_on.map((dep) => { const o = state.items.find((x) => x.id === dep); const done = o && ['MERGED', 'FINISHED'].includes(o.frontmatter.status); return (
              <span key={dep} className={`tag ${done ? 'ok' : ''}`} title={o ? `${o.frontmatter.title} — ${statusLabel(o.frontmatter.status)}` : 'unknown item'}><Link to={`/items/${dep}`}>{dep}</Link> <ActionButton className="chip-x" title={`Stop waiting on ${dep}`} working="" onAct={() => field({ depends_on: fm.depends_on.filter((x) => x !== dep) })}>×</ActionButton></span>); })}
            <select value="" onChange={(e) => e.target.value && field({ depends_on: [...fm.depends_on, e.target.value] })}><option value="">add…</option>{others.filter((o) => !fm.depends_on.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.id} {o.frontmatter.title.slice(0, 70)}</option>)}</select>
          </span>
        </div>
        {(d.external || fm.kind === 'epic') && (
          <div className="controls">
            <label>branch <input placeholder={fm.kind === 'epic' ? 'feature/<slug>' : 'external branch name'} onBlur={(e) => e.target.value !== (fm.branch ?? '') && field({ branch: e.target.value || null })} key={fm.branch} defaultValue={fm.branch ?? ''} /></label>
            <label>PR # <input type="number" key={fm.pr} defaultValue={fm.pr ?? ''} onBlur={(e) => Number(e.target.value) !== (fm.pr ?? 0) && field({ pr: e.target.value ? Number(e.target.value) : null })} /></label>
          </div>
        )}

        <TakenOverPanel item={item} />
        <BlockedPanel item={item} />
        <WaitingPanel item={item} />
        {fm.status === 'PLAN_READY' && fm.kind === 'epic' && <BreakdownPanel item={item} />}
        {fm.status === 'PLAN_READY' && fm.kind !== 'epic' && (
          <div className="approval" id="plan" data-wait={fm.awaiting === 'orchestrator' ? undefined : true}>
            <h2 style={{ margin: '0 0 8px' }}>{fm.awaiting === 'orchestrator' ? 'The orchestrator is reviewing this plan' : 'Plan needs your approval'}</h2>
            {fm.awaiting === 'orchestrator' && <p className="small" style={{ marginTop: 0 }}>You asked it to decide: it approves, sends the plan back with fixes ({fm.plan_revisions ?? 0} of {orch.max_plan_revisions} rounds used), or leaves it to you. You can still decide yourself below.</p>}
            {fm.op_data?.plan_amended ? <p className="small"><span className="tag ok">amended by the orchestrator</span> it sent the plan back to fold this in, so what you approve is complete: <i>{String(fm.op_data.plan_amended)}</i></p> : null}
            {item.activity.filter((a) => a.actor === 'orchestrator').slice(-3).map((a, i) => <p key={i} className="small"><b>orchestrator:</b> {a.text}</p>)}
            {epicShaped && (
              <div className="epic-warning" role="alert">
                <b>This plan is an epic, not one item.</b>
                <p className="small">{epicShaped.reason[0].toUpperCase() + epicShaped.reason.slice(1)}. Approved as an item, all of it would go to one implementer in one pull request, so approval is refused. Convert it: the plan becomes the request its epic planner breaks into child items, each with its own worker and pull request.</p>
                {epicShaped.children?.length ? <p className="small muted">Proposed: {epicShaped.children.map((c) => c.title).join(' · ')}</p> : null}
                <div className="row"><ActionGroup>
                  {convertible && <ActionButton className="primary" working="Converting…" onAct={() => convert('epic')}>Convert to epic…</ActionButton>}
                  <ActionButton className="small" title="Only if it truly is one piece of work and the plan's layout misled the check" working="Approving…" onAct={() => { if (confirm(`Approve ${item.id} as ONE item anyway?\n\nOne implementer does all of it in one pull request.`)) return act(() => api.approvePlan(item.id, approval || undefined, true)); }}>It is one item: approve anyway…</ActionButton>
                </ActionGroup></div>
              </div>
            )}
            {statedHold && (
              <div className="hold-warning" role="note">
                <b>This plan says its pull request must wait.</b>
                <p className="small">“{statedHold.quote}” Writing it in the plan holds nothing. Approved with the hold, the pull request is opened and its CI is read, but it does not merge until you release the hold.</p>
                <label className="row small">Held: <input className="grow" aria-label="What the pull request waits for" placeholder="what it waits for" value={holdText} onChange={(e) => setHoldFor(e.target.value)} /></label>
              </div>
            )}
            {item.merged_since_cut?.length ? <p className="small" role="note"><b>The base has moved</b> since this plan was made: {item.merged_since_cut.join(', ')} merged into {d.base_branch}. Approving rebases its branch onto {d.base_branch} first, so the implementer starts from there.</p> : null}
            {lacks.length > 0 && <div className="hold-warning" role="note"><b>This plan uses tools its implementer does not have.</b>{lacks.map((l) => <p key={l.server} className="small">MCP server <b>{l.server}</b> ({l.tools.join(', ')}): {implementerDef?.label ?? fm.implementer} has no access to it. {l.models.length ? `Switch the implementer to ${l.models.map((m) => state.config.models.find((x) => x.id === m)?.label ?? m).join(' or ')} before approving.` : 'No model in this project has it: add the server in Settings → MCP servers and tick it on a model, or ask for a plan without it.'}</p>)}</div>}
            {paid && <label className="row small">MCP budget: <input style={{ width: 90 }} inputMode="numeric" aria-label="MCP calls this item may make" placeholder="calls" value={budgetShown} onChange={(e) => setBudgetText(e.target.value)} /> calls to {implementerDef!.mcp.join(', ')}{implementerDef!.user_approves_plans ? ' (required: each call costs money)' : ''}</label>}
            <textarea placeholder="Optional notes to pass to the implementer" value={approval} onChange={(e) => setApproval(e.target.value)} style={{ minHeight: 60 }} />
            <div className="row"><ActionGroup>{statedHold && <ActionButton className="primary" disabled={!holdText.trim() || needsBudget} working="Approving…" onAct={() => act(() => api.approvePlan(item.id, approval || undefined, false, holdText, paid ? mcpCalls : undefined))}>Approve and hold the PR</ActionButton>}{!epicShaped && <ActionButton className={statedHold ? '' : 'primary'} disabled={needsBudget} title={needsBudget ? 'Set its MCP budget first' : statedHold ? 'Without the hold: its pull request merges as soon as CI is green' : undefined} working="Approving…" onAct={() => act(() => api.approvePlan(item.id, approval || undefined, false, undefined, paid ? mcpCalls : undefined))}>Approve &amp; implement</ActionButton>}{canClose && <ActionButton title={CLOSE_HINT} working="Closing…" onAct={closeAsDone}>Already done — close…</ActionButton>}{fm.awaiting === 'plan_approval' && state.config.orchestrator.may_approve_plans && !implementerDef?.user_approves_plans && <ActionButton title="Hand it to the orchestrator to review and approve, as a delegated plan: for one that came back to you without a decision" working="Handing over…" onAct={() => act(() => api.reviewPlanAgain(item.id))}>Ask the orchestrator to review</ActionButton>}<span className="grow" /><input className="grow" placeholder="What should change?" value={reject} onChange={(e) => setReject(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && reject.trim()) { e.preventDefault(); (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); } }} /* Enter presses the button beside it, through its guard */ /><ActionButton className="danger" disabled={!reject.trim()} working="Sending…" onAct={() => act(() => api.rejectPlan(item.id, reject))}>Request changes</ActionButton></ActionGroup></div>
          </div>
        )}
        {fm.parts?.length ? <PartsStrip parts={fm.parts} /> : null}
        {fm.loop && <div className="section"><h2>Loop · {fm.loop_state ? `${fm.loop_state.passing}/${fm.loop_state.total} passing` : 'not started'}</h2><div className="small">{fm.loop_state ? loopLine(fm.loop_state, fm.loop.max_iterations) : `no iteration reported yet; ${fm.loop.max_iterations} allowed`}{loopGreen(fm.loop_state) && <> · <b>green</b></>}</div>{fm.loop.goal && <div className="muted small">goal: {fm.loop.goal}</div>}</div>}
        <AwaitingPanels item={item} />
        <ReviewPanel item={item} />
        {drop && (
          <div className="approval">
            <h2 style={{ margin: '0 0 8px' }}>Lost connection to planestro</h2>
            <p className="small" style={{ marginTop: 0 }}>At {drop.at.slice(0, 19).replace('T', ' ')}{drop.tool ? <>, on <code>{drop.tool}</code></> : null}: <code>{drop.error}</code></p>
            <p className="small">The session's planestro calls and permission requests may not have arrived. A report it made is applied from the turn's record when the turn ends; if none could be, the item stops as <code>connection_lost</code> and the orchestrator reads the session's last message. This clears after a turn that runs with its connection.</p>
            {drop.finalMessage && <details><summary className="small">Its last message</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{drop.finalMessage}</pre></details>}
          </div>
        )}
        {fm.status === 'IN_PROGRESS' && fm.skip_merge && (
          <div className="approval">
            <h2 style={{ margin: '0 0 8px' }}>Its pull request will be held</h2>
            <p className="small">{heldFor ? <><b>Held:</b> {heldFor}. </> : null}The work goes on as usual. Its pull request is opened and its CI is read, but it does not merge until you release the hold.</p>
            <div className="row"><ActionButton working="Dropping the hold…" onAct={() => { const n = prompt(`Drop the hold on ${item.id}, so its pull request merges as usual? Optional note for the log:`); if (n !== null) return act(() => api.releaseHold(item.id, n || undefined)); }}>Drop the hold</ActionButton></div>
          </div>
        )}
        {fm.status === 'IN_REVIEW' && fm.skip_merge && (
          <div className="approval" id="hold" data-wait={d.needs_you || undefined}>
            <h2 style={{ margin: '0 0 8px' }}>Held out of the merge queue</h2>
            {heldFor && <p className="small" style={{ marginTop: 0 }}><b>Held:</b> {heldFor}</p>}
            {preview && <p className="small" style={{ marginTop: 0 }}><b>Preview:</b> <a href={preview.url} target="_blank" rel="noreferrer">{preview.url}</a> <span className="muted">({preview.sha.slice(0, 7)})</span></p>}
            {fm.op_data?.pr_draft ? <p className="small">The pull request is a <b>draft</b> while it is held: its session's commits are pushed, but CI waits. Releasing the hold syncs the branch, marks the PR ready, and CI runs once, on the head that merges.</p> : <p className="small">CI for the pushed head: <b>{fm.ci_result ?? 'pending'}</b>{fm.ci_head_sha ? ` (${fm.ci_head_sha.slice(0, 7)})` : ''}. While it is held, its session's commits are still pushed and a red run still goes to the session to fix; it just does not merge. Releasing it sends it back through sync and CI before it merges.</p>}
            <div className="row"><ActionButton className="primary" working="Releasing…" onAct={() => { const n = prompt(`Let ${item.id} merge? Optional note for the log:`); if (n !== null) return act(() => api.releaseHold(item.id, n || undefined)); }}>Release hold</ActionButton></div>
          </div>
        )}

        <div className="section"><h2>Description</h2><textarea value={desc.text} onChange={(e) => desc.setText(e.target.value)} onBlur={desc.save} /><div className="small muted">{desc.dirty ? 'unsaved — saves on blur' : ' '}</div></div>
        <div className="section"><h2>Notes</h2><textarea value={notes.text} onChange={(e) => notes.setText(e.target.value)} onBlur={notes.save} style={{ minHeight: 80 }} /></div>
        <div className="section"><h2>Plan <ActionButton className="small" working="Saving…" onAct={async () => { if (editPlan) await plan.save(); setEditPlan(!editPlan); }}>{editPlan ? 'done' : 'edit'}</ActionButton></h2>{editPlan ? <textarea value={plan.text} onChange={(e) => plan.setText(e.target.value)} onBlur={plan.save} style={{ minHeight: 200 }} /> : <Markdown text={item.sections.Plan} />}</div>
        {fm.kind === 'epic' && (
          <div className="section"><h2>Children · {children.filter((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)).length}/{children.length} merged
            <span><ActionGroup>
              {/* a childless epic's branch would sit idle (dogfood p56, LM-2) */}{fm.status === 'NOT_YET_SUBMITTED' && children.length > 0 && <ActionButton className="small" working="Opening…" onAct={() => act(() => api.epicAction(item.id, 'open'))}>Open epic branch</ActionButton>}{' '}
              {fm.status === 'IN_PROGRESS' && <ActionButton className="small" working="Syncing…" onAct={() => act(() => api.epicAction(item.id, 'sync'))}>Sync with {d.base_branch}</ActionButton>}{' '}
              {fm.status === 'IN_PROGRESS' && children.length > 0 && children.every((c) => ['MERGED', 'FINISHED'].includes(c.frontmatter.status)) && <ActionButton className="small primary" working="Submitting…" onAct={() => act(() => api.epicAction(item.id, 'submit'))}>Submit epic PR</ActionButton>}
            </ActionGroup></span></h2>
            <ChildrenTable epic={item} items={state.items} />
            {!children.length && <p className="muted small">No children yet — plan the breakdown, or create items with this epic as their parent.</p>}
          </div>
        )}
        <div className="section"><h2>Session</h2>
          {session ? <p>{session.busy ? 'running' : 'idle'} · {session.model} · {session.op ?? ''}<br /><span className="small muted">{session.last_output}</span></p> : <p className="muted small">No live session. {fm.session_id ? `Parked session ${fm.session_id.slice(0, 8)}… resumes when needed.` : 'Nothing has run for this item yet.'}</p>}
          {fm.session_id && !session && <p className="small muted">Open in a terminal (pauses planestro's use of it while attached): <code>claude --resume {fm.session_id}</code> <button className="small" onClick={() => void navigator.clipboard.writeText(`claude --resume ${fm.session_id}`)}>copy</button></p>}
          <form className="row" onSubmit={(e) => e.preventDefault()}><input className="grow" placeholder={fm.taken_over ? 'You have this item: hand it back to talk to its session' : 'Message to the session (queued for its next turn)'} disabled={!!fm.taken_over} value={msg} onChange={(e) => setMsg(e.target.value)} /><ActionButton type="submit" disabled={!msg.trim() || !!fm.taken_over} working="Sending…" onAct={() => act(() => api.message(item.id, msg)).then((r) => { if (r) setMsg(''); })}>Send</ActionButton></form>
          <h2 style={{ marginTop: 12 }}>Console</h2>
          <ItemConsole id={item.id} />
        </div>
        <div className="section"><h2>Attachments</h2>
          <ul className="attachments">{fm.attachments.map((a) => <li key={a.path}>{a.kind === 'managed' && /\.(png|jpe?g|gif|webp)$/i.test(a.path) && <img src={`/${a.path}`} alt="" />}<code>{a.path}</code><span className="tag">{a.kind}</span>{a.kind === 'managed' && <a href={`/${a.path}`} target="_blank" rel="noreferrer">open</a>}<ActionButton className="small" working="Removing…" onAct={() => act(() => api.removeAttachment(item.id, a.path))}>remove</ActionButton></li>)}</ul>
          <div className="row">
            <button className="small" onClick={() => picker.current?.click()}>Attach photo or file…</button>
            <input ref={picker} type="file" accept="image/*,.heic,.heif,.pdf,.txt,.md,.json" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; upload(fs); }} />
            <span className="small muted">or paste an image anywhere on this page (≤ {Math.round(maxBytes / 1e6)} MB, committed; photos are converted to JPEG and shrunk to fit).</span>
          </div>
          <form className="row" onSubmit={(e) => e.preventDefault()}><input className="grow" placeholder="Reference a path (absolute, or relative to the code repo) — never copied" value={refPath} onChange={(e) => setRefPath(e.target.value)} /><ActionButton type="submit" disabled={!refPath.trim()} working="Adding…" onAct={() => act(() => api.referenceAttachment(item.id, refPath.trim())).then((r) => { if (r) setRefPath(''); })}>Add reference</ActionButton></form>
        </div>
        <div className="section"><h2>Activity</h2><ul className="activity">{item.activity.map((a, i) => <li key={i}><span className="at">{a.at.slice(0, 19).replace('T', ' ')}</span><span className="muted">{a.actor}</span><span>{a.text}</span></li>)}</ul></div>
      </div>
      <aside className="sidebar section">
        <dl>
          <dt>id</dt><dd>{item.id} · {fm.kind}{d.external ? ' · external' : ''}</dd>
          <dt>file</dt><dd><code className="small">{item.path}</code></dd>
          <dt>base branch</dt><dd>{d.base_branch ?? <span className="tag hot">{d.base_branch_error}</span>}</dd>
          <dt>branch</dt><dd>{fm.branch ?? '—'}</dd>
          <dt>worktree</dt><dd>{fm.worktree ?? '—'}</dd>
          <dt>PR</dt><dd>{fm.pr ? <a href={`https://github.com/${state.config.code_repo.github}/pull/${fm.pr}`} target="_blank" rel="noreferrer">#{fm.pr}</a> : '—'}</dd>
          {preview && <><dt>preview</dt><dd><a href={preview.url} target="_blank" rel="noreferrer">{preview.url.replace(/^https?:\/\//, '')}</a></dd></>}
          <dt>session</dt><dd>{fm.session_id ?? '—'}{Object.entries(fm.agent_sessions ?? {}).map(([r, sid]) => <div key={r}>{r}: {sid.session_id}</div>)}</dd>
          <dt>CI</dt><dd>{fm.ci_result ?? '—'}{fm.ci_failed_count ? ` (${fm.ci_failed_count} red)` : ''}</dd>
          <dt>cost</dt><dd>
            <div title={dollarHint(state.billing)}>{modelCapabilities(findModel(state.config, fm.status === 'PLAN_IN_PROGRESS' ? fm.planner : fm.implementer) ?? { runner: 'claude', external: false }).accounting === 'tokens' && <strong>Codex cost: not reported · Historical Claude: </strong>}{fm.cost_usd !== undefined ? `$${fm.cost_usd.toFixed(2)} · ${fm.turns ?? 0} turns` : '$0.00'} <span className="muted small">{dollarHint(state.billing)}</span>{(fm.cost_usd ?? 0) / budget.usd >= 0.8 && <> <span className={`tag ${(fm.cost_usd ?? 0) >= budget.usd ? 'hot' : 'wait'}`}>{Math.round((fm.cost_usd ?? 0) / budget.usd * 100)}% spent</span></>}</div>
            {estimate && <div className="muted small" title="What the next resume of this item's conversation sends again before it does any work. planestro starts a fresh conversation with a brief instead when that costs more than the item has left, or more than budget_usd_fresh_above.">resume: {reloadText(estimate)}</div>}
            <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}><span className="muted small">budget</span><label title={fm.budget_usd !== undefined ? 'This item\'s own dollar budget; clear it for the project default' : `The project default ($${state.config.budget_usd_per_item}); type a number to give this item its own`}>$<input type="number" min={1} key={`bu${fm.budget_usd}`} defaultValue={fm.budget_usd ?? ''} placeholder={String(state.config.budget_usd_per_item)} onBlur={(e) => setBudget('budget_usd', e.target.value)} style={{ width: 70 }} /></label>{fm.budget_usd !== undefined && <span className="tag">this item</span>}</div>
            {implementerDef && implementerDef.runner && implementerDef.runner !== 'claude' && <>
              <div style={{ marginTop: 6 }}>{fm.agent_turns ?? 0} {implementerDef.runner} turns · {(fm.tokens ?? 0).toLocaleString()} tokens{(fm.tokens ?? 0) / budget.tokens >= 0.8 && <> <span className={`tag ${(fm.tokens ?? 0) >= budget.tokens ? 'hot' : 'wait'}`}>{Math.round((fm.tokens ?? 0) / budget.tokens * 100)}% used</span></>}</div>
              <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }}><span className="muted small">budget</span><label><input type="number" min={1} key={`bt${fm.budget_turns}`} defaultValue={fm.budget_turns ?? ''} placeholder={String(state.config.budget_turns_per_item)} onBlur={(e) => setBudget('budget_turns', e.target.value)} style={{ width: 60 }} /> turns</label><label><input type="number" min={1000} step={1000} key={`bk${fm.budget_tokens}`} defaultValue={fm.budget_tokens ?? ''} placeholder={String(state.config.budget_tokens_per_item)} onBlur={(e) => setBudget('budget_tokens', e.target.value)} style={{ width: 100 }} /> tokens</label></div>
            </>}
            {fm.kind !== 'epic' && <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap' }} title="Loop until green: the worker iterates until every check passes, each iteration counted against this budget; green ends in a review hold. Empty: an ordinary item."><span className="muted small">loop</span><label><input type="number" min={1} key={`lp${fm.loop?.max_iterations}`} defaultValue={fm.loop?.max_iterations ?? ''} placeholder="off" onBlur={(e) => setLoop(e.target.value)} style={{ width: 60 }} /> iterations</label></div>}
          </dd>
          {(() => { const rs = (state.releases ?? []).filter((r) => r.frontmatter.items.includes(item.id)); return rs.length ? <><dt>release</dt><dd>{rs.map((r) => <div key={r.version}><Link to={`/releases/${encodeURIComponent(r.version)}`}>{r.version}</Link> <span className="muted small">{r.frontmatter.status}</span></div>)}</dd></> : null; })()}
          <dt>rank</dt><dd>{fm.rank ?? '—'}</dd>
          {(['created_at', 'updated_at', 'queued_at', 'started_at', 'plan_ready_at', 'plan_approved_at', 'pr_created_at', 'merged_at', 'finished_at', 'iceboxed_at'] as const).map((k) => fm[k] ? <Fragment key={k}><dt>{k.replace('_at', '')}</dt><dd>{fm[k]!.slice(0, 19).replace('T', ' ')}</dd></Fragment> : null)}
        </dl>
        <div className="row" style={{ marginTop: 12 }}><ActionButton className="danger small" working="Deleting…" onAct={() => { if (confirm(`Delete ${item.id}?`)) return act(() => api.deleteItem(item.id)).then(onDeleted); }}>Delete item</ActionButton></div>
      </aside>
    </div>
  );
}

import { Fragment } from 'react';
