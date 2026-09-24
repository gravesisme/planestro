import { useState } from 'react';
import { canPlan, fallbackChain, fallbackProblems, findModel, unavailableEntry, type Config, type ModelDef } from '@planestro/shared';
import { api } from '../api.ts';
import { act, useStore } from '../store.ts';

export function SettingsPage() {
  const state = useStore((s) => s.state);
  const [newCat, setNewCat] = useState('');
  if (!state) return <p className="muted">Loading…</p>;
  const cfg = state.config;
  const set = (section: string, key: string, value: unknown) => act(() => api.putConfig({ [section]: { [key]: value } }));
  const local = (key: string, value: string) => act(() => api.putLocal({ [key]: value }));
  return (
    <div className="settings">
      <div className="section"><h2>Categories</h2>
        {cfg.categories.map((c) => (
          <div className="row" key={c}>
            <span className="grow">{c}{cfg.defaults.category === c && <span className="tag ok" style={{ marginLeft: 6 }}>default</span>}</span>
            {cfg.defaults.category !== c && <button className="small" onClick={() => act(() => api.categories({ op: 'default', name: c }))}>make default</button>}
            <button className="small" onClick={() => { const to = prompt(`Rename "${c}" to:`, c); if (to && to !== c) void act(() => api.categories({ op: 'rename', from: c, to })); }}>rename</button>
            <button className="small danger" disabled={cfg.categories.length < 2} onClick={() => { const rest = cfg.categories.filter((x) => x !== c); const to = prompt(`Remove "${c}". Move its items to which category?\n${rest.join(', ')}`, rest[0]); if (to && rest.includes(to)) void act(() => api.categories({ op: 'remove', name: c, reassign_to: to })); }}>remove</button>
          </div>
        ))}
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (!newCat.trim()) return; void act(() => api.categories({ op: 'add', name: newCat.trim() })); setNewCat(''); }}><input className="grow" placeholder="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} /><button type="submit" disabled={!newCat.trim()}>Add</button></form>
      </div>
      <div className="section"><h2>Models &amp; defaults</h2>
        <table><tbody>{cfg.models.map((m) => {
          const out = unavailableEntry(state.local.model_unavailable, m.id, new Date());
          return <tr key={m.id}><td>{m.label}</td><td className="muted">{m.id}</td><td className="muted">{m.external ? 'external (watched)' : `${m.runner ?? 'claude'} · ${(m.runner ?? 'claude') === 'claude' ? m.claude_model : m.codex_model ?? 'CLI default'}`}</td>
            <td className="muted">{chainText(cfg, m)}</td>
            <td>{m.external ? null : out
              ? <><span className="tag wait" title={out.reason}>out until {fmtTime(out.until)}</span> <button className="small" onClick={() => act(() => api.clearModelUnavailable(m.id))}>available now</button></>
              : <button className="small" onClick={() => { const until = askUntil(m.label); if (until) void act(() => api.markModelUnavailable(m.id, until)); }}>mark unavailable…</button>}</td></tr>;
        })}</tbody></table>
        <div className="row"><label className="grow">default planner <select value={cfg.defaults.planner} onChange={(e) => set('defaults', 'planner', e.target.value)}>{cfg.models.filter(canPlan).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          <label className="grow">default implementer <select value={cfg.defaults.implementer} onChange={(e) => set('defaults', 'implementer', e.target.value)}>{cfg.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label></div>
        {fallbackProblems(cfg).map((p) => <p key={p} className="small" style={{ color: 'var(--hot)' }}>{p} — ignored until fixed in planestro.yml.</p>)}
        <div className="row"><label><input type="checkbox" checked={cfg.defaults.allow_model_fallback ?? false} onChange={(e) => set('defaults', 'allow_model_fallback', e.target.checked)} /> new items allow their model's fallback (epic children inherit the epic's choice)</label></div>
        <p className="muted small">Edit the model list in <code>planestro.yml</code> (models:). A model's <code>fallback</code> takes over while it is out of usage, for items that allow it; an outage is noticed on the first failed turn and remembered until the provider's reset, or marked here by hand.</p>
      </div>
      <div className="section"><h2>Engine</h2>
        <div className="row"><label>mode <select value={cfg.engine.mode} onChange={(e) => set('engine', 'mode', e.target.value)}><option value="dry-run">dry-run (log what would happen)</option><option value="live">live</option></select></label>
          <label>max sessions <input type="number" min={1} defaultValue={cfg.concurrency.max_sessions} onBlur={(e) => Number(e.target.value) !== cfg.concurrency.max_sessions && set('concurrency', 'max_sessions', Number(e.target.value))} style={{ width: 70 }} /></label>
          <label>max local check jobs <input type="number" min={1} defaultValue={cfg.concurrency.max_local_jobs} onBlur={(e) => Number(e.target.value) !== cfg.concurrency.max_local_jobs && set('concurrency', 'max_local_jobs', Number(e.target.value))} style={{ width: 70 }} /></label></div>
        <div className="row"><label>CI gate <select value={cfg.ci.mode} onChange={(e) => set('ci', 'mode', e.target.value)}><option value="github">GitHub Actions only</option><option value="github-or-local">GitHub, or local checks when Actions is blocked</option></select></label>
          <label><input type="checkbox" checked={cfg.ci.require_green_base} onChange={(e) => set('ci', 'require_green_base', e.target.checked)} /> require green base before merging</label></div>
        <div className="row"><label className="grow">local check command <input className="grow" defaultValue={cfg.ci.local_check_command ?? ''} placeholder="./tools/run_checks.sh --smoke" onBlur={(e) => e.target.value !== (cfg.ci.local_check_command ?? '') && set('ci', 'local_check_command', e.target.value)} /></label></div>
        <div className="row"><label className="grow">on merge, run <input className="grow" defaultValue={cfg.notifications.on_merge ?? ''} placeholder='say "PR merged"' onBlur={(e) => e.target.value !== (cfg.notifications.on_merge ?? '') && set('notifications', 'on_merge', e.target.value)} /></label></div>
        <p className="muted small">Base branch: <b>{cfg.code_repo.default_branch}</b> · release: {cfg.code_repo.release_branch ?? '—'} · GitHub: {cfg.code_repo.github ?? '—'} (edit in planestro.yml)</p>
      </div>
      <div className="section"><h2>Orchestrator</h2>
        <div className="row"><label className="grow">model <select value={findModel(cfg, cfg.orchestrator.model)?.id ?? cfg.orchestrator.model} onChange={(e) => set('orchestrator', 'model', e.target.value)}>
            {!findModel(cfg, cfg.orchestrator.model) && <option value={cfg.orchestrator.model}>{cfg.orchestrator.model}</option>}
            {cfg.models.filter(canPlan).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
          <label><input type="checkbox" checked={cfg.orchestrator.allow_model_fallback ?? false} onChange={(e) => set('orchestrator', 'allow_model_fallback', e.target.checked)} /> allow fallback{(() => { const m = findModel(cfg, cfg.orchestrator.model); return m && fallbackChain(cfg, m).length > 1 ? ` (${fallbackChain(cfg, m).map((x) => x.label).join(' → ')})` : ' (its model has no fallback)'; })()}</label></div>
        <div className="row"><label><input type="checkbox" checked={cfg.orchestrator.may_approve_plans} onChange={(e) => set('orchestrator', 'may_approve_plans', e.target.checked)} /> may approve plans, for items that ask it to</label>
          <label>fix rounds before it is yours <input type="number" min={0} key={cfg.orchestrator.max_plan_revisions} defaultValue={cfg.orchestrator.max_plan_revisions} onBlur={(e) => Number(e.target.value) !== cfg.orchestrator.max_plan_revisions && set('orchestrator', 'max_plan_revisions', Number(e.target.value))} style={{ width: 70 }} /></label></div>
        <div className="row"><label><input type="checkbox" checked={cfg.orchestrator.triage ?? true} onChange={(e) => set('orchestrator', 'triage', e.target.checked)} /> triages stops before they need you</label>
          <label>then yours after <input type="number" min={1} key={cfg.orchestrator.triage_timeout_min} defaultValue={cfg.orchestrator.triage_timeout_min} onBlur={(e) => Number(e.target.value) > 0 && Number(e.target.value) !== cfg.orchestrator.triage_timeout_min && set('orchestrator', 'triage_timeout_min', Number(e.target.value))} style={{ width: 70 }} /> min</label></div>
        <p className="muted small">A block or a worker's question goes to the orchestrator first: it fixes what it can (a retry, a worktree cut from the wrong base, an answer already in the brief) and brings you only a plain decision card, with its recommendation first.</p>
        <div className="row"><label><input type="checkbox" checked={cfg.orchestrator.may_decide_permissions} onChange={(e) => set('orchestrator', 'may_decide_permissions', e.target.checked)} /> may decide workers' permission requests</label></div>
        <p className="muted small">With that on, a worker's request for a command outside its allow-list goes to the orchestrator first: it allows ordinary work inside the item's worktree, denies what is wrong for the item (three denials on one item and the rest come to you), and leaves to you anything that reaches outside the worktree, installs software, or touches credentials. planestro's own hard rules (no pushes, no pull requests, no protected branches, no force flags) apply before anyone is asked.</p>
        <p className="muted small">An item opts in with <b>let the orchestrator approve the plan</b>. The orchestrator then approves the plan, sends it back to the planner with specific fixes, or leaves it to you; once the fix rounds are used it can only approve or leave it to you. It never approves an epic's breakdown or a review hold.</p>
      </div>
      <div className="section"><h2>This machine (planestro.local.yml)</h2>
        <div className="row"><label className="grow">code repo path <input className="grow" defaultValue={state.local.code_repo_path ?? ''} placeholder={state.codeRepo} onBlur={(e) => e.target.value !== (state.local.code_repo_path ?? '') && local('code_repo_path', e.target.value)} /></label></div>
        <div className="row"><label className="grow">worktrees root <input className="grow" defaultValue={state.local.worktrees_root ?? ''} placeholder={cfg.worktrees.root} onBlur={(e) => e.target.value !== (state.local.worktrees_root ?? '') && local('worktrees_root', e.target.value)} /></label></div>
        <div className="row"><label className="grow">claude binary <input className="grow" defaultValue={state.local.claude_bin ?? ''} placeholder="claude (on PATH)" onBlur={(e) => e.target.value !== (state.local.claude_bin ?? '') && local('claude_bin', e.target.value)} /></label></div>
        <div className="row"><label className="grow">codex binary <input className="grow" defaultValue={state.local.codex_bin ?? ''} placeholder="codex (on PATH) — only used by models with runner: codex" onBlur={(e) => e.target.value !== (state.local.codex_bin ?? '') && local('codex_bin', e.target.value)} /></label></div>
        <div className="row"><label className="grow">Anthropic API key <input className="grow" type="password" defaultValue={state.local.anthropic_api_key ?? ''} placeholder="sk-ant-… (optional; otherwise sessions use your Claude Code login)" onBlur={(e) => e.target.value !== (state.local.anthropic_api_key ?? '') && local('anthropic_api_key', e.target.value)} /></label></div>
        <p className="muted small">With a key set, worker sessions bill the API under Anthropic's Commercial Terms (the mode the Agent SDK docs prescribe). Stored only in planestro.local.yml (gitignored). Restart planestro after changing it.</p>
      </div>
      <div className="section"><h2>Data</h2>
        <dl className="small"><dt>dir</dt><dd><code>{state.dataDir}</code></dd><dt>schema</dt><dd>{cfg.schema_version} ({state.schema}) · tool {cfg.tool_version}</dd><dt>git</dt><dd>{state.git.branch} @ {state.git.head ?? '—'} · {state.git.dirty.length} dirty · {state.git.ahead ?? '?'} ahead</dd></dl>
        <div className="row"><button onClick={() => act(() => api.gitCommit())}>Commit now (checkpoint)</button><button onClick={() => act(() => api.gitPush())}>Push</button><button onClick={() => act(() => api.reload())}>Reload from disk</button></div>
        {state.invalid.length > 0 && <ul className="small">{state.invalid.map((i) => <li key={i.path}><code>{i.path}</code>: {i.error}</li>)}</ul>}
      </div>
    </div>
  );
}

function chainText(cfg: Config, m: ModelDef): string {
  const chain = fallbackChain(cfg, m);
  return chain.length > 1 ? `falls back to ${chain.slice(1).map((x) => x.label).join(' → ')}` : '';
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Ask when a model comes back: a local time, or a number of hours from now. */
function askUntil(label: string): string | undefined {
  const later = new Date(Date.now() + 12 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const def = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())} ${pad(later.getHours())}:${pad(later.getMinutes())}`;
  const answer = prompt(`${label} is unavailable until when? A local time (YYYY-MM-DD HH:MM) or a number of hours.`, def);
  if (!answer) return undefined;
  const hours = Number(answer.trim());
  const d = Number.isFinite(hours) && answer.trim() !== '' ? new Date(Date.now() + hours * 3_600_000) : new Date(answer.trim().replace(' ', 'T'));
  if (isNaN(d.getTime()) || d.getTime() <= Date.now()) { alert(`Not a future time: ${answer}`); return undefined; }
  return d.toISOString();
}

