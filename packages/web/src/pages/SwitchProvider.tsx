import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { canPlan, unavailableEntry } from '@planestro/shared';
import { api } from '../api.ts';
import { useStore } from '../store.ts';

type Row = { id: string; title: string; eligible: boolean; summary: string; pr?: { number: number; url: string }; result?: string };
type Preview = { items: Row[]; orchestrator?: string };
export const PROVIDER_GUIDE = 'https://github.com/gravesisme/planestro/blob/main/docs/switching-providers.md';
export function SwitchProviderPage() {
  const state = useStore((s) => s.state);
  const [query] = useSearchParams();
  const [provider, setProvider] = useState(query.get('provider') === 'claude' ? 'claude' : 'codex');
  const [model, setModel] = useState('');
  const [orchestrator, setOrchestrator] = useState(true);
  const [defaults, setDefaults] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{ configured?: string; current?: string; pending?: boolean }>({});
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void api.orchestratorSelection().then((value) => { if (!cancelled) setSelection(value); }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [state?.config.orchestrator.model]);
  const models = state?.config.models.filter((m) => canPlan(m) && m.runner === provider) ?? [];
  const chosen = models.some((m) => m.id === model) ? model : models.find((m) => !state?.engine.provider_guards?.[m.runner] && !unavailableEntry(state?.local.model_unavailable, m.id, new Date()))?.id ?? '';
  const items = state?.items.filter((i) => !['MERGED', 'FINISHED', 'ICEBOX'].includes(i.frontmatter.status)) ?? [];
  const request = { model: chosen, orchestrator, defaults, items: selected };
  const clear = () => { setPreview(undefined); setError(''); };
  const execute = async (apply: boolean, resume = false) => {
    setBusy(true); setError('');
    try { setPreview(await (apply ? api.applyProviderSwitch({ ...request, resume }) : api.previewProviderSwitch(request))); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!state) return <p>Loading…</p>;
  return <section className="provider-switch" style={{ maxWidth: 1000, margin: '24px auto', padding: 20 }}>
    <h1>Switch provider</h1>
    <p>Continue selected work from a fresh brief built from the item and git. Existing art workers keep their model and transport.</p>
    <p><a href={PROVIDER_GUIDE} target="_blank" rel="noreferrer">Provider switching guide</a> · <Link to="/settings">Settings</Link></p>
    <p>Orchestrator: {selection.current ?? 'no conversation yet'} · configured: {selection.configured ?? state.config.orchestrator.model}</p>
    <p>{selection.pending ? 'Current wake finishing; switch pending.' : 'Applies to the next wake. No restart required.'}</p>
    <label>Provider <select disabled={busy} value={provider} onChange={(e) => { setProvider(e.target.value); setModel(''); clear(); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
    <label> Model <select disabled={busy} value={chosen} onChange={(e) => { setModel(e.target.value); clear(); }}>{models.map((m) => <option key={m.id} value={m.id} disabled={Boolean(state.engine.provider_guards?.[m.runner] || unavailableEntry(state.local.model_unavailable, m.id, new Date()))}>{m.label}</option>)}</select></label>
    {!models.length && <p>Add a model with planning capability in <Link to="/settings">Settings</Link> first.</p>}
    <p>{provider === 'codex' ? 'Codex uses token budgets. Dollar cost is not reported.' : 'Claude uses dollar budgets.'}</p>
    <label className="check"><input type="checkbox" disabled={busy} checked={orchestrator} onChange={(e) => { setOrchestrator(e.target.checked); clear(); }} /> Change orchestrator</label>
    <label className="check"><input type="checkbox" disabled={busy} checked={defaults} onChange={(e) => { setDefaults(e.target.checked); clear(); }} /> Change defaults for new items</label>
    <fieldset disabled={busy}><legend>Existing unfinished items</legend>
      {items.map((i) => <label className="check" key={i.id}><input type="checkbox" checked={selected.includes(i.id)} onChange={(e) => { setSelected(e.target.checked ? [...selected, i.id] : selected.filter((x) => x !== i.id)); clear(); }} />{i.id} — {i.frontmatter.title}</label>)}
    </fieldset>
    <button disabled={busy || !chosen} onClick={() => void execute(false)}>Preview changes</button>
    {error && <p role="alert" className="banner error">{error}</p>}
    {preview && <div aria-live="polite">
      {preview.orchestrator && <p>{preview.orchestrator}</p>}
      <ul>{preview.items.map((i) => <li key={i.id}><strong>{i.id}{i.result ? ` · ${i.result}` : ''}:</strong> {i.summary} {i.pr && <a href={i.pr.url} target="_blank" rel="noreferrer">#{i.pr.number}</a>}</li>)}</ul>
      {!preview.items.some((i) => i.result) && <div className="row">
        <button disabled={busy} onClick={() => void execute(true)}>Save changes</button>
        <button disabled={busy} onClick={() => void execute(true, true)}>Save and resume automation</button>
      </div>}
      <p>Provider usage pauses remain in place. The global automation pause is separate.</p>
    </div>}
  </section>;
}
