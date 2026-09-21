import { useEffect } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useStore, act } from './store.ts';
import { api } from './api.ts';

/** The phone's tab bar. Board, Icebox and Done are one tab: the board page switches between them itself. */
const TABS: { to: string; label: string; icon: string }[] = [
  { to: '/', label: 'Board', icon: 'M4 4h4v12H4zM10 4h4v8h-4zM16 4h4v16h-4z' },
  { to: '/sessions', label: 'Sessions', icon: 'M3 12h4l2.5-7 4 14 2.5-7h5' },
  { to: '/prompts', label: 'Prompts', icon: 'M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5M10 16h5' },
  { to: '/console', label: 'Console', icon: 'M5 7l5 5-5 5M13 17h6' },
  { to: '/settings', label: 'Settings', icon: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4' },
];
const onBoardTab = (path: string) => path === '/' || /^\/(icebox|done|items)(\/|$)/.test(path);

export function App() {
  const { state, error, connected, connect, updateReady } = useStore();
  const nav = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => { if (!pathname.startsWith('/items/')) document.title = `${TABS.find((t) => t.to !== '/' && pathname.startsWith(t.to))?.label ?? (pathname === '/icebox' ? 'Icebox' : pathname === '/done' ? 'Done' : 'Board')} · ${state?.config.project.name ?? 'planestro'}`; }, [pathname, state?.config.project.name]);
  useEffect(() => { connect(); }, [connect]);
  const needs = state?.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board') ?? [];
  const active = state?.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status)) ?? [];
  const inReview = state?.items.filter((i) => i.frontmatter.status === 'IN_REVIEW') ?? [];
  const paused = state?.engine.paused ?? false;
  return (
    <div className="app">
      {updateReady && <button className="banner warn" style={{ border: 0, borderRadius: 0, textAlign: 'left' }} onClick={() => location.reload()}>planestro was updated — click to reload (held back so nothing you were typing is lost)</button>}
      <header className="topbar">
        <Link className="brand" to="/" title="Board"><img className="logo" src="/favicon.svg" alt="" width={22} height={22} /> <span className="wordmark">planestro</span> <span className="project">{state?.config.project.name ?? '…'}</span>
          <span className="engine phone-only">{paused ? 'paused' : state?.engine.mode === 'live' ? 'live' : 'dry-run'} · {state?.engine.sessions.length ?? 0} agent{state?.engine.sessions.length === 1 ? '' : 's'} running</span></Link>
        <nav>
          <NavLink to="/" end>Board</NavLink>
          <NavLink to="/icebox">Icebox</NavLink>
          <NavLink to="/done">Done</NavLink>
          <NavLink to="/sessions">Sessions</NavLink>
          <NavLink to="/prompts">Prompts</NavLink>
          <NavLink to="/console">Console</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <div className="status">
          <button className={`needs ${needs.some((i) => i.frontmatter.blocked) ? 'hot' : needs.length ? 'wait' : ''}`} onClick={() => nav('/?needs=1')} title="Items waiting on you (red: one of them is blocked)"><span className="dot" /> <span className="desk-only">NEEDS YOU · </span>{needs.length}</button>
          <span className="summary">{paused ? '⏸ PAUSED' : `● ${state?.engine.mode === 'live' ? 'LIVE' : 'DRY-RUN'}`} · {state?.engine.sessions.length ?? 0} agents active · {active.length} active items · {inReview.length} PR{inReview.length === 1 ? '' : 's'} in review</span>
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
      <nav className="tabbar">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={() => (t.to === '/' ? onBoardTab(pathname) : pathname.startsWith(t.to)) ? 'active' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
