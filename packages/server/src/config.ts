import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import YAML from 'yaml';
import { Config, LocalConfig, SCHEMA_VERSION } from '@planestro/shared';
import { atomicWrite } from './store/atomicWrite.ts';

export const TOOL_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const CONFIG_FILE = 'planestro.yml';
export const LOCAL_CONFIG_FILE = 'planestro.local.yml';

export function readConfig(dataDir: string): Config {
  const path = join(dataDir, CONFIG_FILE);
  if (!existsSync(path)) throw new Error(`not a planestro data dir (no ${CONFIG_FILE}): ${dataDir}`);
  const parsed = Config.safeParse(YAML.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`invalid ${CONFIG_FILE}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

export function readLocalConfig(dataDir: string): LocalConfig {
  const path = join(dataDir, LOCAL_CONFIG_FILE);
  if (!existsSync(path)) return LocalConfig.parse({});
  const raw = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  const dropped = dropModelKeys(raw);
  const changed = normalizeLocalUsage(raw) || dropped.length > 0;
  const parsed = LocalConfig.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${LOCAL_CONFIG_FILE}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  if (changed) writeLocalConfig(dataDir, parsed.data);
  for (const d of dropped) console.log(`[warn] ${LOCAL_CONFIG_FILE}: removed ${d}: planestro runs on the claude and codex logins, never a model API key`);
  return parsed.data;
}

/**
 * Model API keys are gone (sessions run on the CLIs' own logins): a planestro.local.yml from before keeps neither the
 * Console key in plain text nor an account that names one. Says what it dropped, so the caller can tell the user once
 * (the file is rewritten without them). An account left with no `home` goes with its key: an item on it then blocks
 * `account_missing`, never quietly the default login.
 */
export function dropModelKeys(raw: any): string[] {
  const dropped: string[] = [];
  if (!raw || typeof raw !== 'object') return dropped;
  if ('anthropic_api_key' in raw) { delete raw.anthropic_api_key; dropped.push('anthropic_api_key'); }
  const accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
  for (const [name, a] of Object.entries<any>(accounts)) {
    if (!a || typeof a !== 'object' || !('api_key_env' in a)) continue;
    delete a.api_key_env;
    if (a.home) dropped.push(`accounts.${name}.api_key_env`);
    else { delete accounts[name]; dropped.push(`account ${name} (it had only api_key_env)`); }
  }
  return dropped;
}

/** Update planestro.yml in place, preserving comments and key order of untouched keys. */
export function patchConfigFile(dataDir: string, patch: (doc: YAML.Document) => void): Config {
  const path = join(dataDir, CONFIG_FILE);
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  patch(doc);
  const next = Config.safeParse(doc.toJS());
  if (!next.success) throw new Error(`config patch rejected: ${next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
  return next.data;
}

export function writeLocalConfig(dataDir: string, local: LocalConfig): void {
  atomicWrite(join(dataDir, LOCAL_CONFIG_FILE), YAML.stringify(local, { lineWidth: 0 }), 0o600);
}

/** Absolute code-repo path: local override, else config path relative to the data dir. */
export function resolveCodeRepo(dataDir: string, config: Config, local: LocalConfig): string {
  const p = local.code_repo_path ?? config.code_repo.path;
  return isAbsolute(p) ? p : resolve(dataDir, p);
}

export function resolveWorktreesRoot(dataDir: string, config: Config, local: LocalConfig): string {
  const p = local.worktrees_root ?? config.worktrees.root;
  return isAbsolute(p) ? p : resolve(resolveCodeRepo(dataDir, config, local), p);
}

export type SchemaStatus = 'current' | 'needs_migration' | 'too_new';
export function schemaStatus(config: Config): SchemaStatus {
  if (config.schema_version === SCHEMA_VERSION) return 'current';
  return config.schema_version < SCHEMA_VERSION ? 'needs_migration' : 'too_new';
}

/** Normalize local usage state before schema parsing, independently on each machine. */
export function normalizeLocalUsage(raw: any): boolean {
  const e = raw?.engine;
  if (!e || typeof e !== 'object') return false;
  const changed = e.usage_guard !== undefined || e.usage_guard_last !== undefined || e.paused_by === 'usage_guard';
  if (e.usage_guard) e.provider_guards = { claude: e.usage_guard, ...e.provider_guards };
  if (e.usage_guard_last) e.provider_guard_last = { claude: e.usage_guard_last, ...e.provider_guard_last };
  if (e.paused_by === 'usage_guard') { e.paused = false; delete e.paused_by; }
  delete e.usage_guard; delete e.usage_guard_last;
  return changed;
}

// ---- project registry (~/.planestro/projects.yml) ----

export interface RegisteredProject { name: string; data_dir: string; last_used?: string }

export function registryPath(): string {
  return join(process.env.PLANESTRO_HOME ?? join(homedir(), '.planestro'), 'projects.yml');
}

export function readRegistry(): RegisteredProject[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  const data = YAML.parse(readFileSync(p, 'utf8')) ?? {};
  return Array.isArray(data.projects) ? data.projects : [];
}

export function registerProject(entry: RegisteredProject): void {
  const list = readRegistry().filter((p) => p.data_dir !== entry.data_dir);
  list.push(entry);
  atomicWrite(registryPath(), YAML.stringify({ projects: list }, { lineWidth: 0 }));
}

/** Pick the data dir: explicit arg, PLANESTRO_DATA_DIR, a planestro.yml in cwd, else the most recently used registered project. */
export function locateDataDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.PLANESTRO_DATA_DIR) return resolve(process.env.PLANESTRO_DATA_DIR);
  if (existsSync(join(process.cwd(), CONFIG_FILE))) return process.cwd();
  const reg = readRegistry().sort((a, b) => (b.last_used ?? '').localeCompare(a.last_used ?? ''));
  if (reg[0]) return reg[0].data_dir;
  throw new Error('no data dir: pass one, set PLANESTRO_DATA_DIR, or run `planestro init`');
}
