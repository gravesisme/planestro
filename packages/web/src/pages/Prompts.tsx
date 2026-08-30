import { useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { api } from '../api.ts';
import { act, useStore } from '../store.ts';

export function PromptsPage() {
  const { name } = useParams();
  const state = useStore((s) => s.state);
  const prompt = state?.prompts.find((p) => p.name === name);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string>('');
  const [itemId, setItemId] = useState('');
  useEffect(() => { if (prompt) setText(`---\n${Object.entries(prompt.frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${prompt.body}\n`); setPreview(''); }, [prompt?.name, prompt?.body]);
  if (!state) return <p className="muted">Loading…</p>;
  return (
    <div className="prompts">
      <ul>{state.prompts.map((p) => <li key={p.name}><NavLink to={`/prompts/${p.name}`}>{p.name} <span className="muted small">{p.frontmatter.kind}{p.frontmatter.role ? ` · ${p.frontmatter.role}` : ''}</span></NavLink></li>)}</ul>
      {prompt ? (
        <div>
          <div className="section"><h2>{prompt.frontmatter.title} <span className="muted small">{prompt.path}</span></h2>
            <p className="muted small">{prompt.frontmatter.description}</p>
            <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 360 }} />
            <div className="row"><button className="primary" onClick={() => act(() => api.putPrompt(prompt.name, text))}>Save</button>
              <select value={itemId} onChange={(e) => setItemId(e.target.value)}><option value="">preview with item…</option>{state.items.map((i) => <option key={i.id} value={i.id}>{i.id} {i.frontmatter.title}</option>)}</select>
              <button onClick={async () => { try { setPreview((await api.renderPrompt(prompt.name, itemId || undefined)).text); } catch (e) { setPreview(`⚠ ${(e as Error).message}`); } }}>Render</button>
              <span className="grow" /><button className="danger" onClick={() => { if (confirm(`Delete prompt ${prompt.name}?`)) void act(() => api.deletePrompt(prompt.name)); }}>Delete</button></div>
          </div>
          {preview && <div className="section"><h2>Rendered</h2><pre className="events">{preview}</pre></div>}
        </div>
      ) : <p className="muted">Pick a prompt. Files live in <code>{state.dataDir}/prompts/</code>.</p>}
    </div>
  );
}
