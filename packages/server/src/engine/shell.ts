/**
 * A reader for the shell a worker writes, for the worktree-scoped allow check (#96): the whole
 * command, not its first line, turned into the simple commands it runs. LM-24 parked ten times on
 * commands whose every piece was harmless (`npm run x; echo "exit $?"`, a `for` loop over four
 * names, `> tools/cache/build.log`), because a line split on `;` cannot tell a loop from a command.
 *
 * It understands what workers actually write: chains (`&&`, `||`, `;`, `|`, `&`, newlines), quotes,
 * heredocs, `( … )` and `{ …; }`, `for … in …; do … done`, `if`/`while`, `$(…)`, `$NAME`, `$?`,
 * redirections. Anything else (backticks, `<(…)`, `case`, `[[ … ]]`, `${x:-y}`, arithmetic, a
 * function definition) makes it give up, and a command it gave up on is never allowed by it.
 * It reads text: it does not run, expand or resolve anything.
 */

export type Part =
  | { kind: 'lit'; text: string; quoted: boolean }
  | { kind: 'var'; name: string }
  /** `$?` */
  | { kind: 'status' }
  /** `$(…)`: the commands inside are items of their own, between an `open` and a `close`. */
  | { kind: 'sub' };

export interface Word { parts: Part[] }

export interface Redirect {
  op: string;
  target: Word;
  /** `<<EOF`, `<<-EOF`: the target is the delimiter. `<<<`: the target is data. Neither names a file. */
  kind: 'file' | 'dup' | 'heredoc' | 'herestring';
  write: boolean;
}

export interface Command {
  kind: 'command';
  /** As written, from its first word (or assignment) to its last, redirections included. */
  text: string;
  assigns: { name: string; value: Word }[];
  words: Word[];
  redirects: Redirect[];
  /** Part of a pipeline, or sent to the background: it runs in a shell of its own. */
  piped: boolean;
  background: boolean;
  /** What joins it to the command before it: `&&`, `||`, `;`, `|`, `&`, a newline, or nothing (the first of its group, or after a keyword). */
  joined: string;
}

export type Item =
  | Command
  | { kind: 'for'; name: string; words: Word[] }
  /**
   * A group begins or ends. `sub`: a subshell or a `$(…)`, where a `cd` does not outlive the group.
   * `brace`: `{ …; }`, where it does. `loop`: the body between `do` and `done`, which may run any number of times.
   */
  | { kind: 'open'; group: Group }
  | { kind: 'close'; group: Group };

export type Group = 'sub' | 'brace' | 'loop';

/** The word's text when it is all literal; null when it holds an expansion. */
export function literal(word: Word): string | null {
  let out = '';
  for (const p of word.parts) { if (p.kind !== 'lit') return null; out += p.text; }
  return out;
}

class GiveUp extends Error {}
const giveUp = (): never => { throw new GiveUp(); };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const REDIRECT = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;
/** Words that only lead into the command after them. */
const LEADS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', '!', 'fi']);
/** `$(…)` inside `$(…)`: deeper than any worker writes, and short of what the reader's own stack holds. */
const MAX_DEPTH = 40;
/** Syntax this reader does not follow. */
const UNREAD = new Set(['case', 'esac', 'select', 'function', 'coproc', '[[']);

class Reader {
  private i = 0;
  private braces = 0;
  private loops = 0;
  private depth = 0;
  private readonly heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  readonly items: Item[] = [];
  constructor(private readonly src: string) {}

  private get more(): boolean { return this.i < this.src.length; }
  private at(s: string): boolean { return this.src.startsWith(s, this.i); }

  private skipBlank(): void {
    while (this.more) {
      if (this.at(' ') || this.at('\t')) this.i++;
      else if (this.at('\\\n')) this.i += 2;
      else break;
    }
  }

  /** Past the newline, and past the body of every heredoc the line opened. */
  private newline(): void {
    this.i++;
    for (const h of this.heredocs.splice(0)) {
      while (this.more) {
        const end = this.src.indexOf('\n', this.i);
        const line = this.src.slice(this.i, end < 0 ? this.src.length : end);
        this.i = end < 0 ? this.src.length : end + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        // An unquoted delimiter leaves the body open to expansion: a command in it would run.
        if (!h.quoted && /\$\(|`/.test(line)) giveUp();
      }
    }
  }

  /** Commands up to the end of the text, or up to the `)` that closes a `$(…)`. */
  run(inSub: boolean): void {
    let parens = 0;
    let cmd: Command | undefined;
    let start = 0;
    let end = 0;
    let piped = false;
    let joined = '';
    const open = (at: number): Command => { if (!cmd) { cmd = { kind: 'command', text: '', assigns: [], words: [], redirects: [], piped, background: false, joined }; start = at; } return cmd; };
    /** The command is complete; `by` is what joins the next one to it. */
    const finish = (by: string): void => {
      if (cmd) { cmd.text = this.src.slice(start, end); this.items.push(cmd); }
      // A blank line, or a newline after an operator, joins nothing.
      if (cmd || by !== '\n') joined = by;
      cmd = undefined;
      piped = false;
    };

    for (;;) {
      this.skipBlank();
      if (!this.more) { finish(''); if (inSub || parens || this.braces || this.loops) giveUp(); return; }
      const c = this.src[this.i];
      if (c === '\n') { finish('\n'); this.newline(); continue; }
      if (c === '#') { const end = this.src.indexOf('\n', this.i); this.i = end < 0 ? this.src.length : end; continue; }
      if (c === ';') { if (this.at(';;')) giveUp(); finish(';'); this.i++; continue; }
      if (c === '&' && !this.at('&>')) {
        if (this.at('&&')) { finish('&&'); this.i += 2; continue; }
        if (cmd) cmd.background = true;
        finish('&'); this.i++; continue;
      }
      if (c === '|') {
        if (this.at('||')) { finish('||'); this.i += 2; continue; }
        if (this.at('|&')) giveUp();
        if (cmd) cmd.piped = true;
        finish('|'); piped = true; this.i++; continue;
      }
      if (c === '(') {
        if (cmd || this.at('((')) giveUp();
        this.items.push({ kind: 'open', group: 'sub' }); parens++; joined = ''; this.i++; continue;
      }
      if (c === ')') {
        finish(';');
        if (parens) { parens--; this.items.push({ kind: 'close', group: 'sub' }); this.i++; continue; }
        if (inSub) return;
        giveUp();
      }
      const r = REDIRECT.exec(this.src.slice(this.i, this.i + 8));
      if (r) { this.redirect(open(this.i), r[2], r[0].length); end = this.i; continue; }

      const at = this.i;
      const word = this.word();
      if (this.i === at) giveUp();  // a character no rule above reads
      const bare = word.parts.length === 1 && word.parts[0].kind === 'lit' && !word.parts[0].quoted ? word.parts[0].text : undefined;
      if (!cmd && bare !== undefined) {
        if (UNREAD.has(bare)) giveUp();
        if (LEADS.has(bare)) { joined = bare === 'fi' ? ';' : ''; continue; }
        if (bare === 'do') { this.items.push({ kind: 'open', group: 'loop' }); this.loops++; joined = ''; continue; }
        if (bare === 'done') { if (!this.loops) giveUp(); this.loops--; this.items.push({ kind: 'close', group: 'loop' }); joined = ';'; continue; }
        if (bare === '{') { this.items.push({ kind: 'open', group: 'brace' }); this.braces++; joined = ''; continue; }
        if (bare === '}') { if (!this.braces) giveUp(); this.braces--; this.items.push({ kind: 'close', group: 'brace' }); joined = ';'; continue; }
        if (bare === 'for') { this.loop(); continue; }
      }
      const cur = open(at);
      const first = word.parts[0];
      const a = !cur.words.length && first?.kind === 'lit' && !first.quoted ? ASSIGN.exec(first.text) : null;
      if (a && first?.kind === 'lit') {
        const rest = first.text.slice(a[0].length);
        cur.assigns.push({ name: a[1], value: { parts: [...(rest ? [{ kind: 'lit' as const, text: rest, quoted: false }] : []), ...word.parts.slice(1)] } });
      } else cur.words.push(word);
      end = this.i;
    }
  }

  /** `for NAME in WORDS`, up to the `;` or newline before `do`. */
  private loop(): void {
    this.skipBlank();
    const name = literal(this.word());
    if (!name || NAME.exec(name)?.[0] !== name) giveUp();
    this.skipBlank();
    if (literal(this.word()) !== 'in') giveUp();
    const words: Word[] = [];
    for (;;) {
      this.skipBlank();
      if (!this.more || this.at('\n') || this.at(';')) break;
      if (/[&|()<>]/.test(this.src[this.i])) giveUp();
      const at = this.i;
      words.push(this.word());
      if (this.i === at) giveUp();
    }
    this.items.push({ kind: 'for', name: name as string, words });
  }

  private redirect(cmd: Command, op: string, length: number): void {
    this.i += length;
    if (this.at('(')) giveUp();  // <(…) and >(…)
    this.skipBlank();
    const target = this.word();
    if (!target.parts.length) giveUp();
    const text = literal(target);
    if (op === '<<' || op === '<<-') {
      if (text === null) giveUp();
      this.heredocs.push({ delim: text as string, strip: op === '<<-', quoted: target.parts.some((p) => p.kind === 'lit' && p.quoted) });
      cmd.redirects.push({ op, target, kind: 'heredoc', write: false });
      return;
    }
    const kind = op === '<<<' ? 'herestring' : (op === '>&' || op === '<&') && text !== null && /^(\d+|-)$/.test(text) ? 'dup' : 'file';
    cmd.redirects.push({ op, target, kind, write: op.includes('>') });
  }

  /** One word: what stands between blanks and operators, quotes and expansions included. */
  private word(): Word {
    const parts: Part[] = [];
    const lit = (text: string, quoted: boolean): void => {
      const last = parts[parts.length - 1];
      if (last?.kind === 'lit' && last.quoted === quoted) last.text += text;
      else parts.push({ kind: 'lit', text, quoted });
    };
    while (this.more) {
      const c = this.src[this.i];
      // Blanks as the shell counts them: a carriage return or a no-break space is part of the word.
      if (' \t\n;&|<>()'.includes(c)) break;
      if (c === '\\') {
        if (this.at('\\\n')) { this.i += 2; continue; }
        if (this.i + 1 >= this.src.length) giveUp();
        lit(this.src[this.i + 1], true); this.i += 2; continue;
      }
      if (c === "'") {
        const end = this.src.indexOf("'", this.i + 1);
        if (end < 0) giveUp();
        lit(this.src.slice(this.i + 1, end), true); this.i = end + 1; continue;
      }
      if (c === '"') { this.quoted(parts, lit); continue; }
      if (c === '`') giveUp();
      if (c === '$') { this.dollar(parts, lit, false); continue; }
      lit(c, false); this.i++;
    }
    return { parts };
  }

  private quoted(parts: Part[], lit: (text: string, quoted: boolean) => void): void {
    this.i++;
    lit('', true);
    for (;;) {
      if (!this.more) giveUp();
      const c = this.src[this.i];
      if (c === '"') { this.i++; return; }
      if (c === '`') giveUp();
      if (c === '\\' && this.i + 1 < this.src.length && '"\\$`\n'.includes(this.src[this.i + 1])) {
        if (this.src[this.i + 1] !== '\n') lit(this.src[this.i + 1], true);
        this.i += 2; continue;
      }
      if (c === '$') { this.dollar(parts, lit, true); continue; }
      lit(c, true); this.i++;
    }
  }

  private dollar(parts: Part[], lit: (text: string, quoted: boolean) => void, inQuotes: boolean): void {
    const next = this.src[this.i + 1] ?? '';
    if (next === '(') {
      if (this.at('$((') || ++this.depth > MAX_DEPTH) giveUp();
      this.i += 2;
      this.items.push({ kind: 'open', group: 'sub' });
      this.run(true);
      if (!this.at(')')) giveUp();
      this.i++;
      this.depth--;
      this.items.push({ kind: 'close', group: 'sub' });
      parts.push({ kind: 'sub' });
      return;
    }
    if (next === '{') {
      const end = this.src.indexOf('}', this.i + 2);
      const name = end < 0 ? '' : this.src.slice(this.i + 2, end);
      if (!name || NAME.exec(name)?.[0] !== name) giveUp();
      parts.push({ kind: 'var', name }); this.i = end + 1; return;
    }
    if (next === '?') { parts.push({ kind: 'status' }); this.i += 2; return; }
    const name = NAME.exec(this.src.slice(this.i + 1, this.i + 80))?.[0];
    if (name) { parts.push({ kind: 'var', name }); this.i += 1 + name.length; return; }
    // `$'…'`, `$"…"`, `$1`, `$@`, `$$`, `$!`: not followed.
    if (/[0-9@*#$!\-]/.test(next) || (!inQuotes && (next === "'" || next === '"'))) giveUp();
    lit('$', inQuotes); this.i++;
  }
}

/** The command as the items it runs, in order, or null when it holds something this reader does not follow. */
export function readShell(source: string): Item[] | null {
  const reader = new Reader(source);
  // A RangeError is the reader's own stack running out on nesting it should have refused: not read, either.
  try { reader.run(false); } catch (e) { if (e instanceof GiveUp || e instanceof RangeError) return null; throw e; }
  return reader.items;
}
