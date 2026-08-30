import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api.ts';
import { act, useStore } from '../store.ts';

export function NewItemDialog({ onClose, icebox }: { onClose: () => void; icebox?: boolean }) {
  const state = useStore((s) => s.state);
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(state?.config.defaults.category ?? '');
  const [kind, setKind] = useState<'item' | 'epic'>('item');
  const [parent, setParent] = useState('');
  const [description, setDescription] = useState('');
  const epics = state?.items.filter((i) => i.frontmatter.kind === 'epic' && i.derived.lane === 'board') ?? [];
  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api.createItem({ title, category, description, kind, parent: parent || undefined, status: icebox ? 'ICEBOX' : undefined })); if (r) { onClose(); nav(`/items/${r.id}`); } }}>
        <h2 style={{ margin: 0 }}>New {icebox ? 'icebox ' : ''}item</h2>
        <input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <div className="row">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{state?.config.categories.map((c) => <option key={c}>{c}</option>)}</select>
          <select value={kind} onChange={(e) => setKind(e.target.value as 'item' | 'epic')}><option value="item">item</option><option value="epic">epic (integration branch)</option></select>
          {kind === 'item' && epics.length > 0 && <select value={parent} onChange={(e) => setParent(e.target.value)}><option value="">no parent epic</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.id} {e.frontmatter.title}</option>)}</select>}
        </div>
        <textarea placeholder="Description / prompt (markdown)" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit">Create</button></div>
      </form>
    </div>
  );
}
