/**
 * Writes from the Settings page (issue #83). A body names settings by their place in the file
 * (`{ ci: { timeout_min: 30 } }`); only keys the shared registry marks editable are accepted, the
 * result is validated as a whole through the zod schema before anything is written, and relations
 * the schema cannot see (a planner that can plan, a default category that exists) are checked here.
 * `null` or an empty string removes a key, so it falls back to its default.
 */
import YAML from 'yaml';
import { Config, LocalConfig, ModelDef, SETTINGS, WRITABLE_CONTROLS, canPlan, fallbackProblems, findModel, getPath, settingDef, type SettingDef, type SettingFile } from '@planestro/shared';
import type { DataStore } from './store/DataStore.ts';

type Write = [SettingDef, unknown];

/** The registry keys a body sets, cleaned. A path that is not an editable setting is refused whole. */
export function settingWrites(file: SettingFile, body: unknown): Write[] {
  if (!isPlainObject(body)) throw new Error('expected an object of settings');
  const out: Write[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const def = settingDef(file, key);
      if (def) {
        if (!WRITABLE_CONTROLS.includes(def.control)) throw new Error(`${key}: not changed from here`);
        out.push([def, clean(def, v)]);
      } else if (isPlainObject(v) && SETTINGS.some((s) => s.file === file && s.key.startsWith(`${key}.`))) walk(v, key);
      else throw new Error(`${key}: not a setting that can be changed here`);
    }
  };
  walk(body, '');
  if (!out.length) throw new Error('no settings given');
  return out;
}

function clean(def: SettingDef, v: unknown): unknown {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return undefined;
  switch (def.control) {
    case 'text': case 'secret': case 'select': case 'model':
      if (typeof v !== 'string') throw new Error(`${def.key}: expected text`);
      return v.trim();
    case 'list': {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`${def.key}: expected a list of text`);
      const list = (v as string[]).map((x) => x.trim());
      if (list.some((x) => !x)) throw new Error(`${def.key}: an entry is empty`);
      const dup = list.find((x, i) => list.indexOf(x) !== i);
      if (dup) throw new Error(`${def.key}: "${dup}" is listed twice`);
      return list;
    }
    case 'record': {
      if (!isPlainObject(v)) throw new Error(`${def.key}: expected names with numbers`);
      const out: Record<string, unknown> = {};
      for (const [k, n] of Object.entries(v)) { if (!k.trim()) throw new Error(`${def.key}: a name is empty`); out[k.trim()] = n; }
      return out;
    }
    case 'commands': {
      if (!isPlainObject(v)) throw new Error(`${def.key}: expected file patterns with commands`);
      const out: Record<string, string> = {};
      for (const [k, c] of Object.entries(v)) {
        if (!k.trim()) throw new Error(`${def.key}: a file pattern is empty`);
        if (typeof c !== 'string' || !c.trim()) throw new Error(`${def.key}: ${k.trim()} needs a command`);
        out[k.trim()] = c.trim();
      }
      return out;
    }
    case 'sections': {
      if (!Array.isArray(v)) throw new Error(`${def.key}: expected a list of sections`);
      const titles = v.map((s) => (isPlainObject(s) && typeof s.title === 'string' ? s.title.trim() : ''));
      const dup = titles.find((t, i) => t && titles.indexOf(t) !== i);
      if (dup) throw new Error(`${def.key}: two sections are called "${dup}"`);
      // Leave out what equals "not set", so the file keeps only what the user chose.
      return v.map((s) => Object.fromEntries(Object.entries(s as Record<string, unknown>).filter(([k, x]) => x !== undefined && x !== null && x !== '' && !(k === 'carry' && x === false)).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x])));
    }
    default: return v; // numbers and toggles: the schema checks them
  }
}

/** Apply settings to planestro.yml: one semantic commit (`config: ci.timeout_min 30`). */
export function applyConfigSettings(store: DataStore, body: unknown): Config {
  const writes = settingWrites('config', body);
  const draft = structuredClone(store.config) as unknown as Record<string, unknown>;
  for (const [def, v] of writes) setPath(draft, def.key, v);
  const parsed = Config.safeParse(draft);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const next = parsed.data;
  for (const w of writes) {
    const [def, v] = w;
    if (def.lockedWithItems && store.items.size && v !== getPath(store.config, def.key)) throw new Error(`${def.key}: fixed once the project has items (${store.items.size} now)`);
    if (def.key === 'orchestrator.model' && typeof v === 'string') {
      const m = findModel(next, v);
      if (!m || !canPlan(m)) throw new Error(`orchestrator.model: ${v} does not have orchestration capability in models:`);
      w[1] = m.id; // Settings writes the id, whatever it was given
    }
  }
  assertNoNewProblems(store.config, next);
  return store.updateConfig((doc) => { for (const [def, v] of writes) setDoc(doc, def.key.split('.'), v); }, `config: ${describe(writes, store.config)}`);
}

/** Apply settings to planestro.local.yml (not committed: it is this machine's). */
export function applyLocalSettings(store: DataStore, body: unknown): LocalConfig {
  const writes = settingWrites('local', body);
  const next = structuredClone(store.local) as unknown as Record<string, unknown>;
  // An undefined value overrides the old one in updateLocal's merge and is left out of the file.
  for (const [def, v] of writes) setPath(next, def.key, v, true);
  const parsed = LocalConfig.safeParse(next);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return store.updateLocal(next as LocalConfig);
}

/** Add or replace one model row. Its id never changes: items store it as their planner / implementer. */
export function putModel(store: DataStore, id: string, body: unknown): Config {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('a model id is letters, digits, dots, dashes and underscores');
  if (!isPlainObject(body)) throw new Error('expected a model');
  if (body.id !== undefined && body.id !== id) throw new Error(`a model's id cannot change (items name it): add a new model instead`);
  const raw = Object.fromEntries(Object.entries({ ...body, id }).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const parsed = ModelDef.strict().safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'model'}: ${i.message}`).join('; '));
  const def = parsed.data;
  if (def.runner === 'claude' && !def.external && !def.claude_model) throw new Error('a claude model needs its Claude model id (claude_model)');
  if (def.mcp.some((m, i) => def.mcp.indexOf(m) !== i)) throw new Error('an MCP server is listed twice');
  const exists = store.config.models.findIndex((m) => m.id === id);
  const models = exists >= 0 ? store.config.models.map((m) => (m.id === id ? def : m)) : [...store.config.models, def];
  const next = { ...store.config, models };
  const before = new Set(fallbackProblems(store.config));
  const added = fallbackProblems(next).filter((p) => !before.has(p));
  if (added.length) throw new Error(added.join('; '));
  assertNoNewProblems(store.config, next);
  // Only what differs from a model row's defaults goes in the file.
  const row = Object.fromEntries(Object.entries(def).filter(([k, v]) => !(k === 'runner' && v === 'claude') && !(k === 'external' && v === false) && !(Array.isArray(v) && !v.length) && v !== false && v !== undefined));
  return store.updateConfig((doc) => {
    if (exists >= 0) doc.setIn(['models', exists], doc.createNode(row));
    else (doc.get('models') as YAML.YAMLSeq).add(doc.createNode(row));
  }, `config: ${exists >= 0 ? 'edit' : 'add'} model ${id}`);
}

/** Remove a model nobody uses: not a default, not the orchestrator, no one's fallback, no open item's model. */
export function removeModel(store: DataStore, id: string): Config {
  const cfg = store.config;
  const idx = cfg.models.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error(`unknown model ${id}`);
  const users = [
    cfg.defaults.planner === id && 'the default planner', cfg.defaults.implementer === id && 'the default implementer',
    findModel(cfg, cfg.orchestrator.model)?.id === id && 'the orchestrator',
    ...cfg.models.filter((m) => m.fallback === id).map((m) => `${m.label}'s fallback`),
    ...store.listItems().filter((i) => !['FINISHED', 'ICEBOX'].includes(i.file.frontmatter.status) && (i.file.frontmatter.planner === id || i.file.frontmatter.implementer === id)).map((i) => i.id),
  ].filter(Boolean);
  if (users.length) throw new Error(`${id} is still used by ${users.slice(0, 6).join(', ')}${users.length > 6 ? ', …' : ''}`);
  return store.updateConfig((doc) => { doc.deleteIn(['models', idx]); }, `config: remove model ${id}`);
}

/** A write may not add a relation problem; one already in a hand-edited file does not block unrelated writes. */
function assertNoNewProblems(before: Config, after: Config): void {
  const had = new Set(relationProblems(before));
  const added = relationProblems(after).filter((p) => !had.has(p));
  if (added.length) throw new Error(added.join('; '));
}

/** What the schema cannot say: defaults point at models and a category that exist, and planners can plan. */
function relationProblems(cfg: Config): string[] {
  const out: string[] = [];
  const planner = findModel(cfg, cfg.defaults.planner);
  if (!planner) out.push(`defaults.planner: ${cfg.defaults.planner} is not a model in models:`);
  else if (!canPlan(planner)) out.push(`defaults.planner: ${planner.label} cannot plan with its configured transport`);
  if (!findModel(cfg, cfg.defaults.implementer)) out.push(`defaults.implementer: ${cfg.defaults.implementer} is not a model in models:`);
  const orch = findModel(cfg, cfg.orchestrator.model);
  if (orch && !canPlan(orch)) out.push(`orchestrator.model: ${orch.label} does not have orchestration capability`);
  if (!cfg.categories.includes(cfg.defaults.category)) out.push(`defaults.category: ${cfg.defaults.category} is not a category`);
  return out;
}

/** A commit subject naming what changed: `permissions.allow +"Bash(npm test*)"`, `ci.timeout_min 30`. */
function describe(writes: Write[], before: Config): string {
  const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  return writes.map(([def, v]) => {
    if (v === undefined) return `${def.key} cleared`;
    const old = getPath(before, def.key);
    if (Array.isArray(v) && def.control === 'list') {
      const was = Array.isArray(old) ? (old as string[]) : [];
      const add = (v as string[]).filter((x) => !was.includes(x)); const del = was.filter((x) => !(v as string[]).includes(x));
      if (add.length + del.length === 1) return `${def.key} ${add.length ? '+' : '−'}${JSON.stringify(short(add[0] ?? del[0]))}`;
      return add.length || del.length ? `${def.key} +${add.length} −${del.length}` : `${def.key} reordered`;
    }
    if (def.control === 'sections') return `${def.key} (${(v as unknown[]).length})`;
    return `${def.key} ${short(typeof v === 'string' ? v : JSON.stringify(v))}`;
  }).join('; ');
}

function setDoc(doc: YAML.Document, path: string[], v: unknown): void {
  if (v !== undefined) doc.setIn(path, v);
  else if (doc.hasIn(path)) doc.deleteIn(path);
}

function setPath(obj: Record<string, unknown>, key: string, v: unknown, keepUndefined = false): void {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) { if (!isPlainObject(cur[p])) cur[p] = {}; cur = cur[p] as Record<string, unknown>; }
  if (v === undefined && !keepUndefined) delete cur[parts.at(-1)!];
  else cur[parts.at(-1)!] = v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
