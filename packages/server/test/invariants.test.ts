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

/** The agent seam: the lifecycle asks `ports.agents[runner]` and never learns which CLIs exist. */
describe('agent seam: lifecycle code does not name a runner', () => {
  // Every engine file, so each part split out of LiveEngine (#404) stays covered. Only the runners' own code and the
  // few helpers that hold one runner's facts may name it; a new file joins this list only with its reason.
  const RUNNER_AWARE: Record<string, string> = {
    'sessions/': "the runners' ports and their session plumbing",
    'ports.ts': 'the port types name each runner',
    'makePorts.ts': 'builds a port per runner',
    'dryrun-ports.ts': "the dry-run runners' fakes",
    'secrets.ts': "where each runner's login lives, kept from workers",
    'transient.ts': "a runner's own words for a passing failure",
    'parks.ts': "a runner's approval request and what may be granted",
    'hostNote.ts': 'a note on what a sandboxed runner may write',
  };
  it('no engine file names a runner except the runners and the helpers listed with their reason', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'engine');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p.slice(dir.length + 1)); } };
    walk(dir);
    const checked = files.filter((f) => !Object.keys(RUNNER_AWARE).some((k) => k.endsWith('/') ? f.startsWith(k) : f === k));
    for (const f of ['LiveEngine.ts', 'orchestrator.ts', 'policy.ts']) expect(checked, f).toContain(f);
    const offenders = checked.filter((f) => /codex/i.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
