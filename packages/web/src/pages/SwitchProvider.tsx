import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { canPlan, unavailableEntry, PLANESTRO_REPO_URL } from '@planestro/shared/view';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { ProviderSwitchBoard } from '../components/ProviderSwitchBoard.tsx';
import { Sending } from '../components/Sending.tsx';
import { useAction } from '../sending.ts';

type Row = { id: string; title: string; eligible: boolean; summary: string; pr?: { number: number; url: string }; result?: string };
type Preview = { items: Row[]; orchestrator?: string };
export const PROVIDER_GUIDE = `${PLANESTRO_REPO_URL}/blob/main/docs/switching-providers.md`;
export function SwitchProviderPage() {
  const state = useStore((s) => s.state);
  const [query] = useSearchParams();
  const [provider, setProvider] = useState(query.get('provider') === 'claude' ? 'claude' : 'codex');
  const [model, setModel] = useState('');
  const [orchestrator, setOrchestrator] = useState(() => !query.get('item'));
  const [defaults, setDefaults] = useState(false);
  const [selected, setSelected] = useState<string[]>(() => query.get('item') ? [query.get('item')!] : []);
  const [preview, setPreview] = useState<{ data: Preview; key: string; applied: boolean }>();
  const [error, setError] = useState('');
  // One request at a time, shown at once on the button pressed (#304).
  const { busy: going, run } = useAction();
  const busy = going !== undefined;
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
  const selectedItems = items.filter((item) => selected.includes(item.id));
  const selectedIds = selectedItems.map((item) => item.id);
  const backlogCount = selectedItems.filter((item) => item.frontmatter.status === 'NOT_YET_SUBMITTED').length;
  const request = { model: chosen, orchestrator, defaults, items: selectedIds };
  const requestKey = JSON.stringify(request);
  const visiblePreview = preview && (preview.applied || preview.key === requestKey) ? preview : undefined;
  const clear = () => { setPreview(undefined); setError(''); };
  const execute = (key: string, apply: boolean, resume = false) => run(key, async () => {
    setError('');
    try { setPreview({ data: await (apply ? api.applyProviderSwitch({ ...request, resume }) : api.previewProviderSwitch(request)), key: requestKey, applied: apply }); }
    catch (e) { setError((e as Error).message); }
  });
  const label = (key: string, idle: string, working: string) => going === key ? <Sending label={working} /> : idle;
  if (!state) return <p>Loading…</p>;
  return <section className="provider-switch">
    <div className="provider-settings">
    <h1>Switch provider</h1>
    <p>Continue selected work from a fresh brief built from the item and git. Existing art workers keep their model and transport.</p>
    <p><a href={PROVIDER_GUIDE} target="_blank" rel="noreferrer">Provider switching guide</a> · <Link to="/settings">Settings</Link></p>
    <div className="provider-controls"><div>
    <div className="provider-model-fields">
    <label>Provider <select disabled={busy} value={provider} onChange={(e) => { setProvider(e.target.value); setModel(''); clear(); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
    <label> Model <select disabled={busy} value={chosen} onChange={(e) => { setModel(e.target.value); clear(); }}>{models.map((m) => <option key={m.id} value={m.id} disabled={Boolean(state.engine.provider_guards?.[m.runner] || unavailableEntry(state.local.model_unavailable, m.id, new Date()))}>{m.label}</option>)}</select></label>
    </div>
    {!models.length && <p>Add a model with planning capability in <Link to="/settings">Settings</Link> first.</p>}
    <p>{provider === 'codex' ? 'Codex uses token budgets. Dollar cost is not reported.' : 'Claude uses dollar budgets.'}</p>
    </div><div>
    <label className="check"><input type="checkbox" disabled={busy} checked={orchestrator} onChange={(e) => { setOrchestrator(e.target.checked); clear(); }} /> Change orchestrator</label>
    <p className="provider-orchestrator-state">Current: {selection.current ?? 'no conversation yet'} · configured: {selection.configured ?? state.config.orchestrator.model}<br />{selection.pending ? 'Current wake finishing; switch pending.' : 'Applies to the next wake. No restart required.'}</p>
    <label className="check"><input type="checkbox" disabled={busy} checked={defaults} onChange={(e) => { setDefaults(e.target.checked); clear(); }} /> Change defaults for new items</label>
    </div></div>
    </div>
    <fieldset className="provider-item-selection" disabled={busy}><legend>Choose existing items</legend>
      <p>Selecting items changes their provider only. It never submits or approves them. Holds and dependencies stay in place.</p>
      <ProviderSwitchBoard items={items} selected={selectedIds} onChange={(ids) => { setSelected(ids); clear(); }} />
    </fieldset>
    <div className="provider-selection-summary" aria-live="polite">
      <strong>{selectedIds.length} items selected</strong> · {selectedIds.length - backlogCount} queued or underway · {backlogCount} not yet submitted
      <p>{defaults ? 'New-item defaults will also change.' : 'Defaults for new items stay unchanged.'} Unselected items keep their current models.</p>
    </div>
    <button disabled={busy || !chosen} aria-busy={going === 'preview' || undefined} onClick={() => void execute('preview', false)}>{label('preview', 'Preview changes', 'Previewing…')}</button>
    {error && <p role="alert" className="banner error">{error}</p>}
    {visiblePreview && <div className="provider-preview" aria-live="polite">
      <h2>{visiblePreview.applied ? 'Switch results' : 'Review selected changes'}</h2>
      {visiblePreview.data.orchestrator && <p>{visiblePreview.data.orchestrator}</p>}
      <ul>{visiblePreview.data.items.map((i) => <li key={i.id}><strong>{i.id}{i.result ? ` · ${i.result}` : ''}:</strong> {i.summary} {i.pr && <a href={i.pr.url} target="_blank" rel="noreferrer">#{i.pr.number}</a>}</li>)}</ul>
      {!visiblePreview.applied && <div className="row">
        <button disabled={busy} aria-busy={going === 'save' || undefined} onClick={() => void execute('save', true)}>{label('save', 'Save changes', 'Saving…')}</button>
        <button disabled={busy} aria-busy={going === 'resume' || undefined} onClick={() => void execute('resume', true, true)}>{label('resume', 'Save and resume automation', 'Saving…')}</button>
      </div>}
      <p>Resuming automation continues already queued work. Not yet submitted items stay unsubmitted. Provider usage pauses remain in place.</p>
    </div>}
  </section>;
}
