import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Config, LocalConfig, AWAITING, blockHelp, SETTINGS, NOT_USER_FACING } from '@planestro/shared';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const doc = (name: string) => readFileSync(join(ROOT, 'docs', name), 'utf8');

/** Dotted leaf keys of a zod object, through defaults, optionals and arrays. */
function keysOf(schema: any, prefix = '', out: string[] = []): string[] {
  let cur = schema;
  for (let i = 0; i < 6 && cur && !cur.shape; i++) cur = cur.def?.innerType ?? cur.unwrap?.();
  if (cur?.shape) for (const [k, v] of Object.entries(cur.shape)) keysOf(v, prefix ? `${prefix}.${k}` : k, out);
  else out.push(prefix);
  return out;
}

describe('the manual cannot drift from the code', () => {
  it('every configuration key in the schema is documented', () => {
    const page = doc('configuration.md');
    const missing = [...keysOf(Config), ...keysOf(LocalConfig)].filter((k) => !page.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });

  it('every configuration key is on the Settings page, or deliberately left off it', () => {
    // A registry row covers its own key and everything under it (the model editor covers models.*).
    for (const [file, schema] of [['config', Config], ['local', LocalConfig]] as const) {
      const rows = SETTINGS.filter((s) => s.file === file);
      const covered = (k: string) => rows.some((s) => s.key === k || k.startsWith(`${s.key}.`) || s.covers?.includes(k)) || NOT_USER_FACING[file].some((n) => n === k || k.startsWith(`${n}.`));
      const keys = keysOf(schema);
      expect(keys.filter((k) => !covered(k)), `${file}: keys with no Settings row`).toEqual([]);
      // …and no row names a key the schema no longer has.
      expect(rows.filter((s) => !keys.some((k) => k === s.key || k.startsWith(`${s.key}.`))).map((s) => s.key), `${file}: rows for keys that are gone`).toEqual([]);
    }
  });

  it('every blocked_reason the engine can raise, and every awaiting value, is explained', () => {
    const engineDir = join(ROOT, 'packages', 'server', 'src', 'engine');
    const src = readdirSync(engineDir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(engineDir, f), 'utf8')).join('\n');
    const reasons = new Set<string>(['turn_error']);
    for (const m of src.matchAll(/\bblock\([^,()]+, '([a-z_]+)'/g)) reasons.add(m[1]);
    for (const m of (src.match(/ACTIONABLE_FAILURES = new Set\(\[([^\]]+)\]/)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)) reasons.add(m[1]);
    expect(reasons.size).toBeGreaterThan(20);
    const page = doc('troubleshooting.md');
    expect([...reasons].filter((r) => !page.includes(`\`${r}\``))).toEqual([]);
    expect([...reasons].filter((r) => !blockHelp(r))).toEqual([]); // the item page explains a block from the same list
    const concepts = doc('concepts.md');
    expect(AWAITING.filter((a) => a !== 'orchestrator' && !concepts.includes(`\`${a}\``))).toEqual([]);
  });

  it('AGENTS.md is CLAUDE.md, byte for byte: Codex and Claude read the same rules', () => {
    expect(readFileSync(join(ROOT, 'AGENTS.md')).equals(readFileSync(join(ROOT, 'CLAUDE.md')))).toBe(true);
  });

  it('links the provider guide from the README and switch screen', () => {
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain('docs/switching-providers.md');
    const screen = readFileSync(join(ROOT, 'packages/web/src/pages/SwitchProvider.tsx'), 'utf8');
    expect(screen).toContain('docs/switching-providers.md');
    expect(screen).toContain('href={PROVIDER_GUIDE}');
    expect(doc('switching-providers.md')).toContain('Codex-only');
  });

  it('every relative link in the manual and the README points at a file that exists', () => {
    const files = [join(ROOT, 'README.md'), ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join(ROOT, 'docs', f)), ...readdirSync(join(ROOT, 'docs', 'notes')).map((f) => join(ROOT, 'docs', 'notes', f))];
    const broken: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1].split('#')[0];
        if (!target || /^(https?:|mailto:)/.test(target)) continue;
        const abs = resolve(dirname(file), target);
        if (!existsSync(abs)) broken.push(`${file.replace(ROOT + '/', '')} → ${m[1]}`);
        else if (statSync(abs).isDirectory() && !target.endsWith('/')) broken.push(`${file.replace(ROOT + '/', '')} → ${m[1]} (a directory: end it with /)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
