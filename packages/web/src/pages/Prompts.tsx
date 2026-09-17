import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { api, type PromptView } from '../api.ts';
import { act, useStore } from '../store.ts';
import { NewItemDialog, itemPrompts } from '../components/NewItemDialog.tsx';

/** How each kind of prompt gets used, since the file alone does not say. */
function usage(p: { kind: string; role?: string }, startable: boolean): string {
  if (p.role) return `planestro sends this itself (${p.role.replace(/_/g, ' ')} step); edit it to change what every session is told.`;
  if (p.kind === 'partial') return 'Included by other prompts with {{> name}}; never sent alone.';
  return startable ? 'A starting point for work: create a backlog item from it, fill in its placeholders, then queue the item.' : '';
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const isFavorite = (p: PromptView) => p.frontmatter.favorite === true;

function Star({ prompt, className = '' }: { prompt: PromptView; className?: string }) {
  const on = isFavorite(prompt);
  return <button type="button" className={`star ${on ? 'on' : ''} ${className}`} title={on ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={on} onClick={(e) => { e.preventDefault(); e.stopPropagation(); void act(() => api.favoritePrompt(prompt.name, !on)); }}>{on ? '★' : '☆'}</button>;
}

function NewPromptDialog({ taken, onClose }: { taken: Set<string>; onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [name, setName] = useState<string | null>(null); // null = follow the title
  const [kind, setKind] = useState<'template' | 'action' | 'partial'>('template');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const file = name ?? slug(title);
  const clash = taken.has(file);
  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api.createPrompt({ name: file, title: title.trim(), kind, description: description.trim() || undefined, body })); if (r) { onClose(); nav(`/prompts/${r.name}`); } }}>
        <h2 style={{ margin: 0 }}>New prompt</h2>
        <input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div className="row">
          <input className="grow" placeholder="file-name" value={file} onChange={(e) => setName(slug(e.target.value) || '')} required pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits and dashes" />
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="template">template (start items from it)</option><option value="action">action</option><option value="partial">partial (included by others)</option></select>
        </div>
        {clash && <p className="small" style={{ margin: 0, color: 'var(--hot)' }}>A prompt named {file} already exists.</p>}
        <input placeholder="Description (one line, optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <textarea placeholder={'The prompt (markdown). {{placeholders}} are asked for when an item is created from it.'} value={body} onChange={(e) => setBody(e.target.value)} required />
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit" disabled={clash || !file}>Create</button></div>
      </form>
    </div>
  );
}

export function PromptsPage() {
  const { name } = useParams();
  const nav = useNavigate();
  const state = useStore((s) => s.state);
  const prompt = state?.prompts.find((p) => p.name === name);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string>('');
  const [itemId, setItemId] = useState('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  // `text` is the file as the server serializes it; the fallback covers a server older than that field.
  const source = prompt ? prompt.text ?? `---\n${Object.entries(prompt.frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${prompt.body}\n` : '';
  // Follow the file, but never over an unsaved draft of the same prompt (starring it rewrites the file).
  const shown = useRef({ name: '', source: '' });
  useEffect(() => {
    const was = shown.current; // read now: the updater below runs after the ref has moved on
    shown.current = { name: prompt?.name ?? '', source };
    setText((draft) => was.name !== (prompt?.name ?? '') || draft === was.source ? source : draft);
    if (was.name !== (prompt?.name ?? '')) setPreview('');
  }, [prompt?.name, source]);
  const groups = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = (state?.prompts ?? []).filter((p) => terms.every((t) => `${p.name} ${p.frontmatter.title} ${p.frontmatter.kind} ${p.frontmatter.role ?? ''}`.toLowerCase().includes(t)));
    return { favorites: shown.filter(isFavorite), rest: shown.filter((p) => !isFavorite(p)) };
  }, [state?.prompts, q]);
  if (!state) return <p className="muted">Loading…</p>;
  const startable = !!prompt && itemPrompts([prompt]).length > 0;
  const row = (p: PromptView) => <li key={p.name}><NavLink to={`/prompts/${p.name}`}><span className="grow">{p.name} <span className="muted small">{p.frontmatter.kind}{p.frontmatter.role ? ` · ${p.frontmatter.role}` : ''}</span></span><Star prompt={p} /></NavLink></li>;
  return (
    <div className="prompts">
      {creating && prompt && <NewItemDialog from={prompt.name} onClose={() => setCreating(false)} />}
      {adding && <NewPromptDialog taken={new Set(state.prompts.map((p) => p.name))} onClose={() => setAdding(false)} />}
      <div className="prompt-list">
        <div className="row"><input className="grow" type="search" placeholder="Filter prompts…" value={q} onChange={(e) => setQ(e.target.value)} /><button className="primary" onClick={() => setAdding(true)}>+ New</button></div>
        {groups.favorites.length > 0 && <><h3 className="drawer-h">★ Favorites</h3><ul>{groups.favorites.map(row)}</ul><h3 className="drawer-h">All prompts</h3></>}
        <ul>{groups.rest.map(row)}</ul>
        {!groups.favorites.length && !groups.rest.length && <p className="muted small">No prompt matches.</p>}
      </div>
      {prompt ? (
        <div>
          <div className="section"><h2><span><Star prompt={prompt} className="big" /> {prompt.frontmatter.title}</span> <span className="muted small">{prompt.path}</span></h2>
            <p className="muted small">{prompt.frontmatter.description}</p>
            <p className="small">{usage(prompt.frontmatter, startable)}</p>
            <textarea value={text} data-dirty={text !== source} onChange={(e) => setText(e.target.value)} style={{ minHeight: 360 }} />
            <div className="row">{startable && <button className="primary" onClick={() => setCreating(true)}>+ New item from this prompt</button>}<button className={startable ? '' : 'primary'} disabled={text === source} onClick={() => act(() => api.putPrompt(prompt.name, text))}>Save</button>
              <select className="grow" style={{ minWidth: 0 }} value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">preview with item…</option>{state.items.map((i) => <option key={i.id} value={i.id}>{i.id} {i.frontmatter.title}</option>)}</select>
              <button onClick={async () => { try { setPreview((await api.renderPrompt(prompt.name, itemId || undefined)).text); } catch (e) { setPreview(`⚠ ${(e as Error).message}`); } }}>Render</button>
              <button className="danger" onClick={() => { if (confirm(`Delete prompt ${prompt.name}?`)) void act(() => api.deletePrompt(prompt.name)).then(() => nav('/prompts')); }}>Delete</button></div>
          </div>
          {preview && <div className="section"><h2>Rendered</h2><pre className="events">{preview}</pre></div>}
        </div>
      ) : <p className="muted">Pick a prompt, or create one with <b>+ New</b>. Files live in <code>{state.dataDir}/prompts/</code>.</p>}
    </div>
  );
}
