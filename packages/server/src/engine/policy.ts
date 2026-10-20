import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { WORKTREE_SCOPE, trimEndBlanks, type Config, type PermissionRedirect } from '@planestro/shared';
import type { PermissionRequest } from './ports.ts';
import { literal, readShell, type Command, type Item, type Word } from './shell.ts';
import { secretDenial, type SecretOptions } from './secrets.ts';
import { gitDenial } from './gitDenials.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Tools a worker may always use without prompting (planestro's own MCP tools are added separately). */
const READONLY_HELPERS = ['Bash(git --no-pager log *)', 'Bash(git --no-pager show *)', 'Bash(git --no-pager diff *)', 'Bash(git --no-pager status*)', 'Bash(tail *)', 'Bash(head *)', 'Bash(wc *)'];

/** A rule that holds only inside the item's worktree (#96): `Bash(npm run *)@worktree`. */
const SCOPE = WORKTREE_SCOPE;
const scoped = (patterns: string[]): string[] => patterns.map((p) => `Bash(${p} *)${SCOPE}`);
/**
 * What every project's workers run between the commands that matter, allowed while the command
 * stays in the worktree: reading, comparing, printing. LM-24 parked five times on `echo "exit $?"`.
 * `find` is not here (`-delete`, `-exec`) nor `sed` (its `w` and `e` commands), nor anything that
 * runs what it is given; the few flags of these that do are refused (`RUNS_ANOTHER`).
 */
const SCOPED_READERS = scoped(['echo', 'printf', 'pwd', 'true', 'false', ':', 'test', '[', 'diff', 'ls', 'cat', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'wc', 'head', 'tail', 'basename', 'dirname', 'date', 'sleep', 'command -v', 'which', 'file', 'stat', 'du', 'git grep', 'git rev-parse', 'git branch --show-current']);
const SCOPED_WRITERS = scoped(['mkdir -p']);

export const BASE_ALLOWED: Record<'plan' | 'implement' | 'fix', string[]> = {
  plan: [...READONLY_HELPERS, ...SCOPED_READERS],
  implement: [...READONLY_HELPERS, ...SCOPED_READERS, ...SCOPED_WRITERS, 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)'],
  fix: [...READONLY_HELPERS, ...SCOPED_READERS, ...SCOPED_WRITERS, 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)', 'Bash(git add *)', 'Bash(git commit *)', 'Bash(git stash*)', 'Bash(git fetch*)', 'Bash(git restore *)', 'Bash(git rebase*)', 'Bash(git mergetool*)'],
};

/** Deny rules as the command prefixes they refuse: written as a rule (`Bash(rm -rf *)`, as Settings shows it) or as a bare prefix (`rm -rf`) (#109). */
export function denyPrefixes(deny: string[]): string[] {
  return deny.map((d) => d.trim()).filter(Boolean).map((d) => { const m = /^Bash\((.*)\)$/.exec(d); return m ? m[1].replace(/\s*\*$/, '').trim() : d; }).filter(Boolean);
}

/** The refusals a policy judges beyond its own (#229, #203): every layer's denials, and redirects (a deny with its own message). */
export interface PolicyRules { deny: string[]; redirect?: PermissionRedirect[] }
const asRules = (r: string[] | PolicyRules): PolicyRules => (Array.isArray(r) ? { deny: r } : r);
/** Every rule that refuses, as written: a redirect is a kind of deny. */
const refusing = (r: PolicyRules): string[] => [...r.deny, ...(r.redirect ?? []).map((x) => x.rule)];

/**
 * The rules the SDK's own allow-list can read: a scoped rule is planestro's to judge, never the SDK's.
 * Nor is a Bash rule a deny touches (#229): the SDK approves what its list matches without asking
 * planestro, so a project's `Bash(npm *)` would let a machine policy's `npm publish` through. Such a
 * rule still allows, through canUseTool, where the denials are judged first. A redirect (#203) counts as a deny.
 */
export function sdkRules(rules: string[], deny: string[] | PolicyRules = []): string[] {
  const denied = denyPrefixes(refusing(asRules(deny)));
  return rules.map((r) => r.trim()).filter((r) => {
    if (r.endsWith(SCOPE)) return false;
    const m = /^Bash\((.*)\)$/.exec(r);
    if (!m) return true;
    const allow = m[1].replace(/\s*\*$/, '').trim();
    return !denied.some((d) => allow.startsWith(d) || d.startsWith(allow));
  });
}

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

const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(root + '/');

/** Whether a literal path (quoted or bare, never expanded) names the worktree or a directory inside it, seen from `from`. */
function insideWorktree(raw: string, worktree: string, from: string = worktree): boolean {
  const p = raw.replace(/^'([^']*)'$|^"([^"$`\\]*)"$/, '$1$2');
  if (!p || /[\s'"`$~\\*?]/.test(p)) return false;
  return within(resolve(from, p), worktree);
}

const GIT_C = /^git\s+-C\s+('[^']*'|"[^"]*"|\S+)\s+/;
const SEPARATORS = /&&|\|\||;|\|/; // its parts are trimmed: `\s*` on either side backtracked on a long run of spaces
const HEREDOC = /<<-?\s*'?"?\w+'?"?\s*$/;

/**
 * `git -C <worktree> status` is `git status`: a worker anchoring git to its own worktree runs
 * exactly what the rules already judge, so the anchor is peeled off. `-C` naming any other
 * directory is left in place, where it matches no rule and parks.
 */
export function unanchor(segment: string, worktree: string): string {
  const m = GIT_C.exec(segment);
  return m && insideWorktree(m[1], worktree) ? `git ${segment.slice(m[0].length)}` : segment;
}

/** A word that begins with a tilde the shell would expand. */
const tilde = (word: Word): boolean => { const first = word.parts[0]; return first?.kind === 'lit' && !first.quoted && first.text.startsWith('~'); };
const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

interface Stand {
  /** Every directory the command may run in; null once a `cd` could not be followed. */
  dirs: string[] | null;
  /** Inside `do … done`: what it does, it may do any number of times. */
  inLoop: boolean;
}
type Located = (Stand & { command: Command; enter(to: string | null): void }) | (Stand & { loop: Extract<Item, { kind: 'for' }> });

/**
 * The items of a command with where each one runs. A `cd` is certain only for the commands chained
 * to it with `&&`: past that it may have failed, so both directories stand (`cd nosuchdir; cat ../x`
 * reads beside the worktree). One in a subshell or a `$(…)` ends with it; one in `{ …; }` does not.
 */
function* located(items: Item[], worktree: string): Generator<Located> {
  const outer: { dirs: string[] | null; before: string[] | null }[] = [];
  let dirs: string[] | null = [worktree];
  /** Where the shell stands if the `cd`s of the chain in progress did not happen. */
  let before: string[] | null = null;
  let loops = 0;
  for (const it of items) {
    if (it.kind === 'open') { if (it.group === 'sub') outer.push({ dirs, before }); else if (it.group === 'loop') loops++; continue; }
    if (it.kind === 'close') { if (it.group === 'sub') ({ dirs, before } = outer.pop() ?? { dirs: [worktree], before: null }); else if (it.group === 'loop') loops--; continue; }
    if (it.kind === 'for') { yield { loop: it, dirs, inLoop: loops > 0 }; continue; }
    if (before && it.joined !== '&&') { dirs = dirs && union(before, dirs); before = null; }
    yield {
      command: it, dirs, inLoop: loops > 0,
      enter: (to) => {
        if (to === null || !dirs) { dirs = null; before = null; return; }
        before = union(before ?? [], dirs);
        dirs = [...new Set(dirs.map((d) => resolve(d, to)))];
      },
    };
  }
}

/**
 * A `cd` that can be seen to leave the worktree: a path outside it, `cd` alone, `cd ~`.
 * The worker's directory is pinned (#96): after LM-24's `cd ../../..` into the main checkout the
 * three commands that followed were denied, because nobody could say where the shell stood. This
 * is a refusal nobody is asked about, so it takes certainty: a `cd` that cannot be judged
 * (`cd "$DIR"`, `cd -`, one in a loop) is left to the rules, and so is every relative one after it.
 */
function leavesWorktree(command: string, worktree: string): boolean {
  const items = readShell(command);
  if (!items) {
    // Not read: only what the command opens with is certain to be a command at all.
    const m = /^(?:cd|pushd)\s+([\w./~-]+)$/.exec(command.split('\n')[0].split(SEPARATORS)[0].trim());
    return m !== null && !insideWorktree(m[1], worktree);
  }
  for (const at of located(items, worktree)) {
    if (!('command' in at)) continue;
    const { words } = at.command;
    const head = words.length ? literal(words[0]) : null;
    if (head !== 'cd' && head !== 'pushd') continue;
    if (words.length === 1) { if (head === 'cd') return true; at.enter(null); continue; }
    const written = words.length === 2 ? literal(words[1]) : null;
    const home = written !== null && tilde(words[1]);
    if (written === null || written.startsWith('-') || (home && written !== '~' && !written.startsWith('~/'))) { at.enter(null); continue; }
    const to = home ? join(homedir(), written.slice(1)) : written;
    const from = isAbsolute(to) ? [worktree] : at.inLoop ? null : at.dirs;
    if (!from) { at.enter(null); continue; }
    if (from.every((d) => !within(resolve(d, to), worktree))) return true;
    at.enter(to);
  }
  return false;
}

/**
 * Hard denials with an explanation. Everything else that reaches `canUseTool` is parked for
 * the user (invariant 2). Branch names come from config — never literals (invariant 8).
 * The secret-file deny list (#227) is judged first, for every tool. `deny` is the merged
 * deny list and redirects (`DataStore.permissionRules`); it defaults to the project's alone.
 * A redirect (#203) refuses as a deny does, with its own message: what to do instead.
 */
export function makePolicy(config: Config, baseBranch: string, worktree: string, secrets: SecretOptions = {}, deny: string[] | PolicyRules = config.permissions): Policy {
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
  // Every layer's denials (#229: the machine policy, the project, this machine's local file), each as the prefix it refuses.
  const given = asRules(deny);
  const userDeny = denyPrefixes(given.deny);
  const redirects = (given.redirect ?? []).flatMap((r) => denyPrefixes([r.rule]).map((prefix) => ({ prefix, message: r.message })));
  return {
    deny(req) {
      const secret = secretDenial(req, worktree, secrets);
      if (secret) return secret;
      if (req.tool !== 'Bash') {
        const path = String(req.input.file_path ?? req.input.path ?? '');
        if ((req.tool === 'Write' || req.tool === 'Edit' || req.tool === 'MultiEdit') && path && !resolve(worktree, path).startsWith(worktree + '/')) return `writes outside your worktree (${worktree}) are not allowed.`;
        return null;
      }
      const cmd = String(req.input.command ?? '');
      const git = gitDenial(cmd);
      if (git) return git;
      if (leavesWorktree(cmd, worktree)) return `your working directory is pinned to your worktree (${worktree}): every command starts there and a cd out of it is refused. Run the command from the worktree, with paths relative to it.`;
      // Every command the shell would run (#109), heredoc bodies aside: split on the first line alone, a denied
      // command on a second line or after a single `&` was never looked at. Unread, every line and every `&` split.
      const items = readShell(cmd);
      const segments = items ? items.flatMap((it) => (it.kind === 'command' ? [it.text.replace(HEREDOC, '')] : [])) : cmd.split(/\n|&&|\|\||;|\||&/);
      for (const seg of segments) {
        // A prefix must not hide a denied command: judge the segment and what it actually runs.
        // The worktree anchor is peeled first, so its path cannot trip a rule (a directory named `worktree`).
        const own = unanchor(seg.trim(), worktree);
        for (const form of new Set([own, unanchor(normalizeSegment(own).command, worktree)])) {
          for (const r of rules) if (r.re.test(form)) return r.why;
          for (const d of userDeny) if (form.trim().startsWith(d)) return `denied by planestro policy (${d}).`;
        }
      }
      for (const seg of segments) {
        const own = unanchor(seg.trim(), worktree);
        for (const form of new Set([own, unanchor(normalizeSegment(own).command, worktree)])) {
          for (const r of redirects) if (form.trim().startsWith(r.prefix)) return `${r.message} (planestro policy redirects ${r.prefix}).`;
        }
      }
      return null;
    },
  };
}

/** Where scratch files may go besides the worktree. */
const SCRATCH = [...new Set(['/tmp', '/private/tmp', resolve(tmpdir())])];
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
/** Stands in for a value only the shell will know (`$(…)`, a variable set from one). */
const UNKNOWN = 'x';
const MAX_EXPANSIONS = 64;
/** Commands that make what they are given: an absolute path is theirs to create, whether or not its top folder exists. */
const MAKES = new Set(['mkdir']);
/** Flags of the built-in readers that run another program, and the one that writes a file. */
const RUNS_ANOTHER: { command: string[]; flag: RegExp; readOnly?: boolean }[] = [
  { command: ['rg'], flag: /^--pre(=|$)/ },
  { command: ['git', 'grep'], flag: /^(-O|--open-files-in-pager)/ },
  { command: ['sort'], flag: /^--compress-program/ },
  { command: ['sort'], flag: /^(-[A-Za-z]*o|--output)/, readOnly: true },
];

export interface ScopeOptions {
  /** A planning turn: nothing is written, so output goes nowhere but /dev/null. */
  readOnly?: boolean;
  /** Whether a path exists on this machine (tests). */
  exists?: (path: string) => boolean;
}

const prefixesOf = (rules: string[]): string[] => rules.filter((r) => r.startsWith('Bash(') && r.endsWith(')')).map((r) => r.slice(5, -1));
const matchesAny = (seg: string, prefixes: string[]): boolean => prefixes.some((p) => p.endsWith(' *') ? (seg + ' ').startsWith(p.slice(0, -1)) : p.endsWith('*') ? seg.startsWith(p.slice(0, -1)) : seg === p);

/** One segment against the rules: as written, or as the command it runs once prefixes are peeled. */
function segmentAllowed(raw: string, prefixes: string[], worktree?: string): boolean {
  const seg = worktree ? unanchor(raw, worktree) : raw;
  // A rule written with the prefix still matches as written; otherwise judge what the segment runs.
  if (matchesAny(seg, prefixes)) return true;
  const { command: peeled, unsafe } = normalizeSegment(seg);
  const command = worktree ? unanchor(peeled, worktree) : peeled;
  return !unsafe && command !== seg && command.length > 0 && matchesAny(command, prefixes);
}

/**
 * Deterministic allow for chained Bash commands: the SDK's own allowlist matcher refuses a
 * `a && b <<'EOF' ...` chain even when every segment is allowed, which would park a plain
 * `git add && git commit -F -`. A command is allowed when every segment (heredoc bodies
 * stripped — they are stdin data, not commands) matches one allow rule. Given the worktree,
 * `cd` into it is a no-op and `git -C` anchored to it is judged as plain `git`.
 *
 * What that refuses gets a second reading when the worktree is known (#96): the whole command,
 * loops, assignments and redirections included, is allowed when every command in it matches a
 * rule, scoped (`…@worktree`) or not, and nothing it names lies outside the worktree.
 */
export function allowedByRules(req: PermissionRequest, rules: string[], worktree?: string, scope: ScopeOptions = {}): boolean {
  if (req.tool !== 'Bash') return rules.includes(req.tool);
  rules = rules.map((r) => r.trim());
  const command = String(req.input.command ?? '');
  const asWritten = firstReading(command, prefixesOf(sdkRules(rules)), worktree, scope);
  if (asWritten || !worktree) return asWritten;
  return staysInWorktree(command, prefixesOf(rules.map((r) => r.endsWith(SCOPE) ? r.slice(0, -SCOPE.length) : r)), worktree, scope);
}

/**
 * The first reading (#109): every command the shell would run, on every line and inside every `$(…)`,
 * matches an unscoped rule, and what they write goes to the worktree, a scratch folder or a device (only
 * /dev/null while planning). It used to judge the first line split on `&&`, `||`, `;` and `|`, so
 * `git status` followed by a line `rm -rf build`, `git status & rm -rf build` or `git log > /etc/x` passed
 * as the rules for `git status` and `git log`. Heredoc bodies are data, never commands. A command the
 * shell reader does not follow (backticks, `<(…)`, `[[ … ]]`, …) is not allowed by this reading: it could
 * be running anything, and it parks for a decision. Loops are the second reading's.
 */
function firstReading(command: string, prefixes: string[], worktree: string | undefined, scope: ScopeOptions): boolean {
  const items = readShell(command);
  if (!items || !items.some((it) => it.kind === 'command')) return false;
  const roots = worktree ? [worktree, ...SCRATCH] : [];
  for (const at of located(items, worktree ?? '/')) {
    if (!('command' in at)) return false;
    const { dirs } = at;
    if (!dirs) return false;
    const it = at.command;
    if (it.assigns.some((a) => DANGEROUS_ENV.test(a.name))) return false;
    for (const r of it.redirects) {
      if (r.kind !== 'file') continue;
      const target = tilde(r.target) ? null : literal(r.target);
      if (target === null) return false;
      if (!r.write) continue;
      for (const d of dirs) {
        const abs = resolve(d, target);
        if (scope.readOnly ? abs !== '/dev/null' : !DEVICES.has(abs) && !roots.some((root) => within(abs, root))) return false;
      }
    }
    if (!it.words.length) return false;  // an assignment or a redirection by itself is the second reading's to judge
    const head = literal(it.words[0]);
    if (head === 'cd') {
      const to = it.words.length === 2 && !tilde(it.words[1]) ? literal(it.words[1]) : null;
      if (!worktree || to === null || it.piped || it.background || at.inLoop || !insideWorktree(to, worktree) || !dirs.every((d) => within(resolve(d, to), worktree))) return false;
      at.enter(to);
      continue;
    }
    if (!segmentAllowed(trimEndBlanks(it.text.replace(HEREDOC, '')), prefixes, worktree)) return false;
  }
  return true;
}

type Vars = Map<string, string[] | null>;

/** What a word can come to, from the variables the command itself set. Null: it reads one it never set. */
function expand(word: Word, vars: Vars, dirs: string[]): { values: string[]; known: boolean } | null {
  let values = [''];
  let known = true;
  for (const p of word.parts) {
    let next: string[] | null | undefined;
    if (p.kind === 'lit') next = [p.text];
    else if (p.kind === 'status') next = ['0'];
    else if (p.kind === 'sub') next = null;
    else if (p.name === 'PWD') next = dirs;
    else if (p.name === 'TMPDIR') next = [resolve(tmpdir())];
    else if (vars.has(p.name)) next = vars.get(p.name);
    else return null;
    if (!next || values.length * next.length > MAX_EXPANSIONS) { next = [UNKNOWN]; known = false; }
    const tail = next;
    values = values.flatMap((a) => tail.map((b) => a + b));
  }
  return { values, known };
}

/** What cannot be part of a path as workers write them: it ends one piece of an argument and begins the next. */
const NOT_PATH = /[^A-Za-z0-9._~/@%+*?[\]-]+/;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`()<>]*/gi;

interface Reading { dirs: string[]; roots: string[]; exists: (path: string) => boolean }

/**
 * Whether an argument keeps to the worktree and the scratch folders. It is judged as text, piece by
 * piece (`--out=/x`, `-I/x`, `{a,/x}`, the path inside an inline script): a piece that reads as a
 * path (absolute, in the home folder, or climbing with `..`) must resolve inside them, from every
 * directory the command may run in. An absolute piece whose top folder does not exist on this
 * machine is not a path here (`grep "/api/config"`, `sed -n '/start/,/end/p'`), unless the command
 * makes what it is given; a URL is not one either. `known` false: part of the value is the shell's
 * to fill in, so nothing in it may climb.
 */
function argumentStays(value: string, at: Reading, o: { known: boolean; lenient: boolean }): boolean {
  const inside = (abs: string): boolean => DEVICES.has(abs) || at.roots.some((root) => within(abs, root));
  const text = value.replace(URL, (url) => (/^file:/i.test(url) ? url.slice(5) : ' '));
  for (const raw of new Set([text, ...text.split(NOT_PATH)])) {
    const piece = raw.replace(/^-[A-Za-z]+(?=[/~.])/, '').replace(/^[@+%]+(?=[/~.])/, '');
    if (!piece || /^\/+$/.test(piece) && piece !== text) continue;
    if (piece === '~' || piece.startsWith('~/')) return false;
    const parts = piece.split('/');
    if (piece.startsWith('/')) {
      const top = parts.find((x) => x.length > 0) ?? '';
      const real = !o.lenient || /[*?[{]/.test(top) || at.exists(`/${top}`);
      if (!inside(resolve(piece)) && real) return false;
      continue;
    }
    // `.*` and `.?` come to `..` in some shells.
    if (parts.some((x) => /^\.[*?[]/.test(x))) return false;
    if (parts.includes('..') && (!o.known || !at.dirs.every((d) => inside(resolve(d, piece))))) return false;
  }
  return true;
}

/**
 * The second reading. Text only: it catches a command that names something outside the worktree
 * (a stray `cd`, a wrong absolute path, `> ~/.profile`), not a script that writes there by itself.
 * It is a guard against mistakes, not a sandbox.
 */
function staysInWorktree(command: string, prefixes: string[], worktree: string, scope: ScopeOptions): boolean {
  const items = readShell(command);
  if (!items || !items.some((it) => it.kind === 'command')) return false;
  const exists = scope.exists ?? existsSync;
  const roots = [worktree, ...SCRATCH];
  const vars: Vars = new Map();
  for (const at of located(items, worktree)) {
    const { dirs } = at;
    if (!dirs) return false;
    const reading: Reading = { dirs, roots, exists };
    const stays = (lenient: boolean) => (w: Word): boolean => { const e = tilde(w) ? null : expand(w, vars, dirs); return e !== null && e.values.every((v) => argumentStays(v, reading, { known: e.known, lenient })); };
    const set = (name: string, words: Word[]): void => { const all = words.map((w) => expand(w, vars, dirs)); vars.set(name, all.every((e) => e?.known) ? all.flatMap((e) => e!.values) : null); };
    if ('loop' in at) {
      if (!at.loop.words.every(stays(true))) return false;
      set(at.loop.name, at.loop.words);
      continue;
    }
    const it = at.command;
    for (const a of it.assigns) {
      if (DANGEROUS_ENV.test(a.name) || !stays(true)(a.value)) return false;
      set(a.name, [a.value]);
    }
    for (const r of it.redirects) {
      if (r.kind === 'heredoc' || r.kind === 'dup') continue;
      const e = tilde(r.target) ? null : expand(r.target, vars, dirs);
      if (!e) return false;
      if (r.kind === 'herestring') continue;
      if (!e.known) return false;
      for (const v of e.values) for (const d of dirs) {
        const abs = resolve(d, v);
        if (!DEVICES.has(abs) && !roots.some((root) => within(abs, root))) return false;
        if (scope.readOnly && r.write && abs !== '/dev/null') return false;
      }
    }
    if (!it.words.length) continue;  // an assignment or a redirection by itself
    const head = literal(it.words[0]);
    // A name with a blank or a control character in it (a carriage return from a pasted line) is no command a rule meant.
    if (head === null || /[^\x21-\x7e]/.test(head)) return false;
    if (head === 'cd' || head === 'pushd' || head === 'popd') {
      const to = head !== 'popd' && it.words.length === 2 && !tilde(it.words[1]) ? literal(it.words[1]) : null;
      // In a pipeline or the background it moves a shell of its own, and in a loop it moves again each time round:
      // the next command is not where it seems.
      if (to === null || to.startsWith('-') || it.piped || it.background || at.inLoop || !dirs.every((d) => within(resolve(d, to), worktree))) return false;
      at.enter(to);
      continue;
    }
    // The command word is the rules' to judge; what it is given must stay inside.
    const names = it.words.map(literal);
    if (!it.words.slice(1).every(stays(!names.some((n) => n !== null && MAKES.has(n))))) return false;
    for (const refused of RUNS_ANOTHER) {
      if (refused.readOnly && !scope.readOnly) continue;
      const from = names.findIndex((_, i) => refused.command.every((c, j) => names[i + j] === c));
      if (from >= 0 && it.words.slice(from + refused.command.length).some((w) => expand(w, vars, dirs)?.values.some((v) => refused.flag.test(v)))) return false;
    }
    if (!segmentAllowed(trimEndBlanks(it.text.replace(HEREDOC, '')), prefixes, worktree)) return false;
  }
  return true;
}

/** Permission rule that would pre-approve exactly this request on resume. */
export function ruleFor(req: PermissionRequest): string {
  if (req.tool === 'Bash') return `Bash(${String(req.input.command ?? '')})`;
  return req.tool;
}
