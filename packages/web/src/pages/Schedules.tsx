import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { parseCron, nextSlot, validTimeZone, PRIORITIES, type Priority } from '@planestro/shared/view';
import { api, type ScheduleFields, type ScheduleView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { statusLabel } from '../components/ItemCard.tsx';
import { setTitle as setTabTitle } from '../tabBadge.ts';
import { ActionButton } from '../components/ActionButton.tsx';

const HERE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The next few runs of a cron in a zone, or why it is not one: shown while it is typed. */
function preview(cron: string, tz: string): { runs: string[]; error?: string } {
  if (!validTimeZone(tz)) return { runs: [], error: `"${tz}" is not a time zone` };
  try {
    const c = parseCron(cron); const runs: string[] = []; let t: Date | undefined = new Date();
    while (runs.length < 3 && (t = nextSlot(c, tz, t))) runs.push(when(t.toISOString()));
    return runs.length ? { runs } : { runs, error: 'it never runs' };
  } catch (e) { return { runs: [], error: (e as Error).message.replace(/^cron: /, '') }; }
}

function CronFields({ cron, tz, setCron, setTz }: { cron: string; tz: string; setCron: (v: string) => void; setTz: (v: string) => void }) {
  const p = preview(cron, tz);
  return <>
    <div className="row">
      <input className="grow" aria-label="Cron" placeholder="0 9 * * MON" value={cron} onChange={(e) => setCron(e.target.value)} style={{ fontFamily: 'var(--mono, monospace)' }} />
      <input aria-label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} style={{ flex: '1 1 160px', minWidth: 0 }} />
    </div>
    <p className="small muted" style={{ margin: 0 }}>minute hour day-of-month month day-of-week, or @daily / @weekly.{' '}
      {p.error ? <span style={{ color: 'var(--hot)' }}>{p.error}</span> : <>Next: {p.runs.join(' · ')}</>}</p>
  </>;
}

function Options({ value, set }: { value: ScheduleFields; set: (f: ScheduleFields) => void }) {
  const categories = useStore((s) => s.state?.config.categories ?? []);
  return (
    <div className="controls">
      <label>category <select value={value.category ?? ''} onChange={(e) => set({ category: e.target.value || null })}><option value="">project default</option>{categories.map((c) => <option key={c}>{c}</option>)}</select></label>
      <label>priority <select value={value.priority ?? ''} onChange={(e) => set({ priority: (e.target.value || null) as Priority | null })}><option value="">none</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>kind <select value={value.kind ?? 'item'} onChange={(e) => set({ kind: e.target.value as 'item' | 'epic' })}><option>item</option><option>epic</option></select></label>
      <label title="Skip a slot while the item this schedule filed last is not finished"><input type="checkbox" checked={!!value.skip_if_open} onChange={(e) => set({ skip_if_open: e.target.checked })} /> skip a run while the last one is open</label>
      <label title="Queue each item it files (an epic has its breakdown planned), as if you pressed Submit"><input type="checkbox" checked={!!value.submit} onChange={(e) => set({ submit: e.target.checked })} /> submit what it files</label>
    </div>
  );
}

function NewScheduleDialog({ taken, onClose }: { taken: Set<string>; onClose: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState(''); const [title, setTitle] = useState(''); const [description, setDescription] = useState('');
  const [cron, setCron] = useState('0 9 * * MON'); const [tz, setTz] = useState(HERE);
  const [opts, setOpts] = useState<ScheduleFields>({ skip_if_open: true });
  const clash = taken.has(name.trim());
  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => e.preventDefault()}>
        <h2 style={{ margin: 0 }}>New schedule</h2>
        <input autoFocus placeholder="Name (weekly-audit)" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))} required pattern="[a-z0-9][a-z0-9\-]*" title="lowercase letters, digits and dashes" />
        {clash && <p className="small" style={{ margin: 0, color: 'var(--hot)' }}>{name} already exists.</p>}
        <CronFields cron={cron} tz={tz} setCron={setCron} setTz={setTz} />
        <input placeholder="Item title (Weekly audit {{date}})" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <textarea placeholder="Item description: what to do each time. {{date}}, {{slot}} and {{schedule}} are filled in." value={description} onChange={(e) => setDescription(e.target.value)} rows={5} />
        <Options value={opts} set={(f) => setOpts({ ...opts, ...f })} />
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><ActionButton className="primary" type="submit" disabled={!name.trim() || !title.trim() || clash} working="Creating…" onAct={async () => { const s = await act(() => api.createSchedule({ name: name.trim(), title: title.trim(), description, cron: cron.trim(), tz: tz.trim(), ...opts })); if (s) { onClose(); nav(`/schedules/${s.name}`); } }}>Create</ActionButton></div>
      </form>
    </div>
  );
}

function ScheduleBody({ schedule }: { schedule: ScheduleView }) {
  const nav = useNavigate();
  const items = useStore((s) => s.state?.items ?? []);
  const fm = schedule.frontmatter;
  const patch = (fields: ScheduleFields) => act(() => api.patchSchedule(schedule.name, fields));
  const [cron, setCron] = useState(fm.cron); const [tz, setTz] = useState(fm.tz);
  useEffect(() => { setCron(fm.cron); setTz(fm.tz); }, [fm.cron, fm.tz]);
  useEffect(() => { setTabTitle(`${schedule.name} · schedules`); }, [schedule.name]);
  const timing = cron.trim() !== fm.cron || tz.trim() !== fm.tz;
  const filed = items.filter((i) => i.frontmatter.scheduled_from?.startsWith(`${schedule.name}:`));
  return (
    <div>
      <Link className="back phone-only" to="/schedules">‹ Schedules</Link>
      <div className="section">
        <h2><span>{schedule.name}</span><span className="muted small" style={{ textTransform: 'none', letterSpacing: 0 }} title={schedule.path}>schedules/{schedule.name}.md</span></h2>
        <p style={{ marginTop: 0 }}>{fm.enabled ? schedule.next_run ? <>Next run <b>{when(schedule.next_run)}</b></> : 'It never runs again.' : <span className="muted">Off: it files nothing until you turn it on.</span>}
          {fm.submit && fm.created_by !== 'user' && <span className="muted small"> · says submit, but only a schedule you made submits</span>}</p>
        <CronFields cron={cron} tz={tz} setCron={setCron} setTz={setTz} />
        <div className="controls">
          {timing && <><ActionButton className="primary" working="Saving…" onAct={() => patch({ cron: cron.trim(), tz: tz.trim() })}>Save timing</ActionButton><button onClick={() => { setCron(fm.cron); setTz(fm.tz); }}>Revert</button></>}
          <label><input type="checkbox" checked={fm.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} /> on</label>
          <span className="grow" />
          <ActionButton type="button" className="danger" working="Deleting…" onAct={() => { if (confirm(`Delete schedule ${schedule.name}? Items it filed stay; git history keeps the file.`)) return act(() => api.deleteSchedule(schedule.name)).then(() => nav('/schedules')); }}>Delete</ActionButton>
        </div>
      </div>
      <div className="section"><h2>What it files</h2>
        <input aria-label="Item title" key={`t${fm.title}`} defaultValue={fm.title} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== fm.title && void patch({ title: e.target.value.trim() })} style={{ width: '100%' }} />
        <textarea aria-label="Item description" key={`d${schedule.description}`} defaultValue={schedule.description} onBlur={(e) => e.target.value !== schedule.description && void patch({ description: e.target.value })} rows={6} style={{ width: '100%', marginTop: 8 }} />
        <p className="small muted" style={{ margin: '4px 0 0' }}>{'{{date}}'}, {'{{slot}}'} and {'{{schedule}}'} are filled in when it files.</p>
        <Options value={{ ...fm, category: fm.category ?? null, priority: fm.priority ?? null }} set={(f) => void patch(f)} />
      </div>
      <div className="section"><h2>History · {fm.history.length}</h2>
        {fm.history.length ? <table><tbody>{[...fm.history].reverse().map((h) => { const it = h.item ? items.find((i) => i.id === h.item) : undefined; return (
          <tr key={h.slot}><td className="small">{when(h.slot)}</td>
            <td>{h.item ? <><Link to={`/items/${h.item}`}>{h.item}</Link> <span className="small">{it?.frontmatter.title ?? ''}</span></> : <span className="muted small">skipped: {h.skipped}</span>}</td>
            <td className="muted small">{it ? statusLabel(it.frontmatter.status) : ''}</td></tr>); })}</tbody></table>
          : <p className="muted small" style={{ margin: 0 }}>Nothing filed yet.{filed.length ? ` ${filed.length} item(s) carry its name.` : ''}</p>}
      </div>
    </div>
  );
}

export function SchedulesPage() {
  const { name } = useParams();
  const state = useStore((s) => s.state);
  const [adding, setAdding] = useState(false);
  if (!state) return <p className="muted">Loading…</p>;
  const schedules = state.schedules ?? [];
  const schedule = schedules.find((s) => s.name === name);
  return (
    <div className={`prompts schedules ${schedule ? 'picked' : ''}`}>
      {adding && <NewScheduleDialog taken={new Set(schedules.map((s) => s.name))} onClose={() => setAdding(false)} />}
      <div className="prompt-list">
        <div className="row"><span className="grow muted small">{schedules.length} schedule{schedules.length === 1 ? '' : 's'}</span><button className="primary" onClick={() => setAdding(true)}>+ New</button></div>
        <ul>{schedules.map((s) => (
          <li key={s.name}><NavLink to={`/schedules/${s.name}`}>
            <span className="grow"><b className={s.frontmatter.enabled ? '' : 'muted'}>{s.name}</b> <code className="small muted">{s.frontmatter.cron}</code>
              <br /><span className="muted small">{s.frontmatter.enabled ? s.next_run ? `next ${when(s.next_run)}` : 'never runs again' : 'off'}{s.frontmatter.submit ? ' · submits' : ''}</span></span>
            <span className={`rel-dot ${s.frontmatter.enabled ? 'released' : ''}`} title={s.frontmatter.enabled ? 'on' : 'off'} />
          </NavLink></li>))}</ul>
        {!schedules.length && <p className="muted small">No schedules yet.</p>}
      </div>
      {schedule ? <ScheduleBody key={schedule.name} schedule={schedule} />
        : name ? <p>Unknown schedule {name}. <Link to="/schedules">All schedules</Link></p>
        : <div className="section"><p style={{ marginTop: 0 }}>Recurring work: a weekly audit, a dependency bump, a release cut. At each slot of its cron a schedule files one item from its template, once, even across a sleep or a restart.</p>
            <p className="small muted" style={{ marginBottom: 0 }}>A schedule can skip a run while the item it filed last is still open, and submit what it files. Nothing is filed while automation is paused. Files live in <code>{state.dataDir}/schedules/</code>.</p></div>}
    </div>
  );
}
