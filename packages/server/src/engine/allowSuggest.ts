import { isAbsolute, join } from 'node:path';
import { parseActivity, type Config, type ItemFile, type JournalEntry } from '@planestro/shared';
import { allowedByRules, BASE_ALLOWED, makePolicy, normalizeSegment, unanchor, type ScopeOptions } from './policy.ts';
import { commandShape, suggestedRule } from './parks.ts';
import { secretInCommand } from './secrets.ts';
import { literal, readShell } from './shell.ts';

/**
 * Allow rules suggested from the ruling history (#169). Most orchestrator wakes are rulings on safe,
 * repetitive commands, and each park costs the worker a resume; the project's `permissions.allow` is
 * curated by hand and lags behind what keeps being approved. This reads every past ruling, sorts its
 * command into a class, proposes worktree-scoped rules for the safe classes, and replays every ruling
 * against the current rules plus the proposal. A rule that would have allowed anything ever denied is
 * refused, so the proposal makes zero false allows on the history. Nothing is applied: the user adds
 * the rules they accept (Settings → permissions.allow).
 */

export type CommandClass = 'read-only' | 'git-read' | 'check-run' | 'interpreter' | 'shell-edit' | 'network' | 'destructive';
/** The classes a rule is ever proposed for. */
export const SAFE_CLASSES: readonly CommandClass[] = ['read-only', 'git-read', 'check-run'];
const SEVERITY: Record<CommandClass, number> = { 'read-only': 0, 'git-read': 1, 'check-run': 2, interpreter: 3, 'shell-edit': 4, network: 5, destructive: 6 };

/** One past decision on a parked request, from an item's Activity log or the journal. */
export interface Ruling {
  item: string;
  at: string;
  by: string;
  decision: 'allow' | 'always' | 'deny';
  tool: string;
  /** The Bash command, when the tool is Bash. */
  command?: string;
  reason?: string;
  /** The record holds only the start of the command (Activity keeps 400 characters of the rule). */
  truncated?: boolean;
  /**
   * The record may not be the command as it ran: truncated, or an Activity line (newlines become spaces) holding a heredoc
   * whose delimiter never comes (`restoreHeredocs`). A replay of it proves nothing, so a denied one refuses every rule for a kind of
   * command it names.
   */
  inexact?: boolean;
  /** The item's worktree, known or inferred: what `@worktree` rules and `git -C` anchors are judged against. */
  worktree: string;
}

const READERS = new Set(['cat', 'ls', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'echo', 'printf', 'pwd', 'stat', 'file', 'du', 'df', 'jq', 'diff', 'cmp', 'which', 'command', 'type', 'test', '[', 'true', 'false', ':', 'sleep', 'date', 'basename', 'dirname', 'realpath', 'readlink', 'ps', 'pgrep', 'xxd', 'od', 'hexdump', 'md5', 'md5sum', 'shasum', 'sha256sum', 'column', 'nl', 'fold', 'less', 'more', 'tree', 'comm', 'paste', 'expand', 'strings', 'identify', 'sips', 'cd', 'find', 'exit', 'wait', 'seq', 'uptime', 'whoami', 'hostname', 'uname', 'nproc', 'lsof', 'ffprobe']);
const GIT_READS = new Set(['log', 'diff', 'show', 'status', 'grep', 'rev-parse', 'blame', 'ls-files', 'ls-tree', 'merge-base', 'rev-list', 'cat-file', 'describe', 'shortlog', 'reflog', 'name-rev', 'for-each-ref', 'whatchanged', 'check-ignore', 'diff-tree', 'show-ref', 'count-objects', 'cherry', 'range-diff']);
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'send-email']);
const DESTRUCTIVE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'kill', 'killall', 'pkill', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'sudo', 'su', 'doas', 'truncate', 'launchctl', 'systemctl', 'diskutil', 'crontab', 'reboot', 'shutdown', 'sysctl', 'defaults', 'nvram', 'scutil']);
const NETWORK = new Set(['curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'gh', 'nc', 'ncat', 'telnet', 'ftp', 'brew', 'apt', 'apt-get', 'pip', 'pip3', 'docker', 'open', 'osascript']);
/** Shell words that are not commands of their own, or run the command they are given (`command foo`, `builtin`). */
const SHELL_WORDS = new Set(['command', 'builtin', 'break', 'continue', 'return', 'read', 'readarray', 'mapfile', 'set', 'unset', 'shift', 'export', 'local', 'declare', 'typeset', 'trap', 'ulimit', 'umask', 'alias', 'let', 'printenv', 'time', 'nohup', 'nice', 'timeout', 'gtimeout', 'caffeinate']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python3', 'node', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'eval', 'exec', 'source', '.', 'xargs', 'awk', 'gawk', 'sed', 'env', 'osascript', 'expect', 'parallel', 'watch']);
const WRITERS = new Set(['tee', 'cp', 'mv', 'touch', 'ln', 'patch', 'install', 'mktemp', 'tar', 'unzip', 'zip', 'gzip', 'gunzip']);
/** Package managers' subcommands that fetch from the network or change installed packages. */
const INSTALLS = /^(install|i|ci|add|remove|uninstall|update|upgrade|publish|login|link|exec|dlx|x)$/;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'cargo', 'go', 'uv', 'poetry', 'gem', 'bundle']);
/** Commands with a subcommand, whose rule must name it: `Bash(npm *)` would be every npm command. */
const NEEDS_SUB = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'go', 'uv', 'poetry', 'make', 'docker', 'gem', 'bundle']);

export interface Segment { text: string; shape?: string; cls: CommandClass }

/** The commands a Bash request runs, each reduced to what a rule judges (prefixes peeled, `git -C <worktree>` unanchored) and classed. */
export function segmentsOf(command: string, worktree: string): Segment[] | null {
  const items = readShell(command);
  if (!items) return null;
  const out: Segment[] = [];
  for (const it of items) {
    if (it.kind !== 'command' || it.words.length === 0) continue;
    const own = unanchor(it.text.trim(), worktree);
    const { command: peeled, unsafe } = normalizeSegment(own);
    const text = unanchor(peeled, worktree);
    const words = (readShell(text)?.find((x) => x.kind === 'command') as { words?: Parameters<typeof literal>[0][] } | undefined)?.words?.map(literal) ?? [];
    const shape = commandShape(text);
    // Where a command writes is the replay's to judge (the scoped matcher keeps writes in the worktree or a scratch dir).
    const cls = unsafe ? 'destructive' : classify(words, text);
    out.push({ text, ...(shape ? { shape } : {}), cls });
  }
  return out;
}

/** The class of one command, from its words (null where a word is an expansion). */
export function classify(words: (string | null)[], text = words.join(' ')): CommandClass {
  const head = words[0];
  if (!head) return 'interpreter';                      // `$cmd …`: it runs whatever it holds
  const base = head.split('/').pop() ?? head;
  const sub = words[1] ?? '';
  if (base === 'git') {
    const s = words.find((w, i) => i > 0 && w !== null && !w.startsWith('-') && words[i - 1] !== '-C' && words[i - 1] !== '-c') ?? '';
    if (words.includes('-C') && !GIT_READS.has(s)) return 'destructive';
    if (GIT_NETWORK.has(s)) return 'network';
    if (GIT_READS.has(s)) return 'git-read';
    if (s === 'add' || s === 'commit' || s === 'apply' || s === 'am') return 'shell-edit';
    return 'destructive';                               // reset, clean, checkout, rebase, …: any subcommand not known to be safe
  }
  if (base === 'find') return /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(text) ? 'destructive' : 'read-only';
  if (base === 'sed' && /\s(-[nErsuz]*i|--in-place)/.test(text)) return 'shell-edit';
  if (base === 'perl' && /\s-[pln0-9]*i/.test(text)) return 'shell-edit';
  if (DESTRUCTIVE.has(base)) return 'destructive';
  if (NETWORK.has(base)) return 'network';
  if (PACKAGE_MANAGERS.has(base) && INSTALLS.test(sub)) return 'network';
  if (INTERPRETERS.has(base) || SHELL_WORDS.has(base)) return 'interpreter';
  if (WRITERS.has(base)) return 'shell-edit';
  if (READERS.has(base)) return 'read-only';
  if (isAbsolute(head) && !head.startsWith('/usr/') && !head.startsWith('/opt/') && !head.startsWith('/bin/')) return 'interpreter';
  return 'check-run';                                   // the project's own tools, test runners and builds
}

/** The class of a whole request: its most dangerous command. A request the shell reader cannot follow is an interpreter's. */
export function classOf(r: Pick<Ruling, 'tool' | 'command' | 'worktree'>): CommandClass {
  if (r.tool !== 'Bash') return r.tool === 'Read' || r.tool === 'Grep' || r.tool === 'Glob' ? 'read-only' : 'shell-edit';
  const segs = segmentsOf(r.command ?? '', r.worktree);
  if (!segs || segs.length === 0) return 'interpreter';
  return segs.reduce<CommandClass>((worst, s) => (SEVERITY[s.cls] > SEVERITY[worst] ? s.cls : worst), 'read-only');
}

/** The rule a safe command would be proposed under, or none: only a safe class, never a bare multi-tool head. */
export function proposableRule(seg: Segment): string | undefined {
  if (!SAFE_CLASSES.includes(seg.cls) || !seg.shape) return undefined;
  const [head, sub] = seg.shape.split(' ');
  if (NEEDS_SUB.has(head) && !sub) return undefined;
  if (head === 'git' && !GIT_READS.has(sub ?? '')) return undefined;
  if (head === 'cd' || head === 'exit' || head === 'wait') return undefined;
  return suggestedRule(seg.shape);
}

const ACTIVITY = /^permission (allow|always|deny)/;
const HEREDOC_OPEN = /<<-?\s*(['"]?)(\w+)\1/g;

/**
 * An Activity line keeps a command on one line, so a heredoc's body reads as commands: `python3 - <<'EOF' s=open(p) EOF godot …`.
 * Each body is put back on lines of its own, up to its delimiter standing as a word, which makes the command readable again.
 * Null when a delimiter never comes (the record was cut short): what followed is unknown.
 */
export function restoreHeredocs(command: string): string | null {
  let out = '';
  let at = 0;
  HEREDOC_OPEN.lastIndex = 0;
  for (let m = HEREDOC_OPEN.exec(command); m; m = HEREDOC_OPEN.exec(command)) {
    const lineEnd = command.slice(m.index + m[0].length).search(/\s/);
    const bodyFrom = lineEnd < 0 ? command.length : m.index + m[0].length + lineEnd;
    const close = new RegExp(`(^|\\s)${m[2]}(?=\\s|$)`, 'g');
    close.lastIndex = bodyFrom;
    const c = close.exec(command);
    if (!c) return null;
    const end = c.index + c[0].length;
    out += `${command.slice(at, bodyFrom)}\n${command.slice(bodyFrom, c.index).trim()}\n${m[2]}\n`;
    at = end;
    HEREDOC_OPEN.lastIndex = end;
  }
  return out + command.slice(at).trim();
}
const RULE_MAX = 400;

/** The rulings recorded in an item's Activity log: `permission allow (reason): Bash(cmd)`, the reason only when the orchestrator ruled. */
export function rulingsFromActivity(item: string, file: ItemFile, worktree: (command: string) => string): Ruling[] {
  const out: Ruling[] = [];
  for (const a of parseActivity(file)) {
    const m = ACTIVITY.exec(a.text);
    if (!m) continue;
    let rest = a.text.slice(m[0].length);
    let reason: string | undefined;
    let rule: string;
    if (rest.startsWith(': ')) rule = rest.slice(2);
    else if (rest.startsWith(' (')) {
      const bash = rest.indexOf('): Bash(');
      const tool = /\): ([A-Z]\w*)$/.exec(rest);
      const at = bash >= 0 ? bash : tool ? tool.index : -1;
      if (at < 0) continue;
      reason = rest.slice(2, at);
      rule = rest.slice(at + 3);
    } else continue;
    const bash = /^Bash\(([\s\S]*)$/.exec(rule);
    const truncated = rule.length >= RULE_MAX || (bash !== null && !rule.endsWith(')'));
    const written = bash ? (rule.endsWith(')') ? bash[1].slice(0, -1) : bash[1]) : undefined;
    const restored = written !== undefined && !truncated && written.includes('<<') ? restoreHeredocs(written) : written;
    const command = restored ?? written;
    const inexact = truncated || (written !== undefined && restored === null);
    out.push({ item, at: a.at, by: a.actor, decision: m[1] as Ruling['decision'], tool: bash ? 'Bash' : rule.trim(), ...(command !== undefined ? { command, worktree: worktree(command) } : { worktree: worktree('') }), ...(reason ? { reason } : {}), ...(truncated ? { truncated: true } : {}), ...(inexact ? { inexact: true } : {}) });
  }
  return out;
}

/** The rulings in the journal's `permission.answered` entries that carry the request (recorded since #169). */
export function rulingsFromJournal(entries: JournalEntry[], worktree: (item: string, command: string) => string): Ruling[] {
  const out: Ruling[] = [];
  for (const e of entries) {
    const d = e.data ?? {};
    if (e.type !== 'permission.answered' || !e.item || typeof d.tool !== 'string') continue;
    if (d.decision !== 'allow' && d.decision !== 'always' && d.decision !== 'deny') continue;
    const command = typeof d.command === 'string' ? d.command : undefined;
    out.push({ item: e.item, at: e.ts, by: String(d.by ?? e.actor), decision: d.decision, tool: d.tool, ...(command !== undefined ? { command } : {}), ...(typeof d.reason === 'string' && d.reason ? { reason: d.reason } : {}), ...(d.truncated ? { truncated: true, inexact: true } : {}), worktree: worktree(e.item, command ?? '') });
  }
  return out;
}

/**
 * Both sources, each ruling once: the journal's (whole commands, newlines kept) where an item has them, and its Activity
 * log's for the rulings made before the journal carried the request.
 */
export function mergeRulings(fromActivity: Ruling[], fromJournal: Ruling[]): Ruling[] {
  const firstJournal = new Map<string, number>();
  for (const r of fromJournal) { const t = Date.parse(r.at); if (!(firstJournal.get(r.item)! <= t)) firstJournal.set(r.item, t); }
  const older = fromActivity.filter((r) => { const cut = firstJournal.get(r.item); return cut === undefined || Date.parse(r.at) < cut - 5_000; });
  return [...older, ...fromJournal].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A worktree for a ruling: the item's own, else the folder under the worktrees root its command names, else a stand-in there. */
export function worktreeFinder(root: string, codeRepo: string, recorded: (item: string) => string | undefined) {
  const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const under = new RegExp(`${esc}/([^/\\s'"\`;&|)]+)`);
  return (item: string, command: string): string => {
    const own = recorded(item);
    if (own) return isAbsolute(own) ? own : join(codeRepo, own);
    const m = under.exec(command);
    return m ? `${root}/${m[1]}` : `${root}/${item.toLowerCase()}`;
  };
}

export interface Suggestion {
  rule: string;
  shape: string;
  class: CommandClass;
  /** Past approvals with a command of this kind in them. */
  approvals: number;
  items: number;
  /** Past approvals it would have let run with no park, given the current rules (others need a second rule too). */
  unlocks: number;
  examples: string[];
}
export interface Refusal { rule: string; shape: string; class: CommandClass; approvals: number; denied: { item: string; at: string; command: string; reason?: string }[] }
export interface ReplayCounts { allowed_now: number; still_parks: number; false_allows: number }
export interface SuggestReport {
  rulings: number;
  allowed: number;
  denied: number;
  other_tools: number;
  by_class: Record<CommandClass, { allowed: number; denied: number }>;
  suggestions: Suggestion[];
  refused: Refusal[];
  /** Every past approval and denial replayed against the current rules, then against the current rules plus every suggestion. */
  replay: { current: ReplayCounts; proposed: ReplayCounts };
  /** Denied requests the current rules would let through today (a rule added after the denial): the user's to look at. */
  current_false_allows: { item: string; at: string; command: string; reason?: string }[];
  /** The approvals that would still park, by the kind of command, most first: what no safe rule covers. */
  uncovered: { shape: string; class: CommandClass; approvals: number }[];
  /** Kinds of command denied every time they were asked (#203): a refusal with the reason up front would spare the park. */
  redirects: Redirect[];
  drift: Drift;
}

/**
 * A kind of command to refuse up front with the reason it keeps getting (#203), instead of parking it for the same ruling.
 * Offered only when it was denied from several items, never approved, and its rule would have denied no past approval.
 */
export interface Redirect { rule: string; shape: string; class: CommandClass; denials: number; items: number; message: string; reasons: string[]; examples: string[] }

/**
 * What changed over the window (#203). `idle_rules`: the project's allow rules nothing recorded as run without a park
 * (`tools.ran`) matched in it, with when one last did; empty until anything is recorded. `rising`: kinds of command
 * still parking whose approvals went up against the window before it, with the rule offered for one, if any.
 */
export interface Drift {
  window_days: number;
  /** The first record of what ran: no rule can be called idle for longer than that. */
  recorded_since?: string;
  /** Commands recorded as run in the window. */
  runs: number;
  idle_rules: { rule: string; last_matched?: string }[];
  rising: { shape: string; class: CommandClass; recent: number; before: number; items: number; rule?: string }[];
}

/** One kind of tool call a worker turn made without a park, from the journal's `tools.ran` (#203). */
export interface Run { item: string; at: string; tool: string; command?: string; n: number; worktree: string }

export interface SuggestOptions {
  /** Approvals a kind of command needs before a rule is offered for it (3). */
  minApprovals?: number;
  /** Items they must come from (2): one item's habit is not the project's. */
  minItems?: number;
  scope?: ScopeOptions;
  /** What ran without a park, for drift. */
  runs?: Run[];
  /** The end of the drift window (now), and its length in days (30). */
  now?: number;
  windowDays?: number;
  /** Whether planestro's policy already refuses this request outright: no redirect is offered for it. */
  policyDenies?: (r: Ruling) => boolean;
}

const allowsReq = (r: Ruling, rules: string[], scope: ScopeOptions): boolean => r.tool === 'Bash' && allowedByRules({ tool: 'Bash', input: { command: r.command ?? '' } }, rules, r.worktree, scope);
const shapesOf = (r: Ruling): Set<string> => new Set((segmentsOf(r.command ?? '', r.worktree) ?? []).flatMap((s) => (s.shape ? [s.shape] : [])));
/**
 * Whether the part of an inexact record that is certain already holds a command none of these rules allows: then no
 * subset of them could have let the request through, however it went on. The last command read may be cut short (or
 * a heredoc's body never closed), so only the commands before it count.
 */
export function knownBlocker(r: Ruling, rules: string[], scope: ScopeOptions = {}): boolean {
  let text = r.command ?? '';
  HEREDOC_OPEN.lastIndex = 0;
  const restored = restoreHeredocs(text);
  if (restored !== null) text = restored;
  else { const open = text.search(/<<-?\s*['"]?\w+/); text = open >= 0 ? text.slice(0, open) : text; }
  const items = readShell(text) ?? readShell(text.replace(/\s*\S*$/, ''));
  const cmds = (items ?? []).filter((it): it is Extract<typeof it, { kind: 'command' }> => it.kind === 'command' && it.words.length > 0);
  return cmds.slice(0, -1).some((c) => !allowedByRules({ tool: 'Bash', input: { command: c.text.replace(/<<-?\s*['"]?\w+['"]?\s*$/, '') } }, rules, r.worktree, scope));
}

/** Every shape an inexact denied command could hold: its words read loosely as well, so an unreadable command still names its heads. */
function deniedShapes(r: Ruling): Set<string> {
  const shapes = shapesOf(r);
  for (const part of (r.command ?? '').split(/\n|&&|\|\||;|\||&|\$\(|`|\(|\{/)) {
    const peeled = normalizeSegment(unanchor(part.trim(), r.worktree)).command;
    const s = commandShape(peeled.replace(/['"]/g, ''));
    if (s) { shapes.add(s); shapes.add(s.split(' ')[0]); }
  }
  return shapes;
}

/**
 * The report. `current` is the project's `permissions.allow`; the replay judges with the rules a worker runs under while
 * implementing (planestro's base set plus those). A suggestion is refused when any denied request holds a command of its
 * kind, or when the replay finds a denied request it would let through; the suggestions together are replayed once more,
 * and any that still let a denial through are refused, so `replay.proposed.false_allows` beyond the current rules' own is 0.
 */
export function suggestAllowRules(rulings: Ruling[], current: string[], opts: SuggestOptions = {}): SuggestReport {
  const min = opts.minApprovals ?? 3;
  const minItems = opts.minItems ?? 2;
  const scope = opts.scope ?? {};
  const base = [...new Set([...BASE_ALLOWED.implement, ...current.map((r) => r.trim()).filter(Boolean)])];
  const bash = rulings.filter((r) => r.tool === 'Bash');
  const allowed = bash.filter((r) => r.decision !== 'deny');
  const denied = bash.filter((r) => r.decision === 'deny');
  const byClass = Object.fromEntries(Object.keys(SEVERITY).map((k) => [k, { allowed: 0, denied: 0 }])) as SuggestReport['by_class'];
  for (const r of bash) byClass[classOf(r)][r.decision === 'deny' ? 'denied' : 'allowed']++;

  // Candidates: the kinds of safe command the approvals held, with how often.
  const have = new Set(base);
  const cands = new Map<string, { rule: string; shape: string; cls: CommandClass; rulings: Ruling[] }>();
  // An approval that named a secret file (#227) is support for no rule: the deny list refuses it whatever a rule says.
  for (const r of allowed.filter((x) => !secretInCommand(x.command ?? '', x.worktree))) {
    const seen = new Set<string>();
    for (const s of segmentsOf(r.command ?? '', r.worktree) ?? []) {
      const rule = proposableRule(s);
      if (!rule || have.has(rule) || seen.has(rule) || allowedByRules({ tool: 'Bash', input: { command: s.text } }, base, r.worktree, scope)) continue;
      seen.add(rule);
      const c = cands.get(rule) ?? { rule, shape: s.shape!, cls: s.cls, rulings: [] };
      c.rulings.push(r);
      cands.set(rule, c);
    }
  }

  const everyRule = [...base, ...[...cands.keys()]];
  const inexact = denied.filter((r) => r.inexact && !knownBlocker(r, everyRule, scope)).map((r) => ({ r, shapes: deniedShapes(r) }));
  const currentFalse = denied.filter((r) => allowsReq(r, base, scope));
  const refused: Refusal[] = [];
  let accepted: (typeof cands extends Map<string, infer V> ? V : never)[] = [];
  const show = (r: Ruling) => ({ item: r.item, at: r.at, command: (r.command ?? '').slice(0, 300), ...(r.reason ? { reason: r.reason.slice(0, 300) } : {}) });
  for (const c of [...cands.values()].filter((x) => x.rulings.length >= min && new Set(x.rulings.map((r) => r.item)).size >= minItems)) {
    const head = c.shape.split(' ')[0];
    // A denial is let through when every command in it would run with no park (the replay), or, for a record that is
    // not the command as it ran, when it names this kind of command at all.
    const blocking = [
      ...denied.filter((r) => !currentFalse.includes(r) && allowsReq(r, [...base, c.rule], scope)),
      ...inexact.filter(({ shapes }) => shapes.has(c.shape) || (c.shape === head && shapes.has(head))).map(({ r }) => r),
    ];
    if (blocking.length) refused.push({ rule: c.rule, shape: c.shape, class: c.cls, approvals: c.rulings.length, denied: blocking.slice(0, 5).map(show) });
    else accepted.push(c);
  }
  // Together: a denial no one rule lets through may pass with two. Refuse the most recent addition until none does.
  accepted.sort((a, b) => b.rulings.length - a.rulings.length);
  for (;;) {
    const rules = [...base, ...accepted.map((c) => c.rule)];
    const leak = denied.find((r) => !currentFalse.includes(r) && allowsReq(r, rules, scope));
    if (!leak) break;
    const leakShapes = shapesOf(leak);
    const culprit = [...accepted].reverse().find((c) => leakShapes.has(c.shape)) ?? accepted[accepted.length - 1];
    refused.push({ rule: culprit.rule, shape: culprit.shape, class: culprit.cls, approvals: culprit.rulings.length, denied: [show(leak)] });
    accepted = accepted.filter((c) => c !== culprit);
  }

  const proposedRules = [...base, ...accepted.map((c) => c.rule)];
  const count = (rules: string[]): ReplayCounts => {
    const now = allowed.filter((r) => allowsReq(r, rules, scope)).length;
    return { allowed_now: now, still_parks: allowed.length - now, false_allows: denied.filter((r) => allowsReq(r, rules, scope)).length };
  };
  const suggestions: Suggestion[] = accepted.map((c) => ({
    rule: c.rule, shape: c.shape, class: c.cls, approvals: c.rulings.length, items: new Set(c.rulings.map((r) => r.item)).size,
    unlocks: c.rulings.filter((r) => !allowsReq(r, base, scope) && allowsReq(r, [...base, c.rule], scope)).length,
    examples: [...new Set(c.rulings.map((r) => (r.command ?? '').slice(0, 160)))].slice(0, 3),
  })).sort((a, b) => b.approvals - a.approvals || a.rule.localeCompare(b.rule));

  const uncovered = new Map<string, { shape: string; class: CommandClass; approvals: number }>();
  for (const r of allowed) {
    if (allowsReq(r, proposedRules, scope)) continue;
    const segs = segmentsOf(r.command ?? '', r.worktree) ?? [];
    const worst = segs.reduce<Segment | undefined>((w, s) => (!w || SEVERITY[s.cls] > SEVERITY[w.cls] ? s : w), undefined);
    const shape = worst?.shape ?? '(unreadable)';
    const u = uncovered.get(shape) ?? { shape, class: worst?.cls ?? 'interpreter', approvals: 0 };
    u.approvals++;
    uncovered.set(shape, u);
  }

  return {
    rulings: rulings.length, allowed: allowed.length, denied: denied.length, other_tools: rulings.length - bash.length,
    by_class: byClass, suggestions, refused: refused.sort((a, b) => b.approvals - a.approvals),
    replay: { current: count(base), proposed: count(proposedRules) },
    current_false_allows: currentFalse.map(show),
    uncovered: [...uncovered.values()].sort((a, b) => b.approvals - a.approvals).slice(0, 15),
    redirects: redirectsOf(allowed, denied.filter((r) => !currentFalse.includes(r)), { min, minItems, policyDenies: opts.policyDenies }),
    drift: driftOf(allowed, current, base, suggestions, { ...opts, min, minItems, scope }),
  };
}

/** The command in a request that decides how it is ruled: its riskiest, the first of those. */
export function worstOf(r: Pick<Ruling, 'command' | 'worktree'>): Segment | undefined {
  return (segmentsOf(r.command ?? '', r.worktree) ?? []).reduce<Segment | undefined>((w, s) => (!w || SEVERITY[s.cls] > SEVERITY[w.cls] ? s : w), undefined);
}

/** Whether a deny prefix refuses a request, read as `permissions.deny` is (`makePolicy`): any command in it, as written or peeled. */
export function deniedByPrefix(command: string, prefix: string, worktree: string): boolean {
  const items = readShell(command);
  const segs = items ? items.flatMap((it) => (it.kind === 'command' ? [it.text] : [])) : command.split(/\n|&&|\|\||;|\||&/);
  return segs.some((seg) => { const own = unanchor(seg.trim(), worktree); return [own, unanchor(normalizeSegment(own).command, worktree)].some((f) => f.trim().startsWith(prefix)); });
}

/**
 * Redirect candidates (#203): denials the current rules would still park, grouped by the command that decided them. A safe class is never one (a read
 * refused for where it reads, not what it is); nor is a kind any past request was approved for, by the replay of
 * every approval against the deny prefix: zero false denies on the history.
 */
function redirectsOf(allowed: Ruling[], denied: Ruling[], o: { min: number; minItems: number; policyDenies?: (r: Ruling) => boolean }): Redirect[] {
  const groups = new Map<string, { shape: string; cls: CommandClass; rulings: Ruling[] }>();
  for (const r of denied) {
    if (r.inexact || o.policyDenies?.(r)) continue;
    const w = worstOf(r);
    if (!w?.shape || SAFE_CLASSES.includes(w.cls)) continue;
    const [head, sub] = w.shape.split(' ');
    if (NEEDS_SUB.has(head) && !sub) continue;
    const g = groups.get(w.shape) ?? { shape: w.shape, cls: w.cls, rulings: [] };
    g.rulings.push(r);
    groups.set(w.shape, g);
  }
  const out: Redirect[] = [];
  for (const g of groups.values()) {
    const items = new Set(g.rulings.map((r) => r.item)).size;
    if (g.rulings.length < o.min || items < o.minItems) continue;
    if (allowed.some((r) => deniedByPrefix(r.command ?? '', g.shape, r.worktree))) continue;
    const counts = new Map<string, number>();
    for (const r of g.rulings) if (r.reason?.trim()) counts.set(r.reason.trim(), (counts.get(r.reason.trim()) ?? 0) + 1);
    const reasons = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t.slice(0, 300));
    out.push({
      rule: `Bash(${g.shape})`, shape: g.shape, class: g.cls, denials: g.rulings.length, items,
      message: reasons[0] ?? `denied every time it was asked (${g.rulings.length} times); do it another way`,
      reasons: reasons.slice(0, 3), examples: [...new Set(g.rulings.map((r) => (r.command ?? '').slice(0, 160)))].slice(0, 3),
    });
  }
  return out.sort((a, b) => b.denials - a.denials || a.rule.localeCompare(b.rule));
}

/** Whether one rule allows a recorded run: a bare tool name its tool, a Bash rule any one command in it. */
function ruleMatchesRun(rule: string, run: Run, scope: ScopeOptions): boolean {
  const m = /^(\w+)(?:\((.*)\))?(@\w+)?$/s.exec(rule.trim());
  if (!m) return false;
  if (m[1] !== run.tool) return rule.trim().startsWith(`${run.tool}(`) || false;
  if (run.tool !== 'Bash' || m[2] === undefined) return true;
  return (segmentsOf(run.command ?? '', run.worktree) ?? []).some((s) => allowedByRules({ tool: 'Bash', input: { command: s.text } }, [rule], run.worktree, scope));
}

function driftOf(allowed: Ruling[], current: string[], rulesNow: string[], suggestions: Suggestion[], o: SuggestOptions & { min: number; minItems: number; scope: ScopeOptions }): Drift {
  const days = o.windowDays ?? 30;
  const now = o.now ?? Date.now();
  const from = now - days * 86_400_000;
  // A run that named a secret file (#227) never ran (the deny list refused it): it keeps no rule alive.
  const runs = (o.runs ?? []).filter((r) => !(r.tool === 'Bash' && secretInCommand(r.command ?? '', r.worktree))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const inWindow = runs.filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) <= now);
  const idle: Drift['idle_rules'] = [];
  if (runs.length) {
    for (const rule of [...new Set(current.map((r) => r.trim()).filter(Boolean))]) {
      if (inWindow.some((r) => ruleMatchesRun(rule, r, o.scope))) continue;
      const last = [...runs].reverse().find((r) => ruleMatchesRun(rule, r, o.scope));
      idle.push({ rule, ...(last ? { last_matched: last.at } : {}) });
    }
  }
  // Approvals that still park under the current rules, by the command that decided them: this window against the one before.
  const tally = new Map<string, { shape: string; cls: CommandClass; recent: Ruling[]; before: number }>();
  for (const r of allowed) {
    const t = Date.parse(r.at);
    if (t > now || t < from - days * 86_400_000 || secretInCommand(r.command ?? '', r.worktree) || allowsReq(r, rulesNow, o.scope)) continue;
    const w = worstOf(r);
    if (!w?.shape) continue;
    const e = tally.get(w.shape) ?? { shape: w.shape, cls: w.cls, recent: [], before: 0 };
    if (t >= from) e.recent.push(r); else e.before++;
    tally.set(w.shape, e);
  }
  const rule = new Map(suggestions.map((s) => [s.shape, s.rule]));
  const rising = [...tally.values()]
    .filter((e) => e.recent.length >= o.min && new Set(e.recent.map((r) => r.item)).size >= o.minItems && e.recent.length > e.before)
    .map((e) => ({ shape: e.shape, class: e.cls, recent: e.recent.length, before: e.before, items: new Set(e.recent.map((r) => r.item)).size, ...(rule.has(e.shape) ? { rule: rule.get(e.shape)! } : {}) }))
    .sort((a, b) => b.recent - a.recent || a.shape.localeCompare(b.shape));
  return { window_days: days, ...(runs.length ? { recorded_since: runs[0].at } : {}), runs: inWindow.reduce((n, r) => n + r.n, 0), idle_rules: idle, rising };
}

/** What ran without a park, from the journal's `tools.ran` entries: one per worker turn (#203). */
export function runsFromJournal(entries: JournalEntry[], worktree: (item: string, command: string) => string): Run[] {
  const out: Run[] = [];
  for (const e of entries) {
    if (e.type !== 'tools.ran' || !e.item || !Array.isArray(e.data?.ran)) continue;
    for (const x of e.data.ran as Record<string, unknown>[]) {
      if (typeof x?.tool !== 'string') continue;
      const command = typeof x.command === 'string' ? x.command : undefined;
      out.push({ item: e.item, at: e.ts, tool: x.tool, ...(command !== undefined ? { command } : {}), n: typeof x.n === 'number' ? x.n : 1, worktree: worktree(e.item, command ?? '') });
    }
  }
  return out;
}

/**
 * Earlier rulings on the same kind of command (#203), newest first: the orchestrator is shown them, so equivalent
 * requests are answered the same way. The kind is the command that decides a ruling (the request's riskiest).
 */
export function precedents(rulings: Ruling[], command: string, worktree: string, limit = 5): Ruling[] {
  const shape = worstOf({ command, worktree })?.shape;
  if (!shape) return [];
  return rulings.filter((r) => r.tool === 'Bash' && worstOf(r)?.shape === shape).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}

/** What the report reads from a data dir: every item's Activity log, the journal, and where worktrees live. */
export interface RulingSource {
  listItems(): { id: string; file: ItemFile }[];
  journal: { read(opts?: { type?: string }): JournalEntry[] };
  codeRepoPath(): string;
  worktreesRoot(): string;
  config: { permissions: { allow: string[] }; code_repo?: { default_branch: string } };
}

/** Every ruling the data dir holds. */
export function rulingsOf(store: RulingSource): Ruling[] {
  const items = store.listItems();
  const recorded = new Map(items.map((s) => [s.id, typeof s.file.frontmatter.worktree === 'string' ? s.file.frontmatter.worktree : undefined]));
  const find = worktreeFinder(store.worktreesRoot(), store.codeRepoPath(), (id) => recorded.get(id));
  const fromActivity = items.flatMap((s) => rulingsFromActivity(s.id, s.file, (command) => find(s.id, command)));
  return mergeRulings(fromActivity, rulingsFromJournal(store.journal.read({ type: 'permission.answered' }), find));
}

/** The report for a data dir, against its current `permissions.allow`. */
export function suggestForStore(store: RulingSource, opts: SuggestOptions = {}): SuggestReport {
  const items = store.listItems();
  const recorded = new Map(items.map((s) => [s.id, typeof s.file.frontmatter.worktree === 'string' ? s.file.frontmatter.worktree : undefined]));
  const find = worktreeFinder(store.worktreesRoot(), store.codeRepoPath(), (id) => recorded.get(id));
  const policy = store.config.code_repo ? (r: Ruling) => makePolicy(store.config as Config, store.config.code_repo!.default_branch, r.worktree).deny({ tool: 'Bash', input: { command: r.command ?? '' } }) !== null : undefined;
  return suggestAllowRules(rulingsOf(store), store.config.permissions.allow, { runs: runsFromJournal(store.journal.read({ type: 'tools.ran' }), find), ...(policy ? { policyDenies: policy } : {}), ...opts });
}

/** The report as the CLI prints it. */
export function formatSuggestReport(r: SuggestReport): string {
  const pct = (n: number) => (r.allowed ? `${Math.round((n / r.allowed) * 100)}%` : '0%');
  const lines = [
    `${r.rulings} rulings: ${r.allowed} Bash approvals, ${r.denied} Bash denials, ${r.other_tools} on other tools.`,
    `By class (allowed / denied): ${Object.entries(r.by_class).filter(([, v]) => v.allowed + v.denied > 0).map(([k, v]) => `${k} ${v.allowed}/${v.denied}`).join(', ')}`,
    '',
    r.suggestions.length ? 'Suggested allow rules (none applied; add the ones you accept to permissions.allow):' : 'No allow rule to suggest.',
    ...r.suggestions.map((s) => `  ${s.rule.padEnd(48)} ${String(s.approvals).padStart(4)} approvals, ${s.items} items, ${s.unlocks} with no other rule  [${s.class}]\n      e.g. ${s.examples[0] ?? ''}`),
    '',
    `Replay of every past approval and denial:`,
    `  current rules:            ${r.replay.current.allowed_now} approvals run without a park (${pct(r.replay.current.allowed_now)}), ${r.replay.current.false_allows} denials let through`,
    `  current + suggestions:    ${r.replay.proposed.allowed_now} approvals run without a park (${pct(r.replay.proposed.allowed_now)}), ${r.replay.proposed.false_allows} denials let through`,
  ];
  if (r.current_false_allows.length) lines.push('', 'Denied once, allowed by the current rules today (a rule added since):', ...r.current_false_allows.slice(0, 10).map((d) => `  ${d.item} ${d.at}: ${d.command.slice(0, 120)}`));
  if (r.refused.length) lines.push('', 'Refused (it would have allowed a past denial):', ...r.refused.slice(0, 15).map((x) => `  ${x.rule.padEnd(48)} ${String(x.approvals).padStart(4)} approvals; denied ${x.denied[0].item} ${x.denied[0].at}: ${x.denied[0].command.slice(0, 90)}`));
  if (r.redirects.length) lines.push('', 'Denied every time (a refusal with this reason up front would spare the park; none applied):', ...r.redirects.map((x) => `  ${x.rule.padEnd(32)} ${String(x.denials).padStart(4)} denials, ${x.items} items  [${x.class}]\n      "${x.message.slice(0, 140)}"`));
  const d = r.drift;
  lines.push('', `Drift over the last ${d.window_days} days:`);
  if (!d.recorded_since) lines.push('  nothing recorded as run without a park yet: idle rules show once workers have run with it.');
  else lines.push(`  ${d.runs} commands ran without a park (recorded since ${d.recorded_since}).`, ...(d.idle_rules.length ? ['  Allow rules nothing matched:', ...d.idle_rules.map((x) => `    ${x.rule.padEnd(46)} ${x.last_matched ? `last matched ${x.last_matched}` : 'never matched'}`)] : ['  Every allow rule matched something.']));
  if (d.rising.length) lines.push('  Approvals rising (still parking):', ...d.rising.map((x) => `    ${x.shape.padEnd(30)} ${String(x.recent).padStart(4)} (was ${x.before}), ${x.items} items  [${x.class}]${x.rule ? `  → ${x.rule}` : ''}`));
  if (r.uncovered.length) lines.push('', 'Still parking (no safe rule covers them), by their riskiest command:', ...r.uncovered.map((u) => `  ${u.shape.padEnd(32)} ${String(u.approvals).padStart(4)}  [${u.class}]`));
  return lines.join('\n');
}
