import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCHEMA_VERSION } from '@planestro/shared';
import { CONFIG_FILE, TOOL_VERSION, registerProject } from './config.ts';
import { isoLocal } from '@planestro/shared';

export interface InitOptions {
  dataDir: string;
  codeRepo: string;            // absolute or relative to cwd
  name?: string;
  prefix?: string;
  defaultBranch?: string;
  releaseBranch?: string;
  github?: string;
  layout?: 'dir' | 'orphan-branch';
  gdignore?: boolean;          // default: auto-detect project.godot in the code repo
  commit?: boolean;            // git commit the seed (default true when the data dir is a git checkout)
  log?: (m: string) => void;
}

const SHIPPED_PROMPTS = new URL('../prompts/', import.meta.url);

/** Seed a data dir. Idempotent: existing files are never overwritten. */
export function initDataDir(o: InitOptions): { created: string[] } {
  const log = o.log ?? (() => {});
  const dataDir = resolve(o.dataDir);
  const codeRepo = resolve(o.codeRepo);
  if (!existsSync(join(codeRepo, '.git'))) throw new Error(`code repo is not a git checkout: ${codeRepo}`);
  const created: string[] = [];
  const write = (rel: string, content: string) => {
    const p = join(dataDir, rel);
    if (existsSync(p)) return;
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
    created.push(rel);
  };
  mkdirSync(dataDir, { recursive: true });
  for (const d of ['items', 'prompts', 'attachments', 'journal']) mkdirSync(join(dataDir, d), { recursive: true });

  const name = o.name ?? basename(codeRepo);
  const prefix = (o.prefix ?? (name.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'PL')).toUpperCase();
  const defaultBranch = o.defaultBranch ?? detectDefaultBranch(codeRepo);
  const github = o.github ?? detectGithub(codeRepo);
  const relRepo = relative(dataDir, codeRepo) || '.';
  const gd = o.gdignore ?? existsSync(join(codeRepo, 'project.godot'));

  write(CONFIG_FILE, `# planestro project config — versioned. Machine-specific paths go in planestro.local.yml.
schema_version: ${SCHEMA_VERSION}
tool_version: ${TOOL_VERSION}
project:
  name: ${yamlStr(name)}
  id_prefix: ${prefix}
code_repo:
  path: ${yamlStr(relRepo)}
  # Every branch planestro creates targets this branch. During a trial this can be an
  # integration branch (e.g. feature/planestro); flip it to the real default branch later.
  default_branch: ${yamlStr(defaultBranch)}
${o.releaseBranch ? `  release_branch: ${yamlStr(o.releaseBranch)}\n` : ''}${github ? `  github: ${yamlStr(github)}\n` : ''}worktrees:
  root: .claude/worktrees
  branch_pattern: "{{prefix_lower}}/{{number}}-{{slug}}"
  dir_pattern: "{{prefix_lower}}-{{number}}-{{slug}}"
hooks:
  after_worktree_create: []
models:
  - { id: fable-5, label: Fable 5, claude_model: claude-fable-5 }
  - { id: opus-5, label: Opus 5, claude_model: claude-opus-5 }
defaults:
  planner: fable-5
  implementer: opus-5
  category: Not Yet Categorized
categories:
  - Game
  - Marketing Site
  - Chores
  - Tools
  - Not Yet Categorized
concurrency:
  max_sessions: 3
  max_godot_jobs: 1
permissions:
  allow: []
  deny: []
ci:
  mode: github
  require_green_base: true
  start_timeout_min: 10
  timeout_min: 45
orchestrator:
  model: claude-fable-5
  may_approve_plans: false
  rotate_after_wakes: 40
  rotate_after_days: 3
engine:
  mode: dry-run
notifications: {}
git:
  auto_commit: true
  auto_push: true
  checkpoint_interval_min: 60
attachments:
  managed_max_bytes: 2000000
`);
  write('.gitignore', `.planestro/\nplanestro.local.yml\nlogs/\n.DS_Store\n`);
  if (gd) write('.gdignore', '');
  write('counter', '1\n');
  write('README.md', readme(name, prefix));
  for (const f of readdirSync(SHIPPED_PROMPTS).filter((f) => f.endsWith('.md'))) {
    const dest = join(dataDir, 'prompts', f);
    if (!existsSync(dest)) { copyFileSync(new URL(f, SHIPPED_PROMPTS), dest); created.push(`prompts/${f}`); }
  }
  if (o.layout === 'orphan-branch' || dataDir.startsWith(codeRepo + '/')) {
    const exclude = join(codeRepo, '.git', 'info', 'exclude');
    const rel = relative(codeRepo, dataDir) + '/';
    if (!existsSync(exclude) || !readFileSync(exclude, 'utf8').split('\n').includes(rel)) { appendFileSync(exclude, `${rel}\n`); log(`added ${rel} to ${exclude}`); }
  }
  registerProject({ name, data_dir: dataDir, last_used: isoLocal() });
  if ((o.commit ?? true) && existsSync(join(dataDir, '.git')) && created.length) {
    execFileSync('git', ['-C', dataDir, 'add', '-A']);
    execFileSync('git', ['-C', dataDir, 'commit', '-q', '-m', `planestro: init schema ${SCHEMA_VERSION}`, '-m', `Planestro-Version: ${TOOL_VERSION}`]);
    log('committed seed files');
  }
  return { created };
}

function detectDefaultBranch(repo: string): string {
  try { return execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^origin\//, ''); } catch { return 'main'; }
}
function detectGithub(repo: string): string | undefined {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return m?.[1];
  } catch { return undefined; }
}
function yamlStr(s: string): string { return /^[A-Za-z0-9_./-]+$/.test(s) ? s : JSON.stringify(s); }

function readme(name: string, prefix: string): string {
  return `# ${name} — planning data

This directory is a [planestro](https://github.com/gravesisme/planestro) data dir. Every file
is plain text and readable without the tool; git history is the audit trail.

- \`planestro.yml\` — project config (versioned). \`planestro.local.yml\` — machine paths (ignored).
- \`items/${prefix}-<n>.md\` — one backlog item per file: YAML frontmatter + the sections
  \`# Description\`, \`# Notes\`, \`# Plan\`, \`# Activity\` (append-only log). Missing keys mean
  "unset"; \`null\` is never written. Timestamps are local time with offset.
- \`prompts/<name>.md\` — the reusable prompt library (\`kind: template | action | partial\`,
  \`{{placeholders}}\`, \`{{> partial}}\`).
- \`attachments/${prefix}-<n>/\` — small managed attachments; large assets are referenced by path.
- \`journal/YYYY-MM.ndjson\` — the operational event stream (high frequency; not the place to read history).

Editing by hand: fine while planestro is not running (it commits your edits as \`manual: …\`
at startup). While it runs, planestro is the only writer — use the UI, or "Reload from disk".
Status values: NOT_YET_SUBMITTED, QUEUED, PLAN_IN_PROGRESS, PLAN_READY, IN_PROGRESS,
IN_REVIEW, MERGED, FINISHED, ICEBOX. \`blocked\`/\`awaiting\` are orthogonal flags.
`;
}
