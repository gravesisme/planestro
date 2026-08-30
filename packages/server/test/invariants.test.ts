import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Invariant 8: no lifecycle code names a default branch. */
describe('invariant 8: no literal default branch in engine code', () => {
  it('engine/ never mentions develop/main/master as a branch', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'engine');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
    walk(dir);
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/(['"`/])(develop|main|master)\1/.test(line) || /origin\/(develop|main|master)\b/.test(line)) offenders.push(`${f.split('/src/')[1]}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
