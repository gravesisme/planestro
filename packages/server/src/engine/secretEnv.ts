import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LocalConfig } from '@planestro/shared';
import { RESERVED_ENV } from './secrets.ts';

/**
 * Secrets handed to a worker's environment (#501): `secret_env` in planestro.local.yml names env vars and the dotenv
 * each is read from. planestro reads the file, never the model: the file stays on the deny list (#227), and the session
 * gets only the values the user named. Values never reach a prompt, the journal, Activity or an item file; what a
 * command prints is redacted (`redactSecretEnv`) before planestro shows or keeps it.
 */
export type SecretEnvConfig = NonNullable<LocalConfig['secret_env']>;


/** A dotenv's `KEY=value` lines: `export ` allowed, `#` comments, single quotes literal, double quotes with \n escapes. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith("'")) { const end = v.indexOf("'", 1); v = end > 0 ? v.slice(1, end) : v.slice(1); }
    else if (v.startsWith('"')) { const end = v.slice(1).search(/(?<!\\)"/); v = (end >= 0 ? v.slice(1, end + 1) : v.slice(1)).replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
    else v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], v);
  }
  return out;
}

/** Where an entry's file is: `~/` is the home folder, a relative path is the code repo's checkout's. */
export function secretEnvFile(file: string, repo: string, home = homedir()): string {
  return file === '~' ? home : file.startsWith('~/') ? join(home, file.slice(2)) : resolve(repo, file);
}

/**
 * The values `secret_env` names, read now (an edit to the file or the config reaches the next turn), and what could
 * not be read: a missing file, a missing key, a reserved name. `missing` names files and keys, never a value.
 */
export function resolveSecretEnv(entries: SecretEnvConfig | undefined, repo: string, o: { home?: string; read?(path: string): string } = {}): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const read = o.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const files = new Map<string, Map<string, string> | string>();
  for (const [name, src] of Object.entries(entries ?? {})) {
    if (RESERVED_ENV.has(name)) { missing.push(`${name}: planestro keeps that variable for itself`); continue; }
    const path = secretEnvFile(src.file, repo, o.home);
    if (!files.has(path)) {
      try { files.set(path, parseDotenv(read(path))); }
      catch (e) { files.set(path, (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${path} does not exist` : `${path} could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})`); }
    }
    const parsed = files.get(path)!;
    if (typeof parsed === 'string') { missing.push(`${name}: ${parsed}`); continue; }
    const key = src.key ?? name;
    const value = parsed.get(key);
    if (value === undefined || value === '') { missing.push(`${name}: ${path} has no ${key}`); continue; }
    env[name] = value;
  }
  return { env, missing };
}

/** Text with every handed-over value (of 4+ characters) replaced by `[secret_env NAME]`, so a command that prints one leaves it nowhere planestro keeps. */
export function redactSecretEnv(text: string, env: Record<string, string> | undefined): string {
  if (!env) return text;
  let out = text;
  for (const [name, value] of Object.entries(env)) if (value.length >= 4 && out.includes(value)) out = out.split(value).join(`[secret_env ${name}]`);
  return out;
}
