import { literal, readShell } from './shell.ts';

/**
 * Git calls no allow rule may approve: the SDK approves `Bash(git diff*)` or `Bash(git fetch*)` by itself,
 * before planestro's policy is asked, so these are judged in the PreToolUse hook as well as in `makePolicy`.
 * `--output` makes a read (diff, log, show, format-patch) write any file, `--no-index` read any; a fetch refspec (`+sha:refs/heads/x`,
 * `a:b`) rewrites a ref in the store every worktree shares, outside planestro's ref lock. And the ways an allowed
 * git call runs a program of the worker's choosing without a park (#340): `rebase --exec`, `--upload-pack`, `-c core.*`.
 */
export function gitDenial(command: string): string | null {
  const items = readShell(command);
  const calls: string[][] = items
    ? items.flatMap((it) => (it.kind === 'command' ? [it.words.map((w) => literal(w) ?? '\0')] : []))
    : command.split(/\n|&&|\|\||;|\||&/).map((s) => s.trim().split(/\s+/));
  for (const words of calls) {
    const args = gitArgs(words);
    if (!args) continue;
    const { config, sub, rest } = args;
    const key = config.find((k) => !SAFE_CONFIG.test(k));
    if (key !== undefined) return `git -c ${key || '(config)'} can make git run a program; leave git's configuration as it is.`;
    if (sub === 'config') { const w = configWrite(rest); if (w !== null && !SAFE_CONFIG.test(w)) return `git config ${w || '(edit)'} changes what git runs; leave git's configuration as it is.`; }
    if (sub === 'rebase' && rest.some((a) => a === '--exec' || a.startsWith('--exec=') || /^-[A-Za-z]*x/.test(a))) return 'git rebase --exec runs a command for each commit; run it yourself after the rebase.';
    if (rest.some((a) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(a) || ((sub === 'fetch' || sub === 'clone' || sub === 'ls-remote' || sub === 'pull') && /^-u/.test(a)))) return 'that option runs a program on the remote side; planestro fetches for you.';
    // git takes a long option by any unambiguous start of it (`--outp=x` is `--output=x`) (#503).
    if (rest.some((a) => abbreviates(a, 'output', 3))) return 'git --output writes a file wherever it is told; print to the terminal or redirect inside your worktree.';
    // `git diff*` is the SDK's to approve, and --no-index makes it read any two files on the machine (#503).
    if (rest.some((a) => abbreviates(a, 'no-index', 4))) return 'git diff --no-index reads files outside the repository; compare files with diff, inside your worktree.';
    if (sub === 'fetch') {
      const operands = rest.filter((a) => !a.startsWith('-'));
      if (operands.slice(1).some((r) => r.startsWith('+') || r.includes(':'))) return 'a fetch refspec updates refs other worktrees share; planestro fetches for you (git fetch origin is fine).';
    }
  }
  return null;
}

/** Whether `arg` is the long option `--name`, written whole or cut to at least `min` letters, with or without `=value`. */
const abbreviates = (arg: string, name: string, min: number): boolean => {
  if (!arg.startsWith('--')) return false;
  const given = arg.slice(2).split('=')[0];
  return given.length >= min && name.startsWith(given);
};

/** `-c` keys that change only how git prints or who a commit is by; anything else (core.*, alias.*, a pager, an ssh command) may run a program. */
const SAFE_CONFIG = /^(user\.(name|email)|color(\.[\w.-]+)?|advice\.[\w-]+|log\.[\w-]+|diff\.(renames|noprefix|mnemonicprefix|relative|context|algorithm)|merge\.conflictstyle|commit\.gpgsign|init\.defaultbranch)$/i;

/**
 * The key a `git config` call writes, '' when it writes without naming one (`--edit`), or null for a read. Both forms:
 * `git config set|unset|… <key>` and `git config [--add|--unset…] <key> [<value>]`, where two operands are a write.
 */
function configWrite(rest: string[]): string | null {
  const first = rest[0];
  if (first && !first.startsWith('-')) {
    if (first === 'get' || first === 'list') return null;
    if (/^(set|unset|rename-section|remove-section|edit)$/.test(first)) return rest.slice(1).find((a) => !a.startsWith('-')) ?? '';
  }
  const operands: string[] = [];
  let write = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (/^(-e|--edit|--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section)$/.test(a)) write = true;
    else if (/^(-f|--file|--blob|--type|--default|--comment)$/.test(a)) i++;
    else if (!a.startsWith('-')) operands.push(a);
  }
  return write || operands.length >= 2 ? operands[0] ?? '' : null;
}

/** A git call's `-c` keys, subcommand and arguments, past `-C dir` and the like; null for anything but git. */
function gitArgs(words: string[]): { config: string[]; sub: string; rest: string[] } | null {
  let i = 0;
  while (i < words.length && /^(env|command|nice|timeout)$|^[A-Za-z_][A-Za-z0-9_]*=|^\d+[smh]?$|^-/.test(words[i]) && words[i] !== 'git') i++;
  if (words[i] !== 'git') return null;
  i++;
  const config: string[] = [];
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    if (w === '-c') { config.push((words[i + 1] ?? '').split('=')[0]); i += 2; }
    else if (w.startsWith('--config-env')) { config.push(''); i += w.includes('=') ? 1 : 2; }
    else i += /^(-C|--git-dir|--work-tree|--namespace)$/.test(w) ? 2 : 1;
  }
  return i < words.length ? { config, sub: words[i], rest: words.slice(i + 1) } : null;
}
