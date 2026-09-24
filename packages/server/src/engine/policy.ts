import { resolve } from 'node:path';
import type { Config } from '@planestro/shared';
import type { PermissionRequest } from './ports.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Tools a worker may always use without prompting (planestro's own MCP tools are added separately). */
const READONLY_HELPERS = ['Bash(git --no-pager log *)', 'Bash(git --no-pager show *)', 'Bash(git --no-pager diff *)', 'Bash(git --no-pager status*)', 'Bash(tail *)', 'Bash(head *)', 'Bash(wc *)'];

export const BASE_ALLOWED: Record<'plan' | 'implement' | 'fix', string[]> = {
  plan: [...READONLY_HELPERS],
 implement: [...READONLY_HELPERS, 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)'],
  fix: [...READONLY_HELPERS, 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)', 'Bash(git rebase*)', 'Bash(git mergetool*)'],
};

export interface Policy { deny(req: PermissionRequest): string | null }

/**
 * Environment names that change what a command does or which binary runs: a segment that
 * sets one is never auto-allowed (it parks for a decision), whatever command follows.
 */
const DANGEROUS_ENV = /^(PATH|IFS|ENV|BASH_ENV|SHELL|SHELLOPTS|PS4|PROMPT_COMMAND|HOME|NODE_OPTIONS|NODE_PATH|PERL5OPT|PERL5LIB|PYTHONPATH|PYTHONSTARTUP|RUBYOPT|RUBYLIB|LD_\w*|DYLD_\w*|GIT_\w*)$/;
/** A plain assignment: NAME=value where the value is one word with no expansion, quotes or redirection. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^\s'"`$<>|;&(){}\\]*)\s+/;
/**
 * Wrappers that only bound or schedule the command they run, so the command after them is what
 * a rule should judge: `timeout 120 godot …` is a godot run. Options are the common harmless ones;
 * anything else leaves the wrapper in place, where it matches no rule and parks.
 */
const WRAPPERS: RegExp[] = [
  /^(?:g?timeout)\s+(?:(?:-k\s+\S+|-s\s+\S+|--preserve-status|--foreground|-v)\s+)*\d+(?:\.\d+)?[smhd]?\s+/,
  /^nice(?:\s+-n\s+-?\d+|\s+-\d+)?\s+/,
  /^nohup\s+/,
  /^time(?:\s+-p)?\s+/,
  /^env\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/,
];

/**
 * One shell segment reduced to the command it runs, for rule matching: leading `NAME=value`
 * assignments and harmless wrappers (`timeout N`, `nice`, `nohup`, `time`, `env`) are peeled
 * off, in any order and any number. `unsafe` is set when an assignment names an environment
 * variable that changes what runs (PATH, LD_*, GIT_*, NODE_OPTIONS, …): such a segment is never
 * auto-allowed. Both the deny rules and the allow matcher use this, so a prefix can neither hide
 * a denied command (`GIT_TRACE=1 git push`) nor keep an allowed one from matching
 * (`CHECK_JOBS=4 ./tools/run_checks.sh`).
 */
export function normalizeSegment(segment: string): { command: string; unsafe: boolean } {
  let rest = segment.trim();
  let unsafe = false;
  for (let guard = 0; guard < 32; guard++) {
    const a = ASSIGNMENT.exec(rest);
    if (a) {
      if (DANGEROUS_ENV.test(a[1])) unsafe = true;
      rest = rest.slice(a[0].length);
      continue;
    }
    const w = WRAPPERS.map((re) => re.exec(rest)).find((m) => m);
    if (w) { rest = rest.slice(w[0].length); continue; }
    break;
  }
  return { command: rest.trim(), unsafe };
}

/** Whether a literal path (quoted or bare, never expanded) names the worktree or a directory inside it. */
function insideWorktree(raw: string, worktree: string): boolean {
  const p = raw.replace(/^'([^']*)'$|^"([^"$`\\]*)"$/, '$1$2');
  if (!p || /[\s'"`$~\\*?]/.test(p)) return false;
  const abs = resolve(worktree, p);
  return abs === worktree || abs.startsWith(worktree + '/');
}

const GIT_C = /^git\s+-C\s+('[^']*'|"[^"]*"|\S+)\s+/;
const CD = /^cd\s+('[^']*'|"[^"]*"|\S+)$/;

/**
 * `git -C <worktree> status` is `git status`: a worker anchoring git to its own worktree runs
 * exactly what the rules already judge, so the anchor is peeled off. `-C` naming any other
 * directory is left in place, where it matches no rule and parks.
 */
export function unanchor(segment: string, worktree: string): string {
  const m = GIT_C.exec(segment);
  return m && insideWorktree(m[1], worktree) ? `git ${segment.slice(m[0].length)}` : segment;
}

/**
 * Hard denials with an explanation. Everything else that reaches `canUseTool` is parked for
 * the user (invariant 2). Branch names come from config — never literals (invariant 8).
 */
export function makePolicy(config: Config, baseBranch: string, worktree: string): Policy {
  const protectedBranches = [baseBranch, config.code_repo.release_branch].filter((b): b is string => Boolean(b)).map(esc).join('|');
  const rules: { re: RegExp; why: string }[] = [
    { re: /^\s*git\b[^|;&]*?\bpush\b/, why: 'planestro pushes for you; commit on your worker branch and report_done.' },
    { re: /^\s*gh\s+pr\b/, why: 'planestro opens, updates and merges pull requests.' },
    { re: /^\s*gh\s+api\b.*\/(merge|pulls)\b/, why: 'planestro owns pull requests.' },
    { re: new RegExp(`^\\s*git\\b[^|;&]*?\\b(checkout|switch)\\b[^|;&]*?\\b(${protectedBranches})\\b`), why: 'protected branch; your writable scope is your worker branch.' },
    { re: new RegExp(`^\\s*git\\b[^|;&]*?\\b(merge|rebase|reset)\\b.*\\b(${protectedBranches})\\b(?!.*origin/)`), why: 'never alter a protected branch; planestro integrates.' },
    { re: /^\s*git\b[^|;&]*?\bbranch\s+(-D|-d|--delete|-m|-M)\b/, why: 'branch management belongs to planestro.' },
    { re: /^\s*git\b[^|;&]*?\bworktree\b/, why: 'worktree management belongs to planestro.' },
    { re: /--force\b(?!-with-lease)/, why: 'force operations are not allowed for a worker.' },
    { re: /^\s*rm\s+-r[f]?\s+(\/|~)/, why: 'destructive path outside the worktree.' },
    // In-place shell edits always needed a human; the Edit/Write tools never do.
    { re: /^\s*sed\b[^|;&]*?\s(-[nErsuz]*i|--in-place)/, why: 'edit files with the Edit or Write tool, not through the shell.' },
    { re: /^\s*perl\b[^|;&]*?\s-[pln0-9]*i/, why: 'edit files with the Edit or Write tool, not through the shell.' },
  ];
  const userDeny = config.permissions.deny.map((d) => d.trim()).filter(Boolean);
  return {
    deny(req) {
      if (req.tool !== 'Bash') {
        const path = String(req.input.file_path ?? req.input.path ?? '');
        if ((req.tool === 'Write' || req.tool === 'Edit' || req.tool === 'MultiEdit') && path.startsWith('/') && !path.startsWith(worktree + '/')) return `writes outside your worktree (${worktree}) are not allowed.`;
        return null;
      }
      const cmd = String(req.input.command ?? '');
      for (const seg of cmd.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
        // A prefix must not hide a denied command: judge the segment and what it actually runs.
        // The worktree anchor is peeled first, so its path cannot trip a rule (a directory named `worktree`).
        const own = unanchor(seg.trim(), worktree);
        for (const form of new Set([own, unanchor(normalizeSegment(own).command, worktree)])) {
          for (const r of rules) if (r.re.test(form)) return r.why;
          for (const d of userDeny) if (form.trim().startsWith(d)) return `denied by planestro policy (${d}).`;
        }
      }
      return null;
    },
  };
}

/**
 * Deterministic allow for chained Bash commands: the SDK's own allowlist matcher refuses a
 * `a && b <<'EOF' ...` chain even when every segment is allowed, which would park a plain
 * `git add && git commit -F -`. A command is allowed when every segment (heredoc bodies
 * stripped — they are stdin data, not commands) matches one allow rule. Given the worktree,
 * `cd` into it is a no-op and `git -C` anchored to it is judged as plain `git`.
 */
export function allowedByRules(req: PermissionRequest, rules: string[], worktree?: string): boolean {
  if (req.tool !== 'Bash') return rules.includes(req.tool);
  const firstLine = String(req.input.command ?? '').split('\n')[0];  // heredoc bodies follow the first line
  const segments = firstLine.split(/\s*(?:&&|\|\||;|\|)\s*/).map((x) => x.replace(/<<-?\s*'?"?\w+'?"?\s*$/, '').trim()).filter(Boolean);
  if (!segments.length) return false;
  const prefixes = rules.filter((r) => r.startsWith('Bash(') && r.endsWith(')')).map((r) => r.slice(5, -1));
  const matches = (seg: string) => prefixes.some((p) => p.endsWith(' *') ? (seg + ' ').startsWith(p.slice(0, -1)) : p.endsWith('*') ? seg.startsWith(p.slice(0, -1)) : seg === p);
  return segments.every((raw) => {
    if (worktree) {
      const cd = CD.exec(raw);
      if (cd) return insideWorktree(cd[1], worktree);
    }
    const seg = worktree ? unanchor(raw, worktree) : raw;
    // A rule written with the prefix still matches as written; otherwise judge what the segment runs.
    if (matches(seg)) return true;
    const { command: peeled, unsafe } = normalizeSegment(seg);
    const command = worktree ? unanchor(peeled, worktree) : peeled;
    return !unsafe && command !== seg && command.length > 0 && matches(command);
  });
}

/** Permission rule that would pre-approve exactly this request on resume. */
export function ruleFor(req: PermissionRequest): string {
  if (req.tool === 'Bash') return `Bash(${String(req.input.command ?? '')})`;
  return req.tool;
}
