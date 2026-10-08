import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { localClock, usageWindowLabel } from '@planestro/shared';
import { api, type ProjectRow } from '../api.ts';
import { setTitle } from '../tabBadge.ts';
import { projectHref } from '../projectLink.ts';
import { ActionButton } from '../components/ActionButton.tsx';

// ---- every project on this machine at a glance (#235) ----
// Read-only: this server asks the others for their state (server-side, a short timeout each), and the page
// only links to them. A server that does not answer says so; it never takes the page down.

const REFRESH_MS = 15_000;
const provider = (p: string) => (p === 'codex' ? 'Codex' : p === 'claude' ? 'Claude' : p);

/** The guard and pause state in a few words, or undefined when automation runs freely. */
function guardText(s: NonNullable<ProjectRow['summary']>): string[] {
  const out: string[] = [];
  if (s.paused) out.push(s.paused_by === 'disk' ? 'Paused: disk nearly full' : 'Paused');
  for (const g of s.guards) out.push(`${provider(g.provider)} usage guard (${usageWindowLabel(g.window)})${g.resume_at ? ` · resumes ${localClock(g.resume_at)}` : g.resets_at ? ` · resets ${localClock(g.resets_at)}` : ''}`);
  if (s.read_only) out.push('Read-only');
  return out;
}

function Count({ n, label, tone }: { n: number; label: string; tone?: 'wait' | 'hot' | 'run' }) {
  return <div className={`project-count ${n > 0 && tone ? tone : ''}`}><strong>{n}</strong><span>{label}</span></div>;
}

function ProjectCard({ p }: { p: ProjectRow }) {
  const href = projectHref(p);
  const s = p.summary;
  const name = <span className="project-name">{p.name}</span>;
  const guards = s ? guardText(s) : [];
  return (
    <li className={`project-card ${p.reach}`}>
      <div className="project-head">
        {p.self ? <Link to="/">{name}</Link> : href ? <a href={href} target="_blank" rel="noopener">{name}</a> : name}
        {p.self ? <span className="pill">this one</span> : p.reach === 'unreachable' ? <span className="pill blocked">unreachable</span> : p.reach === 'not_running' ? <span className="pill">not running</span> : s?.mode ? <span className="pill">{s.mode}</span> : null}
      </div>
      <div className="small muted project-where" title={p.data_dir}>{p.port ? `:${p.port} · ` : ''}{p.data_dir}</div>
      {s ? <>
        <div className="project-counts">
          <Count n={s.needs_you} label="need you" tone="wait" />
          <Count n={s.blocked} label="blocked" tone="hot" />
          <Count n={s.in_review} label="in review" />
          <Count n={s.running} label="running" tone="run" />
        </div>
        {guards.length > 0 && <ul className="project-guards">{guards.map((g) => <li key={g}>{g}</li>)}</ul>}
      </> : <p className="small muted">{p.reach === 'unreachable' ? `Its server did not answer${p.error ? ` (${p.error})` : ''}.` : 'No server is running for it on this machine.'}</p>}
    </li>
  );
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectRow[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(async () => {
    try { setProjects((await api.projects()).projects); setError(undefined); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { setTitle('All projects'); }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), REFRESH_MS); return () => clearInterval(t); }, [load]);
  return (
    <div className="projects-page">
      <div className="toolbar"><h2 className="projects-title">All projects</h2><ActionButton onAct={load} working="Refreshing…">Refresh</ActionButton></div>
      {error && <div className="banner error">{error}</div>}
      {!projects ? <p className="muted">Loading…</p> : <ul className="project-grid">{projects.map((p) => <ProjectCard key={p.data_dir} p={p} />)}</ul>}
      <p className="small muted">Every project in ~/.planestro/projects.yml, and every server started on this machine. Read-only: open a project to act on it.</p>
    </div>
  );
}
