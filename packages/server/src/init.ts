import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SCHEMA_VERSION } from '@planestro/shared';
import { CONFIG_FILE, TOOL_VERSION, registerProject } from './config.ts';
import { isoLocal } from '@planestro/shared';
import { assertSafePlanningGit, ensurePlanningIgnores, safePlanningPaths, planningStagePaths } from './store/planningGitSafety.ts';

export interface InitOptions {
  dataDir: string;
  codeRepo: string;            // absolute or relative to cwd
  name?: string;
  prefix?: string;
  defaultBranch?: string;
  releaseBranch?: string;
  github?: string;
  layout?: 'dir' | 'orphan-branch';
  gdignore?: boolean;          // default: auto-detect project.godot in the code repo (keeps the Godot editor out of the data dir)
  categories?: string[];       // default: DEFAULT_CATEGORIES; the last one is where uncategorized items land
  register?: boolean;          // remember it in ~/.planestro so a bare `planestro serve` finds it (default true)
  commit?: boolean;            // git commit the seed (default true when the data dir is a git checkout)
  log?: (m: string) => void;
}

export const DEFAULT_CATEGORIES = ['Feature', 'Bug', 'Chore', 'Docs', 'Not Yet Categorized'];

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
  assertSafePlanningGit(dataDir);
  if (ensurePlanningIgnores(dataDir)) created.push('.gitignore');
  for (const d of ['items', 'prompts', 'attachments', 'journal']) mkdirSync(join(dataDir, d), { recursive: true });

  const name = o.name ?? basename(codeRepo);
  const prefix = (o.prefix ?? (name.replace(/[^A-Za-z]/g, '').slice(0, 2) || 'PL')).toUpperCase();
  const defaultBranch = o.defaultBranch ?? detectDefaultBranch(codeRepo);
  const github = o.github ?? detectGithub(codeRepo);
  const relRepo = relative(dataDir, codeRepo) || '.';
  const categories = o.categories?.length ? o.categories : DEFAULT_CATEGORIES;
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
  # Model ids age: when a newer Claude model ships, change claude_model here or in Settings → Models.
  # Opus 5.5 plans and implements everything by default. Fable 5.1 is for the hardest plans (an epic's
  # breakdown, a cross-system mechanic): pick it as the planner on those items.
  # fallback: while a model is out of usage, items that allow it (and the orchestrator, if allowed) run on this one instead.
  - { id: opus-5-5, label: Opus 5.5, claude_model: claude-opus-5-5 }
  - { id: codex-gpt-6-astra, label: Codex GPT-6 Astra, runner: codex, codex_model: gpt-6-astra, codex_transport: app-server, engine_commits: true }
  - { id: fable-5-1, label: Fable 5.1, claude_model: claude-fable-5-1, fallback: opus-5-5 }
  # A model on the Codex CLI implements but never plans. Its description is what the epic planner routes by;
  # hold_for_review parks its pull requests for your eye before they merge.
  # - { id: codex-art, label: Codex Art, runner: codex, hold_for_review: true, description: "All raster art: icons, sprites, illustrations. The Claude models cannot generate images." }
defaults:
  planner: opus-5-5
  implementer: opus-5-5
  category: ${yamlStr(categories.at(-1)!)}
categories:
${categories.map((c) => `  - ${yamlStr(c)}`).join('\n')}
concurrency:
  max_sessions: 3
  max_local_jobs: 1
permissions:
  allow: []
  deny: []
ci:
  mode: github
  require_green_base: true
  start_timeout_min: 10
  timeout_min: 45
orchestrator:
  model: opus-5-5
  may_approve_plans: false
  max_plan_revisions: 2
  may_decide_permissions: false
  # A fresh conversation costs less per wake than a long one, and the files are its memory: rotate often.
  rotate_after_wakes: 10
  rotate_after_days: 3
engine:
  mode: dry-run
# Pause automation before a Claude subscription usage window runs out; resume after it resets.
usage_guard:
  enabled: true
  threshold: 0.85
  on_warning: true
  auto_resume: false
# Commands to run on events, e.g. on_merge: say "PR merged", on_usage_pause: say "paused for usage".
# on_needs_you runs once per wait on you, with PLANESTRO_URL; docs/configuration.md has a phone alert through ntfy.
notifications: {}
git:
  auto_commit: true
  auto_push: true
  checkpoint_interval_min: 60
attachments:
  managed_max_bytes: 2000000
# The sections every release file has. max_chars counts toward a store's limit; carry starts a
# new release with the previous one's text (store copy that rarely changes).
releases:
  sections:
    - { title: Release notes, hint: "What users are told changed." }
    - { title: Notes, hint: "Yours: the checklist, what went wrong, what to do differently." }
`);
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
  if (o.register !== false) registerProject({ name, data_dir: dataDir, last_used: isoLocal() });
  if ((o.commit ?? true) && existsSync(join(dataDir, '.git')) && created.length) {
    assertSafePlanningGit(dataDir);
    execFileSync('git', ['-C', dataDir, 'add', '-A', '--', ...planningStagePaths(dataDir, safePlanningPaths(dataDir))]);
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
- \`releases/<version>.md\` — one release: status, date, the items it shipped, and the sections
  \`releases.sections\` in planestro.yml names (release notes, store copy, your notes).
- \`attachments/${prefix}-<n>/\` — small managed attachments; large assets are referenced by path.
- \`journal/YYYY-MM.ndjson\` — the operational event stream (high frequency; not the place to read history).

Editing by hand: fine while planestro is not running (it commits your edits as \`manual: …\`
at startup). While it runs, planestro is the only writer — use the UI, or "Reload from disk".
Status values: NOT_YET_SUBMITTED, QUEUED, PLAN_IN_PROGRESS, PLAN_READY, IN_PROGRESS,
IN_REVIEW, MERGED, FINISHED, ICEBOX. \`blocked\`/\`awaiting\` are orthogonal flags.
`;
}
