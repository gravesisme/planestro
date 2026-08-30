import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const parsed = LocalConfig.safeParse(YAML.parse(readFileSync(path, 'utf8')) ?? {});
  if (!parsed.success) throw new Error(`invalid ${LOCAL_CONFIG_FILE}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
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
  atomicWrite(join(dataDir, LOCAL_CONFIG_FILE), YAML.stringify(local, { lineWidth: 0 }));
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
  mkdirSync(join(registryPath(), '..'), { recursive: true });
  writeFileSync(registryPath(), YAML.stringify({ projects: list }, { lineWidth: 0 }));
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
