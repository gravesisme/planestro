import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { PermissionRequest } from './ports.ts';
import { readShell, type Word } from './shell.ts';

/**
 * The built-in deny list for secret files (#227): no rule, scoped rule, read-only helper or
 * `permissions.allow` entry lets a worker read or write these. Checked before anything else, by
 * `makePolicy` (canUseTool) and by the Claude port's PreToolUse hook, which also sees what the
 * SDK approves by itself (an allow-listed `tail *`, a built-in read-only command, an edit under
 * acceptEdits). Paths are judged as written and as they resolve through symlinks.
 */
export interface SecretOptions {
  home?: string;
  /** `$CODEX_HOME`, whose auth.json is Codex's login. */
  codexHome?: string;
  /** More folders whose every file is a secret: the other accounts' config folders (#242). `~/` is the home folder. */
  dirs?: readonly string[];
  /** Whether a path exists (tests). */
  exists?(path: string): boolean;
}

/** Directories whose every file is a secret, under the home folder. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', join('.config', 'gcloud'), join('.config', 'gh')];

const SECRET_NAMES: { re: RegExp; what: string }[] = [
  { re: /^\.env(?!\.example$)/, what: '.env files' },
  { re: /.\.pem$/, what: '*.pem' },
  { re: /.\.key$/, what: '*.key' },
  { re: /^id_(rsa|ed25519)/, what: 'SSH keys' },
  { re: /^credentials\.json$/, what: 'credentials.json' },
  { re: /^secrets\./, what: 'secrets.*' },
];

/** The longest existing prefix of a path, resolved through symlinks, with the rest put back. */
function real(abs: string): string {
  let head = abs;
  const rest: string[] = [];
  for (let guard = 0; guard < 256; guard++) {
    try { return join(realpathSync(head), ...rest.reverse()); }
    catch { /* not there: try its parent */ }
    const up = dirname(head);
    if (up === head) break;
    rest.push(basename(head));
    head = up;
  }
  return abs;
}

const within = (abs: string, root: string): boolean => abs === root || abs.startsWith(root + '/');

/** What an absolute path is on the list as, or null. */
function listed(abs: string, o: SecretOptions): string | null {
  const home = o.home ?? homedir();
  for (const d of SECRET_DIRS) if (within(abs, join(home, d))) return `~/${d}`;
  for (const d of o.dirs ?? []) if (within(abs, resolve(d.startsWith('~/') ? join(home, d.slice(2)) : d))) return "another account's config folder";
  const gcloud = process.env.CLOUDSDK_CONFIG;
  if (gcloud && within(abs, resolve(gcloud))) return 'gcloud config';
  const auth = [join(o.codexHome ?? process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json'), join(home, '.codex', 'auth.json'), join(home, '.planestro', 'codex', 'auth.json')];
  if (auth.includes(abs)) return "Codex's login (auth.json)";
  // Claude Code's login where no keychain holds it (Linux), in the home folder and in each account's (#242, #340).
  if (abs.endsWith('/.credentials.json') && [join(home, '.claude'), ...(o.dirs ?? []).map((d) => resolve(d.startsWith('~/') ? join(home, d.slice(2)) : d))].includes(dirname(abs))) return "Claude Code's login (.credentials.json)";
  if (/^\/proc\/[^/]+\/environ$/.test(abs)) return "a process's environment (/proc/*/environ)";
  // What git runs by itself (#340): a hook before an allowed `git commit`, or a program its configuration names
  // (core.hooksPath, core.fsmonitor, a filter), so a worker that wrote one would run code without a park.
  if (/\/\.git\/(worktrees\/[^/]+\/)?config(\.worktree)?$/.test(abs)) return '.git/config';
  if (/\/\.git\/hooks(\/|$)/.test(abs)) return '.git/hooks';
  const name = basename(abs);
  for (const n of SECRET_NAMES) if (n.re.test(name)) return n.what;
  return null;
}

/**
 * Whether a path, seen from `cwd`, names a secret: `~` is the home folder, and the path is judged
 * as written and through any symlink in it. Returns what it is on the list as, or null.
 */
export function secretPath(raw: string, cwd: string, o: SecretOptions = {}): string | null {
  const home = o.home ?? homedir();
  const p = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
  if (!p) return null;
  const abs = resolve(cwd, p);
  const resolved = real(abs);
  return listed(abs, o) ?? listed(resolved, o) ?? listed(resolved, { ...o, home: real(home) });
}

const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`()<>]*/gi;

/** A word's text with what the command cannot know stood in for (`$HOME` is known). */
function wordText(word: Word, home: string): string {
  return word.parts.map((p) => p.kind === 'lit' ? p.text : p.kind === 'var' && p.name === 'HOME' ? home : 'x').join('');
}

/**
 * The first secret a Bash command names in what resolves statically: its words, the pieces of a
 * word (`--file=~/.aws/credentials`, `HEAD:.env`), redirection targets and assignments. A bare
 * name (no `/`, or prose with a blank in it) counts when it is a redirection target, holds a glob, or
 * exists, so `grep id_rsa src` stays a search and `git commit -m "load .env"` a commit. A command the shell reader cannot follow is read as words split on blanks.
 * Arbitrary reads inside a program it runs (a script, `grep -r`) are not seen.
 */
export function secretInCommand(command: string, cwd: string, o: SecretOptions = {}): { path: string; what: string } | null {
  const home = o.home ?? homedir();
  const exists = o.exists ?? existsSync;
  const items = readShell(command);
  const words: { text: string; target: boolean }[] = [];
  if (items) {
    for (const it of items) {
      if (it.kind === 'for') { for (const w of it.words) words.push({ text: wordText(w, home), target: false }); continue; }
      if (it.kind !== 'command') continue;
      for (const w of it.words) words.push({ text: wordText(w, home), target: false });
      for (const a of it.assigns) words.push({ text: wordText(a.value, home), target: false });
      for (const r of it.redirects) if (r.kind === 'file') words.push({ text: wordText(r.target, home), target: true });
    }
  } else {
    for (const w of command.split(/[\s;&|<>()`]+/)) if (w) words.push({ text: w.replace(/^['"]|['"]$/g, '').replace(/\$\{?HOME\}?/g, home), target: false });
  }
  for (const w of words) {
    const text = w.text.replace(URL, ' ');
    for (const piece of new Set([text, ...text.split(/[=:,'"]+/)])) {
      if (!piece || piece.startsWith('-') && !piece.includes('/')) continue;
      // A piece with a blank in it is prose (a commit message) unless it is a file that is there.
      const bare = (!piece.includes('/') || /\s/.test(piece)) && piece !== '~';
      if (bare && !w.target && !/[*?[]/.test(piece) && !exists(resolve(cwd, piece))) continue;
      const what = secretPath(piece, cwd, o);
      if (what) return { path: piece, what };
    }
  }
  return null;
}

/** The input fields of the file tools that name a path (Grep's `pattern` is a regex, Glob's a file pattern). */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'glob'];

/**
 * Why a tool call is refused by the deny list, or null. Bash is judged by `secretInCommand`;
 * any other tool by the path fields it was given (Read, Write, Edit, MultiEdit, NotebookEdit,
 * Glob, Grep, LS). MCP tools are not judged here.
 */
export function secretDenial(req: PermissionRequest, cwd: string, o: SecretOptions = {}): string | null {
  if (req.tool.startsWith('mcp__')) return null;
  const say = (path: string, what: string) => what.startsWith('.git/')
    ? `${path} is git's own ${what.slice(5)}: git runs what it holds or names, so planestro's built-in deny list lets no worker read or write it, and no rule overrides that. Commit as you are; if the work truly needs it changed, report_blocked saying why.`
    : `${path} is a secret file (${what}): planestro's built-in deny list lets no worker read or write it, and no rule overrides that. Do the work without it; if it truly needs the file, report_blocked saying why.`;
  if (req.tool === 'Bash') {
    const hit = secretInCommand(String(req.input.command ?? ''), cwd, o);
    return hit ? say(hit.path, hit.what) : null;
  }
  for (const f of req.tool === 'Glob' ? [...PATH_FIELDS, 'pattern'] : PATH_FIELDS) {
    const v = req.input[f];
    if (typeof v !== 'string' || !v) continue;
    // Grep's glob and Glob's pattern name files by shape: `**/.env*` is judged by its last part.
    const path = f === 'glob' || f === 'pattern' ? (v.startsWith('~') || v.startsWith('/') ? v : basename(v)) : v;
    const what = secretPath(path, cwd, o);
    if (what) return say(v, what);
  }
  return null;
}
