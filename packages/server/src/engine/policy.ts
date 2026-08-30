import type { Config } from '@planestro/shared';
import type { PermissionRequest } from './ports.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Tools a worker may always use without prompting (planestro's own MCP tools are added separately). */
export const BASE_ALLOWED: Record<'plan' | 'implement' | 'fix', string[]> = {
  plan: [],
  implement: ['Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)'],
  fix: ['Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)', 'Bash(git rebase*)', 'Bash(git mergetool*)'],
};

export interface Policy { deny(req: PermissionRequest): string | null }

/**
 * Hard denials with an explanation. Everything else that reaches `canUseTool` is parked for
 * the user (invariant 2). Branch names come from config — never literals (invariant 8).
 */
export function makePolicy(config: Config, baseBranch: string, worktree: string): Policy {
  const protectedBranches = [baseBranch, config.code_repo.release_branch].filter((b): b is string => Boolean(b)).map(esc).join('|');
  const rules: { re: RegExp; why: string }[] = [
    { re: /^\s*git\s+push\b/, why: 'planestro pushes for you; commit on your worker branch and report_done.' },
    { re: /^\s*gh\s+pr\b/, why: 'planestro opens, updates and merges pull requests.' },
    { re: /^\s*gh\s+api\b.*\/(merge|pulls)\b/, why: 'planestro owns pull requests.' },
    { re: new RegExp(`^\\s*git\\s+(checkout|switch)\\s+(-\\S+\\s+)*(${protectedBranches})\\b`), why: 'protected branch; your writable scope is your worker branch.' },
    { re: new RegExp(`^\\s*git\\s+(merge|rebase|reset)\\b.*\\b(${protectedBranches})\\b(?!.*origin/)`), why: 'never alter a protected branch; planestro integrates.' },
    { re: /^\s*git\s+branch\s+(-D|-d|--delete|-m|-M)\b/, why: 'branch management belongs to planestro.' },
    { re: /^\s*git\s+worktree\b/, why: 'worktree management belongs to planestro.' },
    { re: /--force\b(?!-with-lease)/, why: 'force operations are not allowed for a worker.' },
    { re: /^\s*rm\s+-r[f]?\s+(\/|~)/, why: 'destructive path outside the worktree.' },
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
        for (const r of rules) if (r.re.test(seg)) return r.why;
        for (const d of userDeny) if (seg.trim().startsWith(d)) return `denied by planestro policy (${d}).`;
      }
      return null;
    },
  };
}

/**
 * Deterministic allow for chained Bash commands: the SDK's own allowlist matcher refuses a
 * `a && b <<'EOF' ...` chain even when every segment is allowed, which would park a plain
 * `git add && git commit -F -`. A command is allowed when every segment (heredoc bodies
 * stripped — they are stdin data, not commands) matches one allow rule.
 */
export function allowedByRules(req: PermissionRequest, rules: string[]): boolean {
  if (req.tool !== 'Bash') return rules.includes(req.tool);
  const firstLine = String(req.input.command ?? '').split('\n')[0];  // heredoc bodies follow the first line
  const segments = firstLine.split(/\s*(?:&&|\|\||;)\s*/).map((x) => x.replace(/<<-?\s*'?"?\w+'?"?\s*$/, '').trim()).filter(Boolean);
  if (!segments.length) return false;
  const prefixes = rules.filter((r) => r.startsWith('Bash(') && r.endsWith(')')).map((r) => r.slice(5, -1));
  return segments.every((seg) => prefixes.some((p) => p.endsWith(' *') ? (seg + ' ').startsWith(p.slice(0, -1)) : p.endsWith('*') ? seg.startsWith(p.slice(0, -1)) : seg === p));
}

/** Permission rule that would pre-approve exactly this request on resume. */
export function ruleFor(req: PermissionRequest): string {
  if (req.tool === 'Bash') return `Bash(${String(req.input.command ?? '')})`;
  return req.tool;
}
