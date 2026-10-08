import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useStore, act } from './store.ts';
import { api } from './api.ts';
import { findModel, usageWindowLabel, usagePercent, localClock, type UsageGuardState } from '@planestro/shared';
import { OrchestratorChat } from './components/OrchestratorChat.tsx';
import { setTitle, setNeeds } from './tabBadge.ts';
import { setNotificationNavigate } from './desktopNotify.ts';
import { TO_WAIT } from './deepLink.ts';

/** The phone's tab bar. Board, Icebox and Done are one tab: the board page switches between them itself. */
const TABS: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Board', icon: 'M4 4h4v12H4zM10 4h4v8h-4zM16 4h4v16h-4z' },
  { to: '/sessions', label: 'Sessions', icon: 'M3 12h4l2.5-7 4 14 2.5-7h5' },
  { to: '/releases', label: 'Releases', icon: 'M4 12l8-8h8v8l-8 8zM15.5 8.5h.01' },
  { to: '/schedules', label: 'Schedules', icon: 'M12 3.5a8.5 8.5 0 1 0 8.5 8.5M12 7v5l3 2M17 3.5h4v4' },
  { to: '/prompts', label: 'Prompts', icon: 'M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5M10 16h5' },
  { to: '/console', label: 'Console', icon: 'M5 7l5 5-5 5M13 17h6' },
  { to: '/settings', label: 'Settings', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
];
/** "PAUSED — usage 87% of 5-hour window · resumes 6:20 pm": why the usage guard stopped automation, and until when. */
function guardPill(g: UsageGuardState): string {
  const pct = usagePercent(g.utilization);
  const what = pct ? `usage ${pct} of ${usageWindowLabel(g.window)} window` : `${usageWindowLabel(g.window)} window ${g.status === 'rejected' ? 'exhausted' : 'near its limit'}`;
  return `PAUSED — ${what} · ${g.resume_at ? `resumes ${localClock(g.resume_at)}` : g.resets_at ? `resets ${localClock(g.resets_at)} · resume by hand` : 'resume by hand'}`;
}
const onBoardTab = (path: string) => path === '/' || /^\/(icebox|done|items)(\/|$)/.test(path);

export function App() {
  const { state, error, connected, connect, updateReady } = useStore();
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const needsFilter = pathname === '/' && new URLSearchParams(search).get('needs') === '1';
  useEffect(() => { if (!pathname.startsWith('/items/') && !pathname.startsWith('/questions/')) setTitle(`${TABS.find((t) => t.to !== '/' && pathname.startsWith(t.to))?.label ?? (pathname === '/icebox' ? 'Icebox' : pathname === '/done' ? 'Done' : 'Board')} · ${state?.config.project.name ?? 'planestro'}`); }, [pathname, state?.config.project.name]);
  useEffect(() => { connect(); }, [connect]);
  // A clicked desktop notification opens its link here, on the panel it is about (#226).
  useEffect(() => { setNotificationNavigate((path) => nav(path)); }, [nav]);
  const needs = state?.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board') ?? [];
  const needsHot = needs.some((i) => i.frontmatter.blocked);
  // A background tab shows it too: "(2) …" in its title and a dot on its icon.
  useEffect(() => { setNeeds(needs.length, needsHot); }, [needs.length, needsHot]);
  const active = state?.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status)) ?? [];
  const inReview = state?.items.filter((i) => i.frontmatter.status === 'IN_REVIEW') ?? [];
  const paused = state?.engine.paused ?? false;
  const guards = Object.entries(state?.engine.provider_guards ?? {});
  const provider = state && findModel(state.config, state.config.orchestrator.model)?.runner;
  const providerLabel = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Not set';
  const switchProviderPath = provider ? `/switch-provider?provider=${provider === 'codex' ? 'claude' : 'codex'}` : '/switch-provider';
  // A turn queued for its runner's slot is not an agent running yet.
  const running = state?.engine.sessions.filter((s) => s.busy).length ?? 0;
  const restart = state?.engine.restart;
  const engineLabel = !connected ? 'Reconnecting' : paused ? 'Paused' : restart?.draining ? restart.by === 'update' ? 'Updating' : 'Draining' : state?.engine.mode === 'live' ? 'Live' : 'Dry-run';
  const runnerStalls = state?.engine.runner_stalls ?? [];
  const statusWarning = paused || restart?.draining || guards.length > 0 || (state?.engine.ci_queue?.queued ?? 0) > 0 || runnerStalls.length > 0;
  const notes = useStore((s) => s.notes); const notesSeen = useStore((s) => s.notesSeen);
  const unreadNotes = notes.filter((n) => n.ts > notesSeen).length;
  return (
    <div className="app">
      {updateReady && <button className="banner warn" style={{ border: 0, borderRadius: 0, textAlign: 'left' }} onClick={() => location.reload()}>planestro was updated — click to reload (held back so nothing you were typing is lost)</button>}
      <header className="topbar">
        <Link className="brand" to="/" title={`${state?.config.project.name ?? 'planestro'} · Board`}><img className="logo" src="/favicon.svg" alt="" width={22} height={22} /> <span className="wordmark">planestro</span> <span className="project">{state?.config.project.name ?? '…'}</span>
          <span className="engine phone-only">{paused ? 'paused' : state?.engine.restart?.draining && state.engine.restart.by === 'update' ? 'updating' : state?.engine.mode === 'live' ? 'live' : 'dry-run'} · {running} agent{running === 1 ? '' : 's'} running</span></Link>
        <nav>
          <NavLink to="/" end>Board</NavLink>
          <NavLink to="/icebox">Icebox</NavLink>
          <NavLink to="/done">Done</NavLink>
          <NavLink to="/sessions">Sessions</NavLink>
          <NavLink to="/releases">Releases</NavLink>
          <NavLink to="/schedules">Schedules</NavLink>
          <NavLink to="/prompts">Prompts</NavLink>
          <NavLink to="/console" className={({ isActive }) => (isActive || pathname.startsWith('/questions/') ? 'active' : '')}>Console{unreadNotes > 0 && <span className="badge-n" title="Suggestions about planestro from the orchestrator">{unreadNotes}</span>}</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="status">
          <button className={`status-trigger ${statusWarning ? 'warn' : ''}`} popoverTarget="engine-status" aria-label={`Automation status: ${engineLabel}. View details`} title="Activity, connection and usage details"><span className={`dot ${!connected ? 'off' : statusWarning ? 'warn' : state?.engine.mode === 'live' ? 'on' : ''}`} /><span className="status-label">{engineLabel}</span><span className="status-count">· {running} agent{running === 1 ? '' : 's'}</span></button>
          <div id="engine-status" popover="auto" className="status-popover" onClick={(e) => { if ((e.target as HTMLElement).closest('a')) e.currentTarget.hidePopover(); }}>
            <div className="status-popover-heading"><strong>Automation · {engineLabel}</strong><button popoverTarget="engine-status" popoverTargetAction="hide" aria-label="Close automation status">×</button></div>
            <dl><dt>Agents running</dt><dd>{running}</dd><dt>Active items</dt><dd>{active.length}</dd><dt>PRs in review</dt><dd>{inReview.length}</dd><dt>Connection</dt><dd>{connected ? 'Connected' : 'Reconnecting'}</dd></dl>
            {restart?.draining && <p>{restart.by === 'update' ? `Updating planestro: ${restart.idle ? 'restarting now' : `waiting for ${restart.running.join(', ')} to finish`}. Automation resumes after the restart.` : restart.idle ? 'Safe to restart: nothing is running.' : `Draining: waiting for ${restart.running.join(', ')} to finish. Nothing new starts meanwhile.`}</p>}
            {paused && state?.engine.paused_by === 'disk' && state.engine.disk_guard && <p className="status-notice">Disk nearly full · {state.engine.disk_guard.free_gib} GiB free on {state.engine.disk_guard.path}. Automation resumes once there is {state.config.disk_guard.resume_free_gib} GiB free.</p>}
            {state?.engine.ci_queue && state.engine.ci_queue.queued > 0 && <p className="status-notice">CI queue · {state.engine.ci_queue.queued} waiting · {state.engine.ci_queue.running} running.{state.config.ci.max_queued_runs > 0 && state.engine.ci_queue.queued >= state.config.ci.max_queued_runs ? ' New items are waiting for capacity.' : ''}</p>}
            {guards.map(([provider, guard]) => <div key={provider} className="status-notice"><p>{provider === 'codex' ? 'Codex' : 'Claude'}: {guardPill(guard)}</p><button onClick={() => act(() => api.retryProvider(provider))}>Retry {provider === 'codex' ? 'Codex' : 'Claude'}</button></div>)}
            <Link to="/console">Open Console →</Link>
          </div>
          <button className={`needs ${needsHot ? 'hot' : needs.length ? 'wait' : ''} ${needsFilter ? 'on' : ''}`} aria-pressed={needsFilter} onClick={() => (needsFilter ? nav('/') : needs.length === 1 ? nav(`/items/${needs[0].id}`, { state: TO_WAIT }) : nav('/?needs=1'))} aria-label={`${needs.length} items need you${needsFilter ? ': showing only these, tap to show all' : ''}`} title={needsFilter ? 'The board shows only items waiting on you: show all' : needs.length === 1 ? `${needs[0].id} is waiting on you: open it on what it waits for` : 'Items waiting on you (red: one of them is blocked)'}><span className="dot" /> <span className="desk-only">Needs you</span><span>{needs.length}</span></button>
          {state && <Link className="button provider-switch-button" to={switchProviderPath} aria-label={`Provider: ${providerLabel}. Switch provider`} title={`Orchestrator provider: ${providerLabel}. Open provider switching. Individual items may use another provider.`}><span className="desk-only">Provider: </span>{providerLabel}</Link>}
          <button className={`lever ${paused ? 'paused' : ''}`} aria-label={`${paused ? 'Resume' : 'Pause'} automation`} title={`${paused ? 'Resume' : 'Pause'} automation`} onClick={() => act(() => (paused ? api.resume() : api.pause()))}>{paused ? 'Resume' : 'Pause'}</button>
        </div>
      </header>
      {error && <div className="banner error">{error}</div>}
      {runnerStalls.map((r) => <div key={r.label} className="banner warn">Runner {r.label} looks stalled or offline: {r.items.join(', ')} {r.items.length === 1 ? 'is' : 'are'} waiting on it. They wait for CI again once a runner takes a job.</div>)}
      {state?.readOnly && <div className="banner warn">Data dir schema is {state.config.schema_version} ({state.schema}) — read-only until migrated.</div>}
      {state?.invalid.length ? <div className="banner warn">{state.invalid.length} invalid file(s): {state.invalid.map((i) => `${i.path.split('/').pop()} — ${i.error}`).join('; ')}</div> : null}
      <main>
        <Outlet />
      </main>
      {state && <OrchestratorChat />}
      <nav className="tabbar">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={() => (t.to === '/' ? onBoardTab(pathname) : pathname.startsWith(t.to) || (t.to === '/console' && pathname.startsWith('/questions/'))) ? 'active' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
            <span>{t.label}{t.to === '/console' && unreadNotes > 0 && <span className="badge-n">{unreadNotes}</span>}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
