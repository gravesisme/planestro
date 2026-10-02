import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useStore, act } from './store.ts';
import { api } from './api.ts';
import { usageWindowLabel, usagePercent, localClock, type UsageGuardState } from '@planestro/shared';
import { OrchestratorChat } from './components/OrchestratorChat.tsx';
import { setTitle, setNeeds } from './tabBadge.ts';

/** The phone's tab bar. Board, Icebox and Done are one tab: the board page switches between them itself. */
const TABS: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Board', icon: 'M4 4h4v12H4zM10 4h4v8h-4zM16 4h4v16h-4z' },
  { to: '/sessions', label: 'Sessions', icon: 'M3 12h4l2.5-7 4 14 2.5-7h5' },
  { to: '/releases', label: 'Releases', icon: 'M4 12l8-8h8v8l-8 8zM15.5 8.5h.01' },
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
  const { pathname } = useLocation();
  useEffect(() => { if (!pathname.startsWith('/items/') && !pathname.startsWith('/questions/')) setTitle(`${TABS.find((t) => t.to !== '/' && pathname.startsWith(t.to))?.label ?? (pathname === '/icebox' ? 'Icebox' : pathname === '/done' ? 'Done' : 'Board')} · ${state?.config.project.name ?? 'planestro'}`); }, [pathname, state?.config.project.name]);
  useEffect(() => { connect(); }, [connect]);
  const needs = state?.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board') ?? [];
  const needsHot = needs.some((i) => i.frontmatter.blocked);
  // A background tab shows it too: "(2) …" in its title and a dot on its icon.
  useEffect(() => { setNeeds(needs.length, needsHot); }, [needs.length, needsHot]);
  const active = state?.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status)) ?? [];
  const inReview = state?.items.filter((i) => i.frontmatter.status === 'IN_REVIEW') ?? [];
  const paused = state?.engine.paused ?? false;
  const guard = paused && state?.engine.paused_by === 'usage_guard' ? state.engine.usage_guard : undefined;
  // A turn queued for its runner's slot is not an agent running yet.
  const running = state?.engine.sessions.filter((s) => s.busy).length ?? 0;
  const notes = useStore((s) => s.notes); const notesSeen = useStore((s) => s.notesSeen);
  const unreadNotes = notes.filter((n) => n.ts > notesSeen).length;
  return (
    <div className="app">
      {updateReady && <button className="banner warn" style={{ border: 0, borderRadius: 0, textAlign: 'left' }} onClick={() => location.reload()}>planestro was updated — click to reload (held back so nothing you were typing is lost)</button>}
      <header className="topbar">
        <Link className="brand" to="/" title="Board"><img className="logo" src="/favicon.svg" alt="" width={22} height={22} /> <span className="wordmark">planestro</span> <span className="project">{state?.config.project.name ?? '…'}</span>
          <span className="engine phone-only">{paused ? 'paused' : state?.engine.restart?.draining && state.engine.restart.by === 'update' ? 'updating' : state?.engine.mode === 'live' ? 'live' : 'dry-run'} · {running} agent{running === 1 ? '' : 's'} running</span></Link>
        <nav>
          <NavLink to="/" end>Board</NavLink>
          <NavLink to="/icebox">Icebox</NavLink>
          <NavLink to="/done">Done</NavLink>
          <NavLink to="/sessions">Sessions</NavLink>
          <NavLink to="/releases">Releases</NavLink>
          <NavLink to="/prompts">Prompts</NavLink>
          <NavLink to="/console" className={({ isActive }) => (isActive || pathname.startsWith('/questions/') ? 'active' : '')}>Console{unreadNotes > 0 && <span className="badge-n" title="Suggestions about planestro from the orchestrator">{unreadNotes}</span>}</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="status">
          <button className={`needs ${needsHot ? 'hot' : needs.length ? 'wait' : ''}`} onClick={() => nav('/?needs=1')} title="Items waiting on you (red: one of them is blocked)"><span className="dot" /> <span className="desk-only">NEEDS YOU · </span>{needs.length}</button>
          {state?.engine.restart?.draining
            // Getting ready to restart takes the summary's place: it is the one thing that matters until the restart.
            ? state.engine.restart.by === 'update'
              // serve --watch restarting onto new planestro code (#90): it resumes by itself, so there is nothing to press.
              ? <button className="needs wait" onClick={() => nav('/console')} title={`Updating planestro: ${state.engine.restart.idle ? 'restarting now' : `waiting for ${state.engine.restart.running.join(', ')} to finish`}. Nothing new starts meanwhile; automation carries on by itself after the restart.`}>↻ <span className="desk-only">UPDATING{state.engine.restart.running.length ? ' · waiting for ' : ''}</span>{state.engine.restart.running.length ? <><span className="desk-only">{state.engine.restart.running[0]}{state.engine.restart.running.length > 1 ? ` +${state.engine.restart.running.length - 1}` : ''}</span><span className="phone-only">{state.engine.restart.running.length}</span></> : null}</button>
              : <button className={`needs ${state.engine.restart.idle ? 'safe' : 'wait'}`} onClick={() => nav('/console')} title={state.engine.restart.idle ? 'Nothing is running: restarting planestro loses nothing' : `Still running: ${state.engine.restart.running.join(', ')}`}>{state.engine.restart.idle ? <>↻ <span className="desk-only">SAFE TO RESTART</span><span className="phone-only">OK</span></> : <>↻ <span className="desk-only">DRAINING · </span>{state.engine.restart.running.length}</>}</button>
            : <span className="summary">{paused ? '⏸ PAUSED' : `● ${state?.engine.mode === 'live' ? 'LIVE' : 'DRY-RUN'}`} · {running} agents active · {active.length} active items · {inReview.length} PR{inReview.length === 1 ? '' : 's'} in review</span>}
          {paused && state?.engine.paused_by === 'disk' && state.engine.disk_guard && <span className="usage-pill" title={`The disk guard paused automation at ${new Date(state.engine.disk_guard.tripped_at).toLocaleString()}: ${state.engine.disk_guard.free_gib} GiB free on ${state.engine.disk_guard.path}. Running turns finish, nothing new starts; it resumes by itself once there is ${state.config.disk_guard.resume_free_gib} GiB free.`}>disk nearly full · {state.engine.disk_guard.free_gib} GiB free</span>}
          {state?.engine.ci_queue && state.engine.ci_queue.queued > 0 && <span className="usage-pill" title={`CI runners: ${state.engine.ci_queue.queued} runs waiting for a runner, ${state.engine.ci_queue.running} running. Time queued does not count toward a run's timeout.${state.config.ci.max_queued_runs > 0 ? ` New items wait to start while ${state.config.ci.max_queued_runs} or more are queued.` : ''}`}>CI queue · {state.engine.ci_queue.queued} waiting{state.config.ci.max_queued_runs > 0 && state.engine.ci_queue.queued >= state.config.ci.max_queued_runs ? ' · starts held' : ''}</span>}
          {guard && <span className="usage-pill" title={`The usage guard paused automation at ${new Date(guard.tripped_at).toLocaleString()}; running turns finish, nothing new starts.${guard.resume_at ? ' It resumes on its own once the window resets.' : ''}`}>{guardPill(guard)}</span>}
          <button className={`lever ${paused ? 'paused' : ''}`} onClick={() => act(() => (paused ? api.resume() : api.pause()))}>{paused ? 'RESUME' : 'PAUSE'}<span className="desk-only"> AUTOMATION</span></button>
          <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'connected' : 'reconnecting'} />
        </div>
      </header>
      {error && <div className="banner error">{error}</div>}
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
