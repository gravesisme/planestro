import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router';
import { charCount, nextVersions, releaseMarkdown, RELEASE_STATUSES, type ReleaseSectionDef, type ReleaseStatus } from '@planestro/shared';
import { api, type ReleaseFields, type ReleaseView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { statusLabel } from '../components/ItemCard.tsx';

const STATUS_HINT: Record<ReleaseStatus, string> = {
  planned: 'being put together', submitted: 'with a store or a reviewer', released: 'out', cancelled: 'never shipped; places no items',
};

function copy(text: string) { void navigator.clipboard.writeText(text); useStore.getState().flash('copied to the clipboard'); }

function NewReleaseDialog({ latest, taken, onClose }: { latest?: string; taken: Set<string>; onClose: () => void }) {
  const nav = useNavigate();
  const suggestions = nextVersions(latest).filter((v) => !taken.has(v));
  const [version, setVersion] = useState(suggestions[1] ?? suggestions[0] ?? '');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const carried = useStore((s) => s.state?.config.releases.sections.filter((d) => d.carry).map((d) => d.title) ?? []);
  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api.createRelease({ version: version.trim(), title: title.trim() || undefined, date: date || undefined })); if (r) { onClose(); nav(`/releases/${encodeURIComponent(r.version)}`); } }}>
        <h2 style={{ margin: 0 }}>New release</h2>
        <div className="row">
          <input autoFocus className="grow" placeholder="Version (1.6.0)" value={version} onChange={(e) => setVersion(e.target.value)} required pattern="[0-9A-Za-z][0-9A-Za-z._+\-]*" title="letters, digits, dots and dashes" />
          {suggestions.map((v) => <button type="button" key={v} className={`small ${v === version ? 'primary' : ''}`} onClick={() => setVersion(v)}>{v}</button>)}
        </div>
        {taken.has(version.trim()) && <p className="small" style={{ margin: 0, color: 'var(--hot)' }}>{version} already exists.</p>}
        <input placeholder="Title (optional: “Map update”)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <label className="small muted">Aiming for <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {carried.length > 0 && latest && <p className="small muted" style={{ margin: 0 }}>{carried.join(', ')} start as {latest}'s text.</p>}
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={!version.trim() || taken.has(version.trim())}>Create</button></div>
      </form>
    </div>
  );
}

/** One section: saved when it loses focus, counted against the store's limit if it has one. */
function SectionEditor({ release, def, body }: { release: string; def: ReleaseSectionDef; body: string }) {
  const [text, setText] = useState(body);
  const saved = useRef(body);
  useEffect(() => { if (body !== saved.current) { setText(body); saved.current = body; } }, [body]);
  const save = () => { if (text === saved.current) return; saved.current = text; void act(() => api.patchRelease(release, { sections: { [def.title]: text } })); };
  const n = charCount(text);
  const over = def.max_chars !== undefined && n > def.max_chars;
  const lines = Math.max(2, text.split('\n').length + 1);
  return (
    <div className="section">
      <h2><span>{def.title}{def.carry && <span className="tag" title="A new release starts with this text from the one before it" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>carries forward</span>}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}><span className={`small ${over ? '' : 'muted'}`} style={{ textTransform: 'none', letterSpacing: 0, color: over ? 'var(--hot)' : undefined }}>{def.max_chars ? `${n} / ${def.max_chars}` : `${n} chars`}</span>
          <button className="small" type="button" disabled={!text.trim()} onClick={() => copy(text.trim())}>copy</button></span></h2>
      {def.hint && <p className="small muted" style={{ margin: '0 0 6px' }}>{def.hint}</p>}
      <textarea value={text} data-dirty={text !== saved.current} onChange={(e) => setText(e.target.value)} onBlur={save} rows={Math.min(lines, 24)} style={{ minHeight: def.max_chars && def.max_chars <= 200 ? 44 : 90 }} />
    </div>
  );
}

function ReleaseBody({ release }: { release: ReleaseView }) {
  const nav = useNavigate();
  const state = useStore((s) => s.state)!;
  const fm = release.frontmatter;
  const patch = (fields: ReleaseFields) => act(() => api.patchRelease(release.version, { fields }));
  const itemOf = (id: string) => state.items.find((i) => i.id === id);
  // The project's sections first, in its order; anything else the file holds (a hand-added heading) after them.
  const defs: ReleaseSectionDef[] = [...state.config.releases.sections, ...release.sections.filter((s) => !state.config.releases.sections.some((d) => d.title === s.title)).map((s) => ({ title: s.title, carry: false }))];
  const bodyOf = (title: string) => release.sections.find((s) => s.title === title)?.body ?? '';
  const [version, setVersion] = useState(release.version);
  useEffect(() => { document.title = `${release.version}${fm.title ? ` · ${fm.title}` : ''} · releases`; }, [release.version, fm.title]);
  const rename = async () => { const v = version.trim(); if (!v || v === release.version) return setVersion(release.version); const r = await act(() => api.patchRelease(release.version, { fields: { version: v } })); if (r) nav(`/releases/${encodeURIComponent(r.version)}`, { replace: true }); else setVersion(release.version); };
  return (
    <div>
      <Link className="back phone-only" to="/releases">‹ Releases</Link>
      <div className="section">
        <h2><span className="row" style={{ margin: 0, flexWrap: 'wrap' }}>
          <input aria-label="Version" value={version} onChange={(e) => setVersion(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} style={{ width: 110, fontWeight: 700 }} />
          <input aria-label="Title" key={`t${fm.title}`} defaultValue={fm.title ?? ''} placeholder="title" onBlur={(e) => e.target.value.trim() !== (fm.title ?? '') && patch({ title: e.target.value.trim() || null })} style={{ textTransform: 'none' }} />
        </span><span className="muted small" style={{ textTransform: 'none', letterSpacing: 0 }} title={release.path}>releases/{release.version}.md</span></h2>
        <div className="controls">
          <label>status <select value={fm.status} onChange={(e) => patch({ status: e.target.value as ReleaseStatus })}>{RELEASE_STATUSES.map((s) => <option key={s} value={s} title={STATUS_HINT[s]}>{s}</option>)}</select></label>
          <label>{fm.status === 'released' ? 'released on' : 'aiming for'} <input type="date" key={`d${fm.date}`} defaultValue={fm.date ?? ''} onBlur={(e) => e.target.value !== (fm.date ?? '') && patch({ date: e.target.value || null })} /></label>
          <label>tag <input key={`g${fm.tag}`} defaultValue={fm.tag ?? ''} placeholder={`v${release.version}`} onBlur={(e) => e.target.value.trim() !== (fm.tag ?? '') && patch({ tag: e.target.value.trim() || null })} style={{ width: 110 }} /></label>
          <span className="grow" />
          <button type="button" onClick={() => copy(releaseMarkdown({ frontmatter: fm, sections: release.sections }))} title="Every section with text, as one markdown document">Copy all</button>
          <button type="button" className="danger" onClick={() => { if (confirm(`Delete release ${release.version}? The file is removed; git history keeps it.`)) void act(() => api.deleteRelease(release.version)).then(() => nav('/releases')); }}>Delete</button>
        </div>
      </div>

      <div className="section"><h2>Backlog items in this release · {fm.items.length}</h2>
        {fm.items.length > 0 ? <table><tbody>{fm.items.map((id) => { const it = itemOf(id); return (
          <tr key={id}><td><Link to={`/items/${id}`}>{id}</Link></td><td>{it?.frontmatter.title ?? <span className="muted">unknown item</span>}</td><td className="muted small">{it ? statusLabel(it.frontmatter.status) : ''}</td>
            <td><button className="chip-x" title={`Take ${id} out of ${release.version}`} onClick={() => patch({ items: fm.items.filter((x) => x !== id) })}>×</button></td></tr>); })}</tbody></table>
          : <p className="muted small" style={{ margin: 0 }}>None yet.</p>}
        {release.candidates.length > 0 && <>
          <h3 className="drawer-h" style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>Landed {fm.status === 'released' ? 'in this window' : 'since the last release'}, not in any release · {release.candidates.length}
            <button className="small" onClick={() => patch({ items: [...fm.items, ...release.candidates] })}>add all</button></h3>
          <table><tbody>{release.candidates.map((id) => { const it = itemOf(id)!; return (
            <tr key={id}><td><Link to={`/items/${id}`}>{id}</Link></td><td>{it.frontmatter.title}</td><td className="muted small">{(it.frontmatter.merged_at ?? it.frontmatter.finished_at ?? '').slice(0, 10)}</td>
              <td><button className="small" onClick={() => patch({ items: [...fm.items, id] })}>add</button></td></tr>); })}</tbody></table>
        </>}
      </div>

      {defs.map((d) => <SectionEditor key={`${release.version}:${d.title}`} release={release.version} def={d} body={bodyOf(d.title)} />)}
    </div>
  );
}

export function ReleasesPage() {
  const { version } = useParams();
  const state = useStore((s) => s.state);
  const [adding, setAdding] = useState(false);
  if (!state) return <p className="muted">Loading…</p>;
  const releases = state.releases ?? [];
  const release = releases.find((r) => r.version === version);
  const latest = releases.find((r) => r.frontmatter.status !== 'cancelled')?.version;
  return (
    <div className={`prompts releases ${release ? 'picked' : ''}`}>
      {adding && <NewReleaseDialog latest={latest} taken={new Set(releases.map((r) => r.version))} onClose={() => setAdding(false)} />}
      <div className="prompt-list">
        <div className="row"><span className="grow muted small">{releases.length} release{releases.length === 1 ? '' : 's'}</span><button className="primary" onClick={() => setAdding(true)}>+ New</button></div>
        <ul>{releases.map((r) => (
          <li key={r.version}><NavLink to={`/releases/${encodeURIComponent(r.version)}`}>
            <span className="grow"><b className={r.frontmatter.status === 'cancelled' ? 'muted' : ''} style={r.frontmatter.status === 'cancelled' ? { textDecoration: 'line-through' } : undefined}>{r.version}</b> {r.frontmatter.title && <span className="small">{r.frontmatter.title}</span>}
              <br /><span className="muted small">{r.frontmatter.status}{r.frontmatter.date ? ` · ${r.frontmatter.date}` : ''}{r.frontmatter.items.length ? ` · ${r.frontmatter.items.length} item${r.frontmatter.items.length === 1 ? '' : 's'}` : ''}</span></span>
            <span className={`rel-dot ${r.frontmatter.status}`} title={r.frontmatter.status} />
          </NavLink></li>))}</ul>
        {!releases.length && <p className="muted small">No releases yet.</p>}
      </div>
      {release ? <ReleaseBody key={release.version} release={release} />
        : version ? <p>Unknown release {version}. <Link to="/releases">All releases</Link></p>
        : <div className="section"><p style={{ marginTop: 0 }}>What you ship, next to what you planned: each release keeps its notes, its store copy and the backlog items that went out in it.</p>
            <p className="small muted" style={{ marginBottom: 0 }}>The sections come from <code>releases.sections</code> in <code>planestro.yml</code> — a character limit per section, and whether it carries forward to the next release. Files live in <code>{state.dataDir}/releases/</code>.</p></div>}
    </div>
  );
}
