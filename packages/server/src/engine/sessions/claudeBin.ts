import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

/** The Claude Code version the Agent SDK bundles and runs when no executable is named. */
export function bundledClaudeVersion(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).claudeCodeVersion;
  } catch { return undefined; }
}

/** `a` is newer than `b`, comparing dotted numbers (2.1.281 > 2.1.251). */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d > 0; }
  return false;
}

export interface ClaudeBinChoice { bin?: string; version?: string; why: string }
type Probe = () => { path: string; version: string } | undefined;

/** `claude` on PATH, with its version. */
const probePath: Probe = () => {
  try {
    const path = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
    const version = execFileSync(path, ['--version'], { encoding: 'utf8' }).trim().split(' ')[0];
    return path && version ? { path, version } : undefined;
  } catch { return undefined; }
};

/**
 * Which Claude Code the sessions run. A `claude_bin` in planestro.local.yml wins (`bundled` forces the
 * SDK's own). Otherwise the installed `claude` is used when it is newer than the one the SDK bundles:
 * a new model needs a new CLI, and the bundled 2.1.251 refused one with "API Error: 400 … version
 * 2.1.280 or newer is required" while 2.1.280 sat on PATH (dogfood p4).
 */
export function resolveClaudeBin(configured: string | undefined, bundled = bundledClaudeVersion(), probe: Probe = probePath): ClaudeBinChoice {
  if (configured === 'bundled') return { version: bundled, why: `the SDK's bundled Claude Code ${bundled ?? '(unknown version)'} (claude_bin: bundled)` };
  if (configured) return { bin: configured, why: `${configured} (claude_bin)` };
  const installed = probe();
  if (installed && bundled && newerVersion(installed.version, bundled)) return { bin: installed.path, version: installed.version, why: `the installed Claude Code ${installed.version} at ${installed.path}, newer than the SDK's bundled ${bundled}` };
  return { version: bundled, why: `the SDK's bundled Claude Code ${bundled ?? '(unknown version)'}${installed ? ` (the installed ${installed.version} is not newer)` : ''}` };
}
