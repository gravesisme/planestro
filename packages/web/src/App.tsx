import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useStore, act } from './store.ts';
import { api } from './api.ts';

export function App() {
  const { state, error, connected, connect } = useStore();
  const nav = useNavigate();
  useEffect(() => { connect(); }, [connect]);
  const needs = state?.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board') ?? [];
  const active = state?.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status)) ?? [];
  const inReview = state?.items.filter((i) => i.frontmatter.status === 'IN_REVIEW') ?? [];
  const paused = state?.engine.paused ?? false;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo">◆</span> planestro <span className="project">{state?.config.project.name ?? '…'}</span></div>
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
          <button className={`needs ${needs.length ? 'hot' : ''}`} onClick={() => nav('/?needs=1')} title="Items waiting on you">🔴 NEEDS YOU · {needs.length}</button>
          <span className="summary">{paused ? '⏸ PAUSED' : `● ${state?.engine.mode === 'live' ? 'LIVE' : 'DRY-RUN'}`} · {state?.engine.sessions.length ?? 0} agents active · {active.length} active items · {inReview.length} PR{inReview.length === 1 ? '' : 's'} in review</span>
          <button className={`lever ${paused ? 'paused' : ''}`} onClick={() => act(() => (paused ? api.resume() : api.pause()))}>{paused ? 'RESUME AUTOMATION' : 'PAUSE AUTOMATION'}</button>
          <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'connected' : 'reconnecting'} />
        </div>
      </header>
      {error && <div className="banner error">{error}</div>}
      {state?.readOnly && <div className="banner warn">Data dir schema is {state.config.schema_version} ({state.schema}) — read-only until migrated.</div>}
      {state?.invalid.length ? <div className="banner warn">{state.invalid.length} invalid file(s): {state.invalid.map((i) => `${i.path.split('/').pop()} — ${i.error}`).join('; ')}</div> : null}
      <main><Outlet /></main>
    </div>
  );
}
