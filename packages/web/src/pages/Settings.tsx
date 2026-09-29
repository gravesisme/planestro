import { useState, type ReactNode } from 'react';
import {
  SETTINGS, SETTINGS_TABS, canPlan, fallbackChain, fallbackProblems, findModel, getPath, looksOneOff, settingChanged, settingDefault, shownNumber, storedNumber, suggestedAllowRules, unavailableEntry,
  RUNNERS, type Config, type ModelDef, type ReleaseSectionDef, type SettingDef, type SettingsTabId,
} from '@planestro/shared';
import { api, type State } from '../api.ts';
import { act, useStore } from '../store.ts';

/**
 * Settings (issue #83): tabs by what you are deciding, every row rendered from the shared registry
 * (label, plain summary, default, a "changed" chip, the key it writes, "Learn more"), a search across
 * every tab and a "Show only changed" filter. Each change saves on its own and the server commits it
 * as `config: …`; planestro.local.yml is this machine's and never committed.
 */
const TAB_KEY = 'planestro.settings.tab';
const readTab = (): SettingsTabId => { try { const t = localStorage.getItem(TAB_KEY); if (SETTINGS_TABS.some((x) => x.id === t)) return t as SettingsTabId; } catch { /* private window */ } return 'project'; };

export function SettingsPage() {
  const state = useStore((s) => s.state);
  const [tab, setTabState] = useState<SettingsTabId>(readTab);
  const [q, setQ] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  if (!state) return <p className="muted">Loading…</p>;
  const setTab = (t: SettingsTabId) => { setTabState(t); setQ(''); setOnlyChanged(false); try { localStorage.setItem(TAB_KEY, t); } catch { /* remembered for this visit only */ } };

  const valueOf = (d: SettingDef) => getPath(d.file === 'config' ? state.config : state.local, d.key);
  const isChanged = (d: SettingDef) => settingChanged(d, valueOf(d));
  const needle = q.trim().toLowerCase();
  const tabName = (id: SettingsTabId) => SETTINGS_TABS.find((t) => t.id === id)!.name;
  const matches = (d: SettingDef) => (!needle || [d.label, d.key, d.summary, d.group, tabName(d.tab), ...(d.detail ?? []), shownValue(d, valueOf(d))].join(' ').toLowerCase().includes(needle)) && (!onlyChanged || isChanged(d));
  const searching = Boolean(needle) || onlyChanged;
  const current = SETTINGS_TABS.find((t) => t.id === tab)!;
  const rows = SETTINGS.filter((d) => (searching || d.tab === tab) && matches(d));
  const groups = new Map<string, SettingDef[]>();
  for (const d of rows) { const g = searching ? tabName(d.tab) : d.group; groups.set(g, [...(groups.get(g) ?? []), d]); }
  const changedTotal = SETTINGS.filter(isChanged).length;

  return (
    <div className="settings-page">
      <div className="settings-shell">
        <aside className="settings-rail">
          <input type="search" placeholder="Search all settings" aria-label="Search settings" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          <select className="settings-tabselect" aria-label="Section" value={tab} onChange={(e) => setTab(e.target.value as SettingsTabId)}>
            {SETTINGS_TABS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <nav className="settings-tabs" aria-label="Settings sections">
            {SETTINGS_TABS.map((t) => {
              const n = SETTINGS.filter((d) => d.tab === t.id && isChanged(d)).length;
              const hits = searching ? SETTINGS.filter((d) => d.tab === t.id && matches(d)).length : undefined;
              return (
                <button key={t.id} className={`settings-tab ${t.id === tab && !searching ? 'on' : ''}`} aria-current={t.id === tab ? 'page' : undefined} onClick={() => setTab(t.id)}>
                  <span>{t.name}<small>{hits !== undefined ? `${hits} match${hits === 1 ? '' : 'es'}` : t.hint}</small></span>
                  {n > 0 && <span className="n" title={`${n} changed from the default`}>{n}</span>}
                </button>
              );
            })}
          </nav>
          <div className="settings-railfoot">
            <label><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Show only changed</label>
            <span className="settings-railnote">Changes save as you make them and are committed to the data folder as <code>config: …</code>.</span>
          </div>
        </aside>
        <section className="settings-content" aria-live="polite">
          {searching
            ? <div className="settings-intro"><h2>{rows.length} setting{rows.length === 1 ? '' : 's'} {needle ? <>match “{q.trim()}”</> : 'changed from the defaults'}</h2><p>From every tab. Clear the search to go back to {current.name}.</p></div>
            : <div className="settings-intro"><h2>{current.name}</h2><p>{current.intro}</p><span className="file">{current.file}</span></div>}
          {!searching && tab === 'budgets' && <BillingCallout state={state} />}
          {!searching && tab === 'data' && <StorageBlock state={state} />}
          {[...groups].map(([g, list]) => (
            <div className="settings-group" key={g}>
              <h3>{g}</h3>
              {list.map((d) => <SettingRow key={`${d.file}:${d.key}`} def={d} value={valueOf(d)} changed={isChanged(d)} state={state} />)}
            </div>
          ))}
          {!rows.length && <p className="settings-empty">Nothing matches. Try a key like <code>ci.</code> or a word like “budget”.</p>}
        </section>
      </div>
      <div className="settings-foot"><span>planestro.yml is versioned with the data folder · planestro.local.yml is this machine's only (gitignored)</span><span>{changedTotal} of {SETTINGS.length} settings differ from planestro's defaults</span></div>
    </div>
  );
}

/** Budgets opens by saying what the dollars are: a yardstick on a Claude plan, real money with an API key. */
function BillingCallout({ state }: { state: State }) {
  return state.billing === 'api_key'
    ? <div className="billing" role="note"><span className="mode">API key</span>
        <p><b>These dollar amounts are real charges.</b> Sessions run on an Anthropic API key{state.api_key === 'env' ? ' (ANTHROPIC_API_KEY in the environment planestro started in)' : ' (This machine → Anthropic API key)'}, so every dollar counted here is billed to your API account. The budgets are what stop one item from spending more than you meant.</p>
        <p className="alt">Without a key, sessions use your Claude login instead: the same numbers become what the work would cost at API prices, and your plan's usage limits are what is spent.</p></div>
    : <div className="billing" role="note"><span className="mode">Claude plan</span>
        <p><b>These dollar amounts are not charges.</b> Sessions run on your Claude login, so the work comes out of your plan's usage limits, not your card. The dollars are what the same work would cost at API prices. planestro uses them as a yardstick, so one item can't use up a week of your plan.</p>
        <p className="alt">With an Anthropic API key set (This machine → Anthropic API key), the same numbers are real money, billed to your API account, and this note says so.</p></div>;
}

function StorageBlock({ state }: { state: State }) {
  const cfg = state.config;
  return (
    <div className="settings-group">
      <h3>Data folder</h3>
      <div className="settings-row">
        <div>
          <div className="label">Where planestro keeps its files</div>
          <div className="sum"><code>{state.dataDir}</code></div>
          <div className="meta"><span>schema {cfg.schema_version} ({state.schema}) · tool {cfg.tool_version}</span><span>{state.git.branch} @ {state.git.head ?? '—'} · {state.git.dirty.length} changed · {state.git.ahead ?? '?'} ahead</span></div>
          {state.invalid.length > 0 && <ul className="small settings-invalid">{state.invalid.map((i) => <li key={i.path}><code>{i.path}</code>: {i.error}</li>)}</ul>}
        </div>
        <div className="ctl"><button onClick={() => act(() => api.gitCommit())}>Commit now</button><button onClick={() => act(() => api.gitPush())}>Push</button><button onClick={() => act(() => api.reload())} title="Read every file again: for edits made by hand while planestro runs">Reload from disk</button></div>
      </div>
    </div>
  );
}

function SettingRow({ def, value, changed, state }: { def: SettingDef; value: unknown; changed: boolean; state: State }) {
  const [more, setMore] = useState(false);
  const wide = def.control === 'models' || def.control === 'sections';
  const dflt = defaultText(def);
  const flag = rowFlag(def, state);
  return (
    <div className={`settings-row ${wide ? 'wide' : ''}`}>
      <div>
        <div className="label">{def.label}{changed && <span className="chip changed">changed</span>}{flag && <span className="chip warn">{flag}</span>}</div>
        {def.summary && <div className="sum">{def.summary}</div>}
        <div className="meta">
          <code>{def.key}</code>{def.file === 'local' && <span>planestro.local.yml</span>}
          {dflt !== undefined && <span>default {dflt}</span>}
          {def.restart && <span>applies after a restart</span>}
          {def.detail && <button className="link" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'Learn more'}</button>}
        </div>
        {more && def.detail && <div className="more">{def.detail.map((p) => <p key={p}>{p}</p>)}</div>}
      </div>
      <Control def={def} value={value} state={state} />
    </div>
  );
}

/** A warning a row earns from the rest of the config, e.g. a fallback switch whose model has no fallback. */
function rowFlag(def: SettingDef, state: State): string | undefined {
  const cfg = state.config;
  if (def.key === 'orchestrator.allow_model_fallback' && cfg.orchestrator.allow_model_fallback) {
    const m = findModel(cfg, cfg.orchestrator.model);
    if (!m || fallbackChain(cfg, m).length < 2) return 'no effect: its model has no fallback';
  }
  if (def.key === 'usage_guard.enabled' && state.billing === 'api_key') return 'idle with an API key';
  return undefined;
}

function defaultText(def: SettingDef): string | undefined {
  if (def.control === 'models' || def.control === 'categories' || def.control === 'secret' || def.control === 'readonly') return undefined;
  const d = settingDefault(def.file, def.key);
  if (!d) return undefined;
  if ('none' in d) return 'none';
  return shownValue(def, d.value) || 'empty';
}

/** A value as text: for the default note and for search ("sandbox", "$25"). */
function shownValue(def: SettingDef, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') { const n = shownNumber(def, v); return def.unit === '$' ? `$${n}` : def.unit ? `${n} ${def.unit}` : String(n); }
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? (x as ReleaseSectionDef).title : String(x))).join(', ');
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, n]) => `${k}: ${typeof n === 'number' ? shownValue(def, n) : String(n)}`).join(', ');
  const opt = def.options?.find((o) => o.value === v);
  return opt ? opt.label : String(v);
}

/** `{ ci: { timeout_min: 30 } }` for `ci.timeout_min`: the shape the server's settings route reads. */
function nest(key: string, v: unknown): Record<string, unknown> { return key.split('.').reduceRight<unknown>((acc, p) => ({ [p]: acc }), v) as Record<string, unknown>; }
const save = (def: SettingDef, v: unknown) => act<unknown>(() => (def.file === 'config' ? api.putConfig(nest(def.key, v)) : api.putLocal(nest(def.key, v))));
/** Bytes shown as MB are whole numbers in the file; anything else is left for the schema to judge. */
const wholeIfScaled = (def: SettingDef, stored: number) => ((def.per ?? 1) > 1 ? Math.round(stored) : stored);
const complain = (msg: string) => { useStore.setState({ error: msg }); setTimeout(() => useStore.setState({ error: undefined }), 6000); };

function Control({ def, value, state }: { def: SettingDef; value: unknown; state: State }): ReactNode {
  switch (def.control) {
    case 'number': return <NumberCtl def={def} value={value as number | undefined} />;
    case 'toggle': return <div className="ctl"><label className="switch"><input type="checkbox" checked={Boolean(value)} aria-label={def.label} onChange={(e) => void save(def, e.target.checked)} /><span /></label></div>;
    case 'text': {
      if (def.lockedWithItems && state.items.length) return <div className="ro">{String(value ?? '')}<br /><span>fixed once items exist</span></div>;
      return <TextCtl def={def} value={value as string | undefined} placeholder={def.key === 'code_repo_path' ? state.codeRepo : def.key === 'worktrees_root' ? state.config.worktrees.root : def.placeholder} />;
    }
    case 'select': return (
      <div className="ctl"><select aria-label={def.label} value={(value as string | undefined) ?? ''} onChange={(e) => void save(def, e.target.value || null)}>
        {def.file === 'local' && <option value="">Same as planestro.yml</option>}
        {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select></div>
    );
    case 'model': {
      const cfg = state.config;
      const known = findModel(cfg, value as string);
      const models = cfg.models.filter((m) => !m.external && (!def.planners || canPlan(m)));
      return (
        <div className="ctl"><select aria-label={def.label} value={known?.id ?? (value as string)} onChange={(e) => void save(def, e.target.value)}>
          {!known && <option value={value as string}>{String(value)}</option>}
          {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></div>
      );
    }
    case 'list': return <ListCtl def={def} value={(value as string[] | undefined) ?? []} suggested={def.key === 'permissions.allow' ? suggestedAllowRules(state.toolchain ?? [], (value as string[] | undefined) ?? []) : undefined} />;
    case 'record': return <RecordCtl def={def} value={(value as Record<string, number> | undefined) ?? {}} />;
    case 'commands': return <CommandsCtl def={def} value={(value as Record<string, string> | undefined) ?? {}} />;
    case 'secret': return <SecretCtl def={def} state={state} />;
    case 'readonly': {
      const names = Object.keys((value as Record<string, unknown> | undefined) ?? {});
      return <div className="ro">{names.length ? names.join(', ') : 'none'}</div>;
    }
    case 'categories': return <CategoriesCtl cfg={state.config} />;
    case 'sections': return <SectionsCtl def={def} value={(value as ReleaseSectionDef[] | undefined) ?? []} />;
    case 'models': return <ModelsCtl state={state} />;
  }
}

function NumberCtl({ def, value }: { def: SettingDef; value: number | undefined }) {
  const shown = value === undefined ? '' : String(shownNumber(def, value));
  const commit = (el: HTMLInputElement) => {
    const raw = el.value.trim();
    if (raw === shown) return;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || (def.min !== undefined && n < def.min)) { el.value = shown; complain(`${def.label}: ${raw === '' ? 'a number is needed' : `at least ${def.min}${def.unit && def.unit !== '$' ? ` ${def.unit}` : ''}`}`); return; }
    void save(def, wholeIfScaled(def, storedNumber(def, n)));
  };
  return (
    <div className="ctl">
      {def.unit === '$' && <span className="unit">$</span>}
      <input type="number" key={shown} defaultValue={shown} min={def.min} step="any" aria-label={def.label} onBlur={(e) => commit(e.target)} onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget); }} />
      {def.unit && def.unit !== '$' && <span className="unit">{def.unit}</span>}
    </div>
  );
}

function TextCtl({ def, value, placeholder }: { def: SettingDef; value: string | undefined; placeholder?: string }) {
  const [out, setOut] = useState<string>();
  const commit = (el: HTMLInputElement) => { if (el.value.trim() !== (value ?? '')) void save(def, el.value.trim() || null); };
  const notify = def.key.startsWith('notifications.') ? (def.key.split('.')[1] as 'on_merge' | 'on_usage_pause') : undefined;
  return (
    <div className="ctl">
      <input className={def.mono ? 'mono' : ''} key={value ?? ''} defaultValue={value ?? ''} placeholder={placeholder} aria-label={def.label} onBlur={(e) => commit(e.target)} onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget); }} />
      {notify && <button disabled={!value} title={value ? 'Run it now, the way the event would' : 'Save a command first'} onClick={() => void act(() => api.testNotification(notify)).then((r) => r && setOut(r.code === 0 ? `ran (exit 0)${r.output ? `: ${r.output}` : ''}` : `exit ${r.code}: ${r.output}`))}>Test</button>}
      {out && <span className="small muted ctl-note">{out}</span>}
    </div>
  );
}

function ListCtl({ def, value, suggested }: { def: SettingDef; value: string[]; suggested?: string[] }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (!v) return; if (value.includes(v)) { complain(`${def.label}: "${v}" is already there`); return; } void save(def, [...value, v]).then((r) => r && setDraft('')); };
  return (
    <div className="setting-list">
      {value.map((v) => {
        const oneOff = def.key === 'permissions.allow' && looksOneOff(v);
        return (
          <div key={v} className={`li ${oneOff ? 'bad' : ''}`}>
            <code>{v}</code>
            {oneOff && <span className="chip changed" title='Looks like a single command saved by "Always allow": it matches only that exact command'>one-off?</span>}
            <button className="small" aria-label={`Remove ${v}`} title="Remove" onClick={() => void save(def, value.filter((x) => x !== v))}>×</button>
          </div>
        );
      })}
      <form className="li add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className={def.mono ? 'mono' : ''} placeholder={def.placeholder ?? 'Add…'} aria-label={`Add to ${def.label}`} value={draft} onChange={(e) => setDraft(e.target.value)} data-dirty={draft.trim() ? 'true' : undefined} />
        <button className="small" type="submit" disabled={!draft.trim()}>Add</button>
      </form>
      {suggested && suggested.length > 0 && (
        <div className="li suggest" role="group" aria-label={`Suggested for ${def.label}`}>
          <span className="small muted">For this repository, inside the worktree only:</span>
          {suggested.map((s) => <button key={s} className="small mono" title={`Add ${s}`} onClick={() => void save(def, [...value, s])}>+ {s.replace(/^Bash\((.*) \*\)@worktree$/, '$1')}</button>)}
        </div>
      )}
    </div>
  );
}

/** Names with a number each (`codex → 1 turn`, `.ogg → 20 MB`). */
function RecordCtl({ def, value }: { def: SettingDef; value: Record<string, number> }) {
  const [name, setName] = useState('');
  const [num, setNum] = useState('');
  const add = () => {
    const k = name.trim(); const n = Number(num);
    if (!k || !num.trim() || !Number.isFinite(n) || (def.min !== undefined && n < def.min)) { complain(`${def.label}: a name and a number of at least ${def.min ?? 0}`); return; }
    void save(def, { ...value, [k]: wholeIfScaled(def, storedNumber(def, n)) }).then((r) => { if (r) { setName(''); setNum(''); } });
  };
  return (
    <div className="setting-list">
      {Object.entries(value).map(([k, n]) => (
        <div key={k} className="li"><code>{k}</code><span className="muted">{shownNumber(def, n)} {def.unit}</span>
          <button className="small" aria-label={`Remove ${k}`} title="Remove" onClick={() => { const { [k]: _gone, ...rest } = value; void save(def, rest); }}>×</button></div>
      ))}
      <form className="li add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="mono" placeholder={def.placeholder} aria-label={`Name for ${def.label}`} value={name} onChange={(e) => setName(e.target.value)} />
        <input type="number" step="any" min={def.min} placeholder={def.unit} aria-label={`${def.unit ?? 'Number'} for ${def.label}`} value={num} onChange={(e) => setNum(e.target.value)} />
        <button className="small" type="submit" disabled={!name.trim() || !num.trim()}>Add</button>
      </form>
    </div>
  );
}

/** Rows of a file pattern and the command that regenerates it (worktrees.generated, #63). */
function CommandsCtl({ def, value }: { def: SettingDef; value: Record<string, string> }) {
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const add = () => {
    const k = name.trim(); const c = cmd.trim();
    if (!k || !c) { complain(`${def.label}: a file pattern and a command`); return; }
    void save(def, { ...value, [k]: c }).then((r) => { if (r) { setName(''); setCmd(''); } });
  };
  return (
    <div className="setting-list">
      {Object.entries(value).map(([k, c]) => (
        <div key={k} className="li"><span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}><code>{k}</code><code className="muted small" style={{ overflowWrap: 'anywhere' }}>{c}</code></span>
          <button className="small" aria-label={`Remove ${k}`} title="Remove" onClick={() => { const { [k]: _gone, ...rest } = value; void save(def, rest); }}>×</button></div>
      ))}
      <form className="li add" style={{ flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="mono" style={{ flex: '1 1 100%' }} placeholder={def.placeholder} aria-label={`File pattern for ${def.label}`} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="mono" style={{ flex: '1 1 0' }} placeholder="command that regenerates it" aria-label={`Command for ${def.label}`} value={cmd} onChange={(e) => setCmd(e.target.value)} />
        <button className="small" type="submit" disabled={!name.trim() || !cmd.trim()}>Add</button>
      </form>
    </div>
  );
}

/** The API key is never sent to the page: it shows whether one is set, and takes a replacement. */
function SecretCtl({ def, state }: { def: SettingDef; state: State }) {
  const [draft, setDraft] = useState('');
  const where = state.api_key ?? 'none';
  return (
    <div className="ctl">
      <span className={`chip ${where === 'none' ? '' : 'ok'}`}>{where === 'local' ? 'set here' : where === 'env' ? 'set in the environment' : 'not set'}</span>
      <form className="ctl-inline" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void save(def, draft.trim()).then((r) => r && setDraft('')); }}>
        <input type="password" autoComplete="off" placeholder={where === 'local' ? 'Replace with…' : def.placeholder} aria-label={def.label} value={draft} onChange={(e) => setDraft(e.target.value)} data-dirty={draft ? 'true' : undefined} />
        <button className="small" type="submit" disabled={!draft.trim()}>Save</button>
      </form>
      {where === 'local' && <button className="small danger" onClick={() => { if (confirm('Remove the API key from planestro.local.yml? After a restart, sessions use your Claude login.')) void save(def, null); }}>Remove</button>}
    </div>
  );
}

function CategoriesCtl({ cfg }: { cfg: Config }) {
  const [newCat, setNewCat] = useState('');
  return (
    <div className="setting-list">
      {cfg.categories.map((c) => (
        <div className="li" key={c}>
          <span className="grow">{c}{cfg.defaults.category === c && <span className="chip ok" style={{ marginLeft: 6 }}>default</span>}</span>
          {cfg.defaults.category !== c && <button className="small" onClick={() => act(() => api.categories({ op: 'default', name: c }))}>Make default</button>}
          <button className="small" onClick={() => { const to = prompt(`Rename "${c}" to:`, c); if (to && to !== c) void act(() => api.categories({ op: 'rename', from: c, to })); }}>Rename</button>
          <button className="small danger" aria-label={`Remove ${c}`} title="Remove" disabled={cfg.categories.length < 2} onClick={() => { const rest = cfg.categories.filter((x) => x !== c); const to = prompt(`Remove "${c}". Move its items to which category?\n${rest.join(', ')}`, rest[0]); if (to && rest.includes(to)) void act(() => api.categories({ op: 'remove', name: c, reassign_to: to })); }}>×</button>
        </div>
      ))}
      <form className="li add" onSubmit={(e) => { e.preventDefault(); if (!newCat.trim()) return; void act(() => api.categories({ op: 'add', name: newCat.trim() })); setNewCat(''); }}>
        <input placeholder="New category" aria-label="New category" value={newCat} onChange={(e) => setNewCat(e.target.value)} />
        <button className="small" type="submit" disabled={!newCat.trim()}>Add</button>
      </form>
    </div>
  );
}

/** Release sections are edited as a whole (order, limits, carry) and saved with one button. */
function SectionsCtl({ def, value }: { def: SettingDef; value: ReleaseSectionDef[] }) {
  const [draft, setDraft] = useState<ReleaseSectionDef[] | undefined>();
  const rows = draft ?? value;
  const edit = (i: number, patch: Partial<ReleaseSectionDef>) => setDraft(rows.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => { const next = [...rows]; const [s] = next.splice(i, 1); next.splice(i + by, 0, s); setDraft(next); };
  return (
    <div className="sections-editor" data-dirty={draft ? 'true' : undefined}>
      {rows.map((s, i) => (
        <div className="section-row" key={i}>
          <input className="grow" value={s.title} placeholder="Heading" aria-label={`Section ${i + 1} heading`} onChange={(e) => edit(i, { title: e.target.value })} />
          <label>limit <input type="number" min={1} value={s.max_chars ?? ''} placeholder="none" aria-label={`Section ${i + 1} character limit`} onChange={(e) => edit(i, { max_chars: e.target.value ? Number(e.target.value) : undefined })} /> chars</label>
          <label title="A new release starts with the previous release's text"><input type="checkbox" checked={s.carry ?? false} onChange={(e) => edit(i, { carry: e.target.checked })} /> carry over</label>
          <input className="hint" value={s.hint ?? ''} placeholder="Hint under the heading (optional)" aria-label={`Section ${i + 1} hint`} onChange={(e) => edit(i, { hint: e.target.value || undefined })} />
          <span className="section-acts">
            <button className="small" disabled={i === 0} aria-label="Move up" title="Move up" onClick={() => move(i, -1)}>↑</button>
            <button className="small" disabled={i === rows.length - 1} aria-label="Move down" title="Move down" onClick={() => move(i, 1)}>↓</button>
            <button className="small danger" disabled={rows.length < 2} aria-label={`Remove ${s.title}`} title="Remove" onClick={() => setDraft(rows.filter((_, j) => j !== i))}>×</button>
          </span>
        </div>
      ))}
      <div className="row">
        <button className="small" onClick={() => setDraft([...rows, { title: '', carry: false }])}>Add a section</button>
        <span className="grow" />
        {draft && <button className="small" onClick={() => setDraft(undefined)}>Discard</button>}
        <button className="small primary" disabled={!draft || rows.some((s) => !s.title.trim())} onClick={() => void save(def, rows).then((r) => r && setDraft(undefined))}>Save sections</button>
      </div>
    </div>
  );
}

// ---- models

function ModelsCtl({ state }: { state: State }) {
  const cfg = state.config;
  const [editing, setEditing] = useState<ModelDef | 'new'>();
  const problems = fallbackProblems(cfg);
  const roles = (m: ModelDef) => [cfg.defaults.planner === m.id && 'default planner', cfg.defaults.implementer === m.id && 'default implementer', findModel(cfg, cfg.orchestrator.model)?.id === m.id && 'orchestrator'].filter(Boolean).join(' · ');
  return (
    <div className="models">
      {problems.map((p) => <p key={p} className="small" style={{ color: 'var(--hot)', margin: 0 }}>{p} — ignored until fixed.</p>)}
      {cfg.models.map((m) => {
        const out = unavailableEntry(state.local.model_unavailable, m.id, new Date());
        const runner = m.runner ?? 'claude';
        const chain = fallbackChain(cfg, m);
        return (
          <div className="model" key={m.id}>
            <div>
              <h4>{m.label}
                {m.external ? <span className="chip">external (watched)</span> : out ? <span className="chip warn" title={out.reason}>out until {fmtTime(out.until)}</span> : <span className="chip ok">available</span>}
                {m.hold_for_review && <span className="chip">holds PRs for your review</span>}
                {m.engine_commits && <span className="chip">planestro commits for it</span>}
                {m.mcp.length > 0 && <span className="chip">MCP: {m.mcp.join(', ')}{m.mcp_calls_per_item ? ` (≤${m.mcp_calls_per_item} calls)` : ''}</span>}
              </h4>
              <div className="facts">
                <span>runner <b>{runner === 'claude' ? 'Claude' : 'Codex'}</b></span>
                <span>model <b className="mono">{runner === 'claude' ? m.claude_model ?? '—' : m.codex_model ?? 'CLI default'}</b></span>
                <span>{canPlan(m) ? 'plans and implements' : m.external ? 'not run by planestro' : 'implements only'}{roles(m) ? ` · ${roles(m)}` : ''}</span>
                {chain.length > 1 && <span>out of usage → <b>{chain.slice(1).map((x) => x.label).join(' → ')}</b></span>}
                <span className="mono dim">id {m.id}</span>
              </div>
            </div>
            <div className="acts">
              <button className="small" onClick={() => setEditing(m)}>Edit</button>
              {!m.external && (out
                ? <button className="small" onClick={() => act(() => api.clearModelUnavailable(m.id))}>Available now</button>
                : <button className="small" onClick={() => { const until = askUntil(m.label); if (until) void act(() => api.markModelUnavailable(m.id, until)); }}>Mark unavailable…</button>)}
            </div>
            {m.description && <div className="desc">{m.description}</div>}
          </div>
        );
      })}
      <div><button className="primary" onClick={() => setEditing('new')}>Add a model</button></div>
      {editing && <ModelDialog cfg={cfg} mcpNames={Object.keys(state.local.mcp_servers ?? {})} model={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}

function ModelDialog({ cfg, model, mcpNames, onClose }: { cfg: Config; model?: ModelDef; mcpNames: string[]; onClose: () => void }) {
  const [m, setM] = useState<Partial<ModelDef>>(model ?? { runner: 'claude', mcp: [] });
  const set = (patch: Partial<ModelDef>) => setM({ ...m, ...patch });
  const runner = m.runner ?? 'claude';
  const fallbacks = cfg.models.filter((x) => x.id !== m.id && (x.runner ?? 'claude') === runner && !x.external);
  const servers = [...new Set([...mcpNames, ...(m.mcp ?? [])])];
  const submit = async () => {
    const id = (m.id ?? '').trim();
    if (!id || !m.label?.trim()) { complain('A model needs an id and a label'); return; }
    if (!model && cfg.models.some((x) => x.id === id)) { complain(`There is already a model ${id}`); return; }
    const body: Partial<ModelDef> = { ...m, id, claude_model: runner === 'claude' ? m.claude_model : undefined, codex_model: runner === 'codex' ? m.codex_model : undefined };
    if (await act(() => api.putModel(id, body))) onClose();
  };
  return (
    <div className="dialog" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="model-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} data-dirty="true">
        <h3 style={{ margin: 0 }}>{model ? `Edit ${model.label}` : 'Add a model'}</h3>
        <label>Label <input value={m.label ?? ''} onChange={(e) => set({ label: e.target.value })} placeholder="Opus 5.5" required /></label>
        <label>Id <input className="mono" value={m.id ?? ''} disabled={Boolean(model)} onChange={(e) => set({ id: e.target.value })} placeholder="opus-5-5" title={model ? 'Items store the id, so it cannot change' : 'What items store as their planner or implementer'} required /></label>
        <label>Runner <select value={runner} onChange={(e) => set({ runner: e.target.value as ModelDef['runner'], fallback: undefined })}>{RUNNERS.map((r) => <option key={r} value={r}>{r === 'claude' ? 'Claude (plans and implements)' : 'Codex (implements only)'}</option>)}</select></label>
        {runner === 'claude'
          ? <label>Claude model <input className="mono" value={m.claude_model ?? ''} onChange={(e) => set({ claude_model: e.target.value })} placeholder="claude-opus-5-5" /></label>
          : <label>Codex model <input className="mono" value={m.codex_model ?? ''} onChange={(e) => set({ codex_model: e.target.value })} placeholder="Codex's own default" /></label>}
        <label>What it is for <input value={m.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="One line; the epic planner routes children by it" /></label>
        <label>When out of usage <select value={m.fallback ?? ''} onChange={(e) => set({ fallback: e.target.value || undefined })}><option value="">Block (no fallback)</option>{fallbacks.map((x) => <option key={x.id} value={x.id}>Fall back to {x.label}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={m.hold_for_review ?? false} onChange={(e) => set({ hold_for_review: e.target.checked })} /> Hold its pull requests for your review</label>
        <label className="check"><input type="checkbox" checked={m.engine_commits ?? false} onChange={(e) => set({ engine_commits: e.target.checked })} /> planestro commits for it (a sandbox that cannot write git's files)</label>
        <label className="check"><input type="checkbox" checked={m.external ?? false} onChange={(e) => set({ external: e.target.checked })} /> External: not run by planestro, its items are only watched</label>
        {runner === 'claude' && <fieldset><legend className="small muted">MCP servers its sessions get {servers.length ? '' : '(none in planestro.local.yml)'}</legend>
          {servers.map((s) => <label key={s} className="check"><input type="checkbox" checked={(m.mcp ?? []).includes(s)} onChange={(e) => set({ mcp: e.target.checked ? [...(m.mcp ?? []), s] : (m.mcp ?? []).filter((x) => x !== s) })} /> {s}</label>)}
          {(m.mcp ?? []).length > 0 && <label>Calls per item <input type="number" min={1} value={m.mcp_calls_per_item ?? ''} placeholder="no cap" onChange={(e) => set({ mcp_calls_per_item: e.target.value ? Number(e.target.value) : undefined })} /></label>}
        </fieldset>}
        <div className="row">
          {model && <button type="button" className="danger" onClick={() => { if (confirm(`Remove ${model.label}? Only possible while no default, fallback or open item uses it.`)) void act(() => api.removeModel(model.id)).then((r) => r && onClose()); }}>Remove</button>}
          <span className="grow" /><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary">{model ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Ask when a model comes back: a local time, or a number of hours from now. */
function askUntil(label: string): string | undefined {
  const later = new Date(Date.now() + 12 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const def = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())} ${pad(later.getHours())}:${pad(later.getMinutes())}`;
  const answer = prompt(`${label} is unavailable until when? A local time (YYYY-MM-DD HH:MM) or a number of hours.`, def);
  if (!answer) return undefined;
  const hours = Number(answer.trim());
  const d = Number.isFinite(hours) && answer.trim() !== '' ? new Date(Date.now() + hours * 3_600_000) : new Date(answer.trim().replace(' ', 'T'));
  if (isNaN(d.getTime()) || d.getTime() <= Date.now()) { alert(`Not a future time: ${answer}`); return undefined; }
  return d.toISOString();
}
