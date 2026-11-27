import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { useStore, act } from './store.ts';
import { api } from './api.ts';
import { findModel, limitsLabel, guardSays, guardProviderLabel, guardNeedsYou, guardWindowReset } from '@planestro/shared/view';
import { OrchestratorChat } from './components/OrchestratorChat.tsx';
import { setTitle, setNeeds } from './tabBadge.ts';
import { setNotificationNavigate } from './desktopNotify.ts';
import { TO_WAIT } from './deepLink.ts';
import { runningItems, runningLabel } from './agentState.ts';
import { unreadNoteCount } from './noteWindow.ts';
import { modeNote } from './engineMode.ts';
import { ActionButton } from './components/ActionButton.tsx';
import { ConcurrencyControl } from './components/ConcurrencyControl.tsx';

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
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The time, redrawn when the next of `times` passes: a guard's wording changes at its window's reset with no event from the server. */
function useNowAt(times: number[]): number {
  const [now, setNow] = useState(() => Date.now());
  const next = Math.min(...times.filter((t) => Number.isFinite(t) && t > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const t = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0) + 250, MAX_TIMER_MS));
    return () => clearTimeout(t);
  }, [next]);
  return now;
}
const onBoardTab = (path: string) => path === '/' || /^\/(icebox|done|items)(\/|$)/.test(path);

/** A running session's last output, live from the stream: subscribed here alone, so a printed line redraws one line. */
function RunLine({ item, fallback }: { item: string; fallback?: string }) {
  const text = useStore((s) => s.lastOutput?.[item]) ?? fallback;
  return text ? <div className="small muted run-line" title={text}>{text}</div> : null;
}

export function App() {
  // Only what it draws: the whole store changes with every console line.
  const { state, error, connected, connect, updateReady } = useStore(useShallow((s) => ({ state: s.state, error: s.error, connected: s.connected, connect: s.connect, updateReady: s.updateReady })));
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const needsFilter = pathname === '/' && new URLSearchParams(search).get('needs') === '1';
  useEffect(() => { if (!pathname.startsWith('/items/') && !pathname.startsWith('/questions/') && pathname !== '/projects' && pathname !== '/usage') setTitle(`${TABS.find((t) => t.to !== '/' && pathname.startsWith(t.to))?.label ?? (pathname === '/icebox' ? 'Icebox' : pathname === '/done' ? 'Done' : 'Board')} · ${state?.config.project.name ?? 'planestro'}`); }, [pathname, state?.config.project.name]);
  useEffect(() => { connect(); }, [connect]);
  // A clicked desktop notification opens its link here, on the panel it is about (#226).
  useEffect(() => { setNotificationNavigate((path) => nav(path)); }, [nav]);
  const needs = state?.items.filter((i) => i.derived.needs_you && i.derived.lane === 'board') ?? [];
  const needsHot = needs.some((i) => i.frontmatter.blocked);
  const active = state?.items.filter((i) => ['PLAN_IN_PROGRESS', 'PLAN_READY', 'IN_PROGRESS', 'IN_REVIEW', 'MERGED'].includes(i.frontmatter.status)) ?? [];
  const inReview = state?.items.filter((i) => i.frontmatter.status === 'IN_REVIEW') ?? [];
  const paused = state?.engine.paused ?? false;
  const guards = Object.entries(state?.engine.provider_guards ?? {});
  const guardCfg = { auto_resume: state?.config.usage_guard?.auto_resume ?? false };
  const now = useNowAt(guards.flatMap(([, g]) => [g.resets_at, g.resume_at].flatMap((t) => (t ? [Date.parse(t)] : []))));
  // A provider whose window has reset and that only a Retry by hand restarts waits on the user as an item does (#579).
  const guardsWaiting = guards.filter(([, g]) => guardNeedsYou(g, guardCfg, now));
  const guardNames = guards.map(([key]) => guardProviderLabel(key));
  const guardedLabel = guardNames.length === 1 ? `${guardNames[0]} paused` : guardNames.length > 1 ? `${guardNames.length} providers paused` : undefined;
  // Said on the guard's banner after the lever is pressed while a provider is paused: the lever is not what clears it.
  const guardsNow = guards.map(([key, g]) => `${key}@${g.tripped_at}`).join(' ');
  const [leverPress, setLeverPress] = useState<{ said: 'paused' | 'resumed'; guards: string }>();
  const leverSaid = leverPress && leverPress.guards === guardsNow ? leverPress.said : undefined;
  const needsCount = needs.length + guardsWaiting.length;
  // A background tab shows it too: "(2) …" in its title and a dot on its icon.
  useEffect(() => { setNeeds(needsCount, needsHot); }, [needsCount, needsHot]);
  const provider = state && findModel(state.config, state.config.orchestrator.model)?.runner;
  const providerLabel = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Not set';
  const switchProviderPath = provider ? `/switch-provider?provider=${provider === 'codex' ? 'claude' : 'codex'}` : '/switch-provider';
  // A turn queued for its runner's slot is not an agent running yet.
  const runningNow = state ? runningItems(state) : [];
  const running = runningNow.length;
  // "2 of 3": the agents running against max_sessions, and what waits for a slot (#330).
  const slots = state?.engine.slots;
  const max = slots?.max ?? state?.config.concurrency?.max_sessions;
  const [statusOpen, setStatusOpen] = useState(false);
  const restart = state?.engine.restart;
  const engineLabel = !connected ? 'Reconnecting' : paused ? 'Paused' : restart?.draining ? restart.by === 'update' ? 'Updating' : 'Draining' : guardedLabel ?? (state?.engine.mode === 'live' ? 'Live' : 'Dry-run');
  const runnerStalls = state?.engine.runner_stalls ?? [];
  const statusWarning = paused || restart?.draining || state?.engine.modes?.restart_to_apply || guards.length > 0 || (state?.engine.ci_queue?.queued ?? 0) > 0 || runnerStalls.length > 0;
  const notes = useStore((s) => s.notes); const notesSeen = useStore((s) => s.notesSeen);
  const unreadNotes = unreadNoteCount(notes, notesSeen);
  return (
    <div className="app">
      {/* iOS 26+ blurs the top of an installed app unless a fixed box with a background sits on its top edge (#558) */}
      <div className="edge-strip" aria-hidden="true" />
      {updateReady && <button className="banner warn" style={{ border: 0, borderRadius: 0, textAlign: 'left' }} onClick={() => location.reload()}>planestro was updated — click to reload (held back so nothing you were typing is lost)</button>}
      <header className="topbar">
        <Link className="brand" to="/" title={`${state?.config.project.name ?? 'planestro'} · Board`}><img className="logo" src="/favicon.svg" alt="" width={22} height={22} /> <span className="wordmark">planestro</span> <span className="project">{state?.config.project.name ?? '…'}</span>
          <span className="engine phone-only">{paused ? 'paused' : state?.engine.restart?.draining && state.engine.restart.by === 'update' ? 'updating' : guardedLabel ?? (state?.engine.mode === 'live' ? 'live' : 'dry-run')} · {running}{max !== undefined ? ` of ${max}` : ''} agent{(max ?? running) === 1 ? '' : 's'} running</span></Link>
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
          <button className={`status-trigger ${statusWarning ? 'warn' : ''}`} popoverTarget="engine-status" aria-label={`Automation status: ${engineLabel}. View details`} title="Activity, connection and usage details"><span className={`dot ${!connected ? 'off' : statusWarning ? 'warn' : state?.engine.mode === 'live' ? 'on' : ''}`} /><span className="status-label">{engineLabel}</span><span className="status-count">· {running}{max !== undefined ? ` of ${max}` : ''} agent{(max ?? running) === 1 ? '' : 's'}{slots?.waiting ? ` · ${slots.waiting} waiting` : ''}</span></button>
          <div id="engine-status" popover="auto" className="status-popover" onToggle={(e) => setStatusOpen((e as unknown as ToggleEvent).newState === 'open')} onClick={(e) => { if ((e.target as HTMLElement).closest('a')) e.currentTarget.hidePopover(); }}>
            <div className="status-popover-heading"><strong>Automation · {engineLabel}</strong><button popoverTarget="engine-status" popoverTargetAction="hide" aria-label="Close automation status">×</button></div>
            {state && <ConcurrencyControl slots={slots} open={statusOpen} />}
            {running > 0 && <div className="status-running"><div className="status-running-head"><span>Running now</span><Link to="/?running=1">Show on the board</Link></div>
              <ul>{runningNow.map(({ session, item }) => <li key={session.item}><Link to={`/items/${session.item}`}><span className="id">{session.item}</span> {item?.frontmatter.title ?? ''}</Link><span className="small muted"> · {runningLabel(session.op)}</span><RunLine item={session.item} fallback={session.last_output} /></li>)}</ul></div>}
            <dl><dt>Agents running</dt><dd>{running}</dd><dt>Active items</dt><dd>{active.length}</dd><dt>PRs in review</dt><dd>{inReview.length}</dd><dt>Connection</dt><dd>{connected ? 'Connected' : 'Reconnecting'}</dd></dl>
            {restart?.draining && <p>{restart.by === 'update' ? `Updating planestro: ${restart.idle ? 'restarting now' : `waiting for ${restart.running.join(', ')} to finish`}. Automation resumes after the restart.` : restart.idle ? 'Safe to restart: nothing is running.' : `Draining: waiting for ${restart.running.join(', ')} to finish. Nothing new starts meanwhile.`}</p>}
            {paused && state?.engine.paused_by === 'disk' && state.engine.disk_guard && <p className="status-notice">Disk nearly full · {state.engine.disk_guard.free_gib} GiB free on {state.engine.disk_guard.path}. Automation resumes once there is {state.config.disk_guard.resume_free_gib} GiB free.</p>}
            {state?.engine.ci_queue && state.engine.ci_queue.queued > 0 && <p className="status-notice">CI queue · {state.engine.ci_queue.queued} waiting · {state.engine.ci_queue.running} running.{state.config.ci.max_queued_runs > 0 && state.engine.ci_queue.queued >= state.config.ci.max_queued_runs ? ' New items are waiting for capacity.' : ''}</p>}
            {guards.map(([provider, guard]) => <div key={provider} className="status-notice"><p>{guardSays(provider, guard, guardCfg, now)}. The Pause / Resume button does not clear this.</p><ActionButton working="Retrying…" onAct={() => act(() => api.retryProvider(provider))}>Retry {guardProviderLabel(provider)}</ActionButton></div>)}
            <div className="status-links"><Link to="/console">Open Console →</Link><Link to="/usage">Usage →</Link><Link to="/projects">All projects →</Link></div>
          </div>
          <button className={`needs ${needsHot ? 'hot' : needsCount ? 'wait' : ''} ${needsFilter ? 'on' : ''}`} aria-pressed={needsFilter} onClick={() => (needsFilter ? nav('/') : !needs.length && guardsWaiting.length ? document.getElementById('provider-guards')?.querySelector('button')?.focus() : needs.length === 1 && !guardsWaiting.length ? nav(`/items/${needs[0].id}`, { state: TO_WAIT }) : nav('/?needs=1'))} aria-label={`${needs.length === 1 ? '1 item needs' : `${needs.length} items need`} you${guardsWaiting.length ? `, and ${guardsWaiting.map(([key]) => guardProviderLabel(key)).join(' and ')} ${guardsWaiting.length === 1 ? 'waits' : 'wait'} for your retry` : ''}${needsFilter ? ': showing only these, tap to show all' : ''}`} title={needsFilter ? 'The board shows only items waiting on you: show all' : guardsWaiting.length ? `${guardsWaiting.map(([key]) => `${guardProviderLabel(key)} usage window has reset: press Retry ${guardProviderLabel(key)}`).join('. ')}${needs.length ? `. ${needs.length === 1 ? '1 item is' : `${needs.length} items are`} waiting on you too` : ''}` : needs.length === 1 ? `${needs[0].id} is waiting on you: open it on what it waits for` : 'Items waiting on you (red: one of them is blocked)'}><span className="dot" /> <span className="desk-only">Needs you</span><span>{needsCount}</span></button>
          {state && <Link className="button provider-switch-button" to={switchProviderPath} aria-label={`Provider: ${providerLabel}. Switch provider`} title={`Orchestrator provider: ${providerLabel}. Open provider switching. Individual items may use another provider.`}><span className="desk-only">Provider: </span>{providerLabel}</Link>}
          <ActionButton className={`lever ${paused ? 'paused' : ''}`} aria-label={`${paused ? 'Resume' : 'Pause'} automation`} title={`${paused ? 'Resume' : 'Pause'} automation${guardNames.length ? `. This does not clear a usage pause: ${guardNames.map((n) => `Retry ${n}`).join(' and ')} does` : ''}`} working={paused ? 'Resuming…' : 'Pausing…'} onAct={async () => { const said = paused ? 'resumed' : 'paused'; const done = await act(() => (paused ? api.resume() : api.pause())); if (done && guards.length) setLeverPress({ said, guards: guardsNow }); }}>{paused ? 'Resume' : 'Pause'}</ActionButton>
        </div>
      </header>
      {guards.length > 0 && <div id="provider-guards" className="banner warn guard-banner" role="status">
        {guards.map(([key, guard]) => <div key={key} className={`guard-row ${guardNeedsYou(guard, guardCfg, now) ? 'waits' : ''}`}>
          <span className="guard-says">{guardWindowReset(guard, now) ? <strong>{guardSays(key, guard, guardCfg, now)}</strong> : guardSays(key, guard, guardCfg, now)}</span>
          <ActionButton className={guardNeedsYou(guard, guardCfg, now) ? 'primary' : ''} working="Retrying…" title={`Start ${guardProviderLabel(key)} again now`} onAct={() => act(() => api.retryProvider(key))}>Retry {guardProviderLabel(key)}</ActionButton>
        </div>)}
        {leverSaid && <div className="guard-lever-note">Automation {leverSaid}. That button does not clear a usage pause: {guardNames.join(' and ')} {guardNames.length === 1 ? 'stays' : 'stay'} paused until you press {guardNames.map((n) => `Retry ${n}`).join(' and ')}.</div>}
      </div>}
      {error && <div className="banner error">{error}</div>}
      {modeNote(state?.engine.modes) && <div className="banner warn" role="status">Engine mode · {modeNote(state?.engine.modes)}</div>}
      {slots?.stepped_down && <div className="banner warn">planestro stepped concurrency down to {limitsLabel(slots.stepped_down.to)}{slots.stepped_down.reason ? `: ${slots.stepped_down.reason.replace(/^stepped down: /, '')}` : ''}. Raise it again from the status menu once the machine is healthy.</div>}
      {runnerStalls.map((r) => <div key={r.label} className="banner warn">{(r.said ?? `runner ${r.label} looks stalled or offline`).replace(/^r/, 'R')}: {r.items.join(', ')} {r.items.length === 1 ? 'is' : 'are'} waiting on it. They wait for CI again once a runner takes a job.</div>)}
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
