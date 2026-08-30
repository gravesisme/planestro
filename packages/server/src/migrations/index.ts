import { SCHEMA_VERSION } from '@planestro/shared';
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../store/atomicWrite.ts';
import { CONFIG_FILE, TOOL_VERSION } from '../config.ts';

export interface Migration { version: number; describe: string; up(dataDir: string, log: (m: string) => void): Promise<void> | void }

/** Ordered by version; each `up` takes the dir from version-1 to version. */
export const MIGRATIONS: Migration[] = [
  { version: 1, describe: 'initial schema', up() { /* baseline: nothing to rewrite */ } },
];

export function currentVersion(dataDir: string): number {
  const doc = YAML.parse(readFileSync(join(dataDir, CONFIG_FILE), 'utf8'));
  return Number(doc?.schema_version ?? 0);
}

/** Apply every migration above the dir's version, bumping schema_version/tool_version in planestro.yml. */
export async function migrate(dataDir: string, log: (m: string) => void = () => {}): Promise<{ from: number; to: number; applied: number[] }> {
  const from = currentVersion(dataDir);
  if (from > SCHEMA_VERSION) throw new Error(`data dir is schema ${from}; this planestro knows ${SCHEMA_VERSION} — upgrade the tool`);
  const applied: number[] = [];
  for (const m of MIGRATIONS.filter((m) => m.version > from).sort((a, b) => a.version - b.version)) {
    log(`migrating ${m.version - 1} → ${m.version}: ${m.describe}`);
    await m.up(dataDir, log);
    stampVersion(dataDir, m.version);
    applied.push(m.version);
  }
  if (!applied.length) stampVersion(dataDir, from);
  return { from, to: SCHEMA_VERSION, applied };
}

export function stampVersion(dataDir: string, version: number): void {
  const path = join(dataDir, CONFIG_FILE);
  const doc = YAML.parseDocument(readFileSync(path, 'utf8'));
  doc.set('schema_version', version);
  if (doc.get('tool_version') !== TOOL_VERSION) doc.set('tool_version', TOOL_VERSION);
  atomicWrite(path, doc.toString({ lineWidth: 0 }));
}
