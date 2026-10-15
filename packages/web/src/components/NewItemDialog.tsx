import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { planReviewByDefault, placeholdersIn, renderPrompt, fallbackChain, findModel, canPlan, PRIORITIES, type Config, type ModelDef, type Priority } from '@planestro/shared';
import { api, type PromptView, type State } from '../api.ts';
import { act, useStore } from '../store.ts';
import { newItemModeNote } from '../engineMode.ts';
import { ActionButton } from './ActionButton.tsx';

/** Prompts a person starts work from: the library's templates and actions that no engine step owns. */
export function itemPrompts(prompts: PromptView[]): PromptView[] {
  const fav = (p: PromptView) => p.frontmatter.favorite === true ? 0 : 1;
  return prompts.filter((p) => p.frontmatter.kind !== 'partial' && !p.frontmatter.role).sort((a, b) => fav(a) - fav(b) || a.name.localeCompare(b.name));
}

/** What a template can resolve before any item exists; everything else is asked for in the dialog. */
function projectContext(state: State): Record<string, unknown> {
  const repo = state.config.code_repo;
  return { project: state.config.project, data_dir: state.dataDir, repo: { path: state.codeRepo, default_branch: repo.default_branch, release_branch: repo.release_branch ?? '(none)', github: repo.github ?? '(none)' } };
}

/**
 * What each kind means, said where it is chosen: an epic made by mistake as an item went to one
 * implementer who had to stop and ask (#69, HH-198), and the kind used to hide in a select.
 */
export const KIND_HINT = {
  item: 'One piece of work: one worker plans it, implements it and opens one pull request.',
  epic: 'Several shippable pieces: its planner breaks it into child items, each with its own worker and pull request, merged through an integration branch.',
} as const;

export function KindChoice({ kind, onChange }: { kind: 'item' | 'epic'; onChange: (k: 'item' | 'epic') => void }) {
  return (
    <fieldset className="kind-choice" aria-label="Kind">
      {(['item', 'epic'] as const).map((k) => (
        <label key={k} className={kind === k ? 'on' : ''}>
          <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => onChange(k)} />
          <span><b>{k === 'item' ? 'Item' : 'Epic'}</b><span className="small muted">{KIND_HINT[k]}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function withValue(ctx: Record<string, unknown>, path: string, value: string): Record<string, unknown> {
  const out = structuredClone(ctx); let cur = out; const parts = path.split('.');
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  cur[parts.at(-1)!] = value;
  return out;
}

export function NewItemDialog({ onClose, icebox, from }: { onClose: () => void; icebox?: boolean; from?: string }) {
  const state = useStore((s) => s.state);
  const nav = useNavigate();
  const library = useMemo(() => itemPrompts(state?.prompts ?? []), [state?.prompts]);
  const start = library.find((p) => p.name === from);
  const [template, setTemplate] = useState(start?.name ?? '');
  const [title, setTitle] = useState(start?.frontmatter.title ?? '');
  const [category, setCategory] = useState(state?.config.defaults.category ?? '');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [kind, setKind] = useState<'item' | 'epic'>('item');
  const [planner, setPlanner] = useState(state?.config.defaults.planner ?? '');
  // A template may name the model its work is for (`model:` in its frontmatter): an art brief belongs with the art model.
  const modelOf = (p?: PromptView) => state?.config.models.find((m) => m.id === p?.frontmatter.model && !m.external)?.id;
  const [implementer, setImplementer] = useState(modelOf(start) ?? state?.config.defaults.implementer ?? '');
  const [parent, setParent] = useState('');
  // Ticked from defaults.auto_approve_plan for the chosen implementer, until you tick or untick it yourself.
  const [delegateChoice, setDelegate] = useState<boolean | undefined>(undefined);
  const delegate = delegateChoice ?? (state ? planReviewByDefault(state.config, implementer, kind) : false);
  const [allowFallback, setAllowFallback] = useState(state?.config.defaults.allow_model_fallback ?? false);
  const orch = state?.config.orchestrator;
  const [description, setDescription] = useState(start?.body ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const epics = state?.items.filter((i) => i.frontmatter.kind === 'epic' && i.derived.lane === 'board') ?? [];

  const partials = (n: string) => state?.prompts.find((p) => p.name === n)?.body;
  const base = state ? projectContext(state) : {};
  // Placeholders the project cannot answer by itself become fields; a description is never created half-filled.
  const asks = placeholdersIn(description).filter((p) => !p.startsWith('>')).filter((p) => { try { renderPrompt(`{{${p}}}`, base); return false; } catch { return true; } });
  const render = () => renderPrompt(description, asks.reduce((ctx, p) => withValue(ctx, p, values[p] ?? ''), base), partials, template || '(description)');

  const pick = (name: string) => {
    const p = library.find((x) => x.name === name);
    setTemplate(name);
    if (!p) return;
    const forModel = modelOf(p); if (forModel) setImplementer(forModel);
    if (!title.trim() || library.some((x) => x.frontmatter.title === title)) setTitle(p.frontmatter.title);
    if (!description.trim() || library.some((x) => x.body === description) || confirm('Replace the description with this prompt?')) setDescription(p.body);
  };

  const create = async () => {
    let text: string;
    try { text = render(); } catch (err) { useStore.setState({ error: (err as Error).message }); return; }
    const r = await act(() => api.createItem({ title, category, ...(priority ? { priority } : {}), description: text, kind, planner: kind === 'epic' && planner ? planner : undefined, parent: parent || undefined, implementer: kind === 'item' ? implementer || undefined : undefined, auto_approve_plan: kind === 'item' && orch?.may_approve_plans ? delegate : undefined, allow_model_fallback: allowFallback, status: icebox ? 'ICEBOX' : undefined }));
    if (r) { onClose(); nav(`/items/${r.id}`); }
  };

  return (
    <div className="dialog" onClick={onClose}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={(e) => e.preventDefault()}>
        <h2 style={{ margin: 0 }}>New {icebox ? 'icebox ' : ''}{kind === 'epic' ? 'epic' : 'item'}</h2>
        {newItemModeNote(state?.engine.modes) && <div className="small warn-text" role="status">{newItemModeNote(state?.engine.modes)}</div>}
        {library.length > 0 && <select value={template} onChange={(e) => pick(e.target.value)} title="Start from a prompt in the library"><option value="">blank — or start from a prompt…</option>{library.map((p) => <option key={p.name} value={p.name}>{p.frontmatter.favorite === true ? '★ ' : ''}{p.frontmatter.title} ({p.name})</option>)}</select>}
        <input autoFocus placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        <KindChoice kind={kind} onChange={setKind} />
        <div className="row">
          <select value={category} onChange={(e) => setCategory(e.target.value)} title="Category">{state?.config.categories.map((c) => <option key={c}>{c}</option>)}</select>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | '')} title="Priority: each column, and the queue, takes high first"><option value="">no priority</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p} priority</option>)}</select>
          {kind === 'epic' && <select value={planner} onChange={(e) => setPlanner(e.target.value)} title="Who breaks it down (and, unless the breakdown says otherwise, plans its children)">{state?.config.models.filter(canPlan).map((m) => <option key={m.id} value={m.id}>planned by {m.label}</option>)}</select>}
          {kind === 'item' && <select value={implementer} onChange={(e) => setImplementer(e.target.value)} title="Who implements it (the planner stays the project default)">{state?.config.models.filter((m) => !m.external).map((m) => <option key={m.id} value={m.id}>{m.label}{(m.runner ?? 'claude') !== 'claude' ? ` (${m.runner})` : ''}</option>)}</select>}
          {kind === 'item' && epics.length > 0 && <select value={parent} onChange={(e) => setParent(e.target.value)}><option value="">no parent epic</option>{epics.map((e) => <option key={e.id} value={e.id}>{e.id} {e.frontmatter.title}</option>)}</select>}
        </div>
        {kind === 'item' && orch?.may_approve_plans && <label className="row small" title={`The orchestrator reviews the plan and approves it, sends it back with fixes (up to ${orch.max_plan_revisions} rounds), or leaves it to you`}><input type="checkbox" checked={delegate} onChange={(e) => setDelegate(e.target.checked)} /> let the orchestrator approve the plan</label>}
        {state && <label className="row small" title="While the planner's or implementer's model is out of usage, turns run on its fallback (models: fallback in planestro.yml) instead of blocking"><input type="checkbox" checked={allowFallback} onChange={(e) => setAllowFallback(e.target.checked)} /> allow fallback model{fallbackHint(state.config, [state.config.defaults.planner, kind === 'item' ? implementer : undefined])}{kind === 'epic' ? ' — its children inherit this' : ''}</label>}
        <textarea placeholder="Description / prompt (markdown)" value={description} onChange={(e) => setDescription(e.target.value)} />
        {asks.map((p) => <label key={p} className="row small"><code>{`{{${p}}}`}</code><input className="grow" required placeholder={`value for ${p}`} value={values[p] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [p]: e.target.value }))} /></label>)}
        <div className="row"><span className="grow" /><button type="button" onClick={onClose}>Cancel</button><ActionButton className="primary" type="submit" working="Creating…" onAct={create}>Create</ActionButton></div>
      </form>
    </div>
  );
}

/** " (Fable 5 → Opus 5.5)" for the given models that have a fallback, or a note that none does. */
export function fallbackHint(cfg: Config, ids: (string | undefined)[]): string {
  const chains = [...new Set(ids.filter(Boolean))].map((id) => findModel(cfg, id)).filter((m): m is ModelDef => !!m).map((m) => fallbackChain(cfg, m)).filter((c) => c.length > 1);
  return chains.length ? ` (${chains.map((c) => c.map((m) => m.label).join(' → ')).join('; ')})` : ' (no fallback configured for these models)';
}

