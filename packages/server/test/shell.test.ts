import { describe, it, expect } from 'vitest';
import { readShell, literal, type Command, type Item } from '../src/engine/shell.ts';

const commands = (src: string): Command[] => (readShell(src) ?? []).filter((it): it is Command => it.kind === 'command');
const texts = (src: string): string[] => commands(src).map((c) => c.text);
const shape = (src: string): string => (readShell(src) ?? []).map((it: Item) => (it.kind === 'command' ? 'c' : it.kind === 'for' ? 'f' : it.kind === 'open' ? '(' : ')')).join('');

describe('readShell (#96)', () => {
  it('splits a chain into the commands it runs, a single & and a newline included', () => {
    expect(texts('npm run a && npm run b || echo no; ls | head -3')).toEqual(['npm run a', 'npm run b', 'echo no', 'ls', 'head -3']);
    expect(texts('npm run x & rm -rf y')).toEqual(['npm run x', 'rm -rf y']);
    expect(texts('npm run x\nrm -rf build\n')).toEqual(['npm run x', 'rm -rf build']);
    expect(texts('ls \\\n  -la # a comment\n# another\npwd')).toEqual(['ls \\\n  -la', 'pwd']);
    const [a, b, c] = commands('a | b & c');
    expect([a.piped, a.background, b.piped, b.background, c.piped, c.background]).toEqual([true, false, true, true, false, false]);
  });

  it('keeps what is quoted in one word', () => {
    expect(texts(`git commit -m "one; two && three | four"`)).toHaveLength(1);
    expect(texts(`echo 'a; b' "c\nd" e\\;f`)).toHaveLength(1);
    const [c] = commands(`grep -n "it's (fine)" 'a b'`);
    expect(c.words.map(literal)).toEqual(['grep', '-n', "it's (fine)", 'a b']);
  });

  it('reads past a heredoc body, and on to what follows it', () => {
    expect(texts("python3 - <<'EOF'\nimport os; x = \"a && b\"\nprint('$(rm -rf /)')\nEOF\necho done")).toEqual(["python3 - <<'EOF'", 'echo done']);
    expect(texts('cat <<-END\n\tbody\n\tEND\nls')).toEqual(['cat <<-END', 'ls']);
    // Never closed: the rest is its body, as the shell reads it.
    expect(texts("git commit -F - <<'EOF'")).toEqual(["git commit -F - <<'EOF'"]);
    // An unquoted delimiter leaves the body open to expansion.
    expect(readShell('cat <<EOF\n$(rm -rf /)\nEOF')).toBeNull();
    expect(readShell('cat <<EOF\nplain $NAME\nEOF')).not.toBeNull();
  });

  it('reads the commands inside $(…), heredocs and quotes within it included', () => {
    expect(shape('P=$(npx tsx find.ts) && echo "$P"')).toBe('(c)cc');
    expect(texts('echo "last: $(tail -1 a.log | cut -c1-9)"')).toEqual(['tail -1 a.log', 'cut -c1-9', 'echo "last: $(tail -1 a.log | cut -c1-9)"']);
    const src = `git add -A && git commit -q -m "$(cat <<'EOF'\nLM-24: don't park; (fix) it's fine\nEOF\n)" && echo ok`;
    expect(commands(src).map((c) => literal(c.words[0]))).toEqual(['git', 'cat', 'git', 'echo']);
  });

  it('looks through groups, loops and conditions', () => {
    expect(shape('(cd sub && ls); { pwd; }')).toBe('(cc)(c)');
    const items = readShell('for m in sand dirt rock; do grep -n "$m" a.md; done > out.log') ?? [];
    expect(items[0]).toMatchObject({ kind: 'for', name: 'm' });
    expect(items[0].kind === 'for' && items[0].words.map(literal)).toEqual(['sand', 'dirt', 'rock']);
    expect(items.filter((it) => it.kind === 'command').map((c) => (c as Command).text)).toEqual(['grep -n "$m" a.md', '> out.log']);
    expect(texts('if [ -f a ]; then cat a; else echo none; fi')).toEqual(['[ -f a ]', 'cat a', 'echo none']);
    expect(texts('while ! test -f a; do sleep 1; done')).toEqual(['test -f a', 'sleep 1']);
  });

  it('tells assignments, words and redirections apart', () => {
    const [c] = commands('A=1 B="$X/y" npm run build > out/b.log 2>&1 < in.txt');
    expect(c.assigns.map((a) => a.name)).toEqual(['A', 'B']);
    expect(c.assigns[1].value.parts).toEqual([{ kind: 'lit', text: '', quoted: true }, { kind: 'var', name: 'X' }, { kind: 'lit', text: '/y', quoted: true }]);
    expect(c.words.map(literal)).toEqual(['npm', 'run', 'build']);
    expect(c.redirects.map((r) => [r.op, r.kind, r.write, literal(r.target)])).toEqual([['>', 'file', true, 'out/b.log'], ['>&', 'dup', true, '1'], ['<', 'file', false, 'in.txt']]);
    const [bare] = commands('L=tools/verify.log');
    expect(bare.words).toEqual([]);
    expect(literal(bare.assigns[0].value)).toBe('tools/verify.log');
    expect(commands('echo "exit $?" ${HOME}')[0].words.slice(1).map((w) => w.parts.map((p) => p.kind))).toEqual([['lit', 'status'], ['var']]);
    expect(commands('npm test &> all.log')[0].redirects[0]).toMatchObject({ op: '&>', kind: 'file', write: true });
    expect(commands('wc -l <<< "$X"')[0].redirects[0].kind).toBe('herestring');
  });

  it('says what joins each command to the one before, and which kind of group it is in', () => {
    expect(commands('a && b || c; d | e & f\ng\n\nh').map((c) => c.joined)).toEqual(['', '&&', '||', ';', '|', '&', '\n', '\n']);
    expect(commands('if a; then b && c; else d; fi; e').map((c) => c.joined)).toEqual(['', '', '&&', '', ';']);
    expect(commands('(a; b) && { c; } || for x in 1; do d; done; e').map((c) => c.joined)).toEqual(['', ';', '', '', ';']);
    const groups = (readShell('(a); { b; }; for x in 1 2; do c; done; while d; do $(e); done') ?? []).flatMap((it) => (it.kind === 'open' || it.kind === 'close' ? [`${it.kind} ${it.group}`] : []));
    expect(groups).toEqual(['open sub', 'close sub', 'open brace', 'close brace', 'open loop', 'close loop', 'open loop', 'open sub', 'close sub', 'close loop']);
  });

  it('ends on every input: odd blanks are part of the word, nesting has a limit', () => {
    expect(texts('ls\r\npwd  ')).toEqual(['ls\r', 'pwd']);
    expect(commands('ls \f x\u00a0y')[0].words.map(literal)).toEqual(['ls', '\f', 'x\u00a0y']);
    expect(readShell('for f in a b\r\ndo echo $f\r\ndone\r\n')).toBeNull();  // `do\\r` is no keyword: the loop never opens
    for (const src of ['', ' ', '\n\n', '\ufeffls', '$', '\0', '\ud83d', 'a'.repeat(200_000), 'ls; '.repeat(50_000), '('.repeat(10_000)]) expect(() => readShell(src), JSON.stringify(src.slice(0, 20))).not.toThrow();
    const nested = (n: number) => `echo ${'$('.repeat(n)}ls${')'.repeat(n)}`;
    expect(readShell(nested(30))).not.toBeNull();
    expect(readShell(nested(41))).toBeNull();
    expect(readShell(nested(5000))).toBeNull();
  });

  it('gives up on what it does not follow', () => {
    for (const src of [
      'echo `whoami`', 'echo "a `b` c"', 'cat <(ls)', 'tee >(cat)', 'echo ${X:-y}', 'echo ${#X}', 'echo $((1 + 2))', '((i++))', 'echo $1', 'echo "$@"', "echo $'a\\n'",
      'case $x in a) ls;; esac', '[[ -f a && -f b ]]', 'f() { ls; }', 'function f { ls; }', 'ls |& cat', 'echo "unclosed', "echo 'unclosed", '(ls', 'ls)', 'echo $(ls', '{ ls;', 'for x; do ls; done', 'for ((i=0;i<3;i++)); do ls; done', 'ls \\', 'done', 'do ls', 'for x in a; do ls',
    ]) expect(readShell(src), src).toBeNull();
  });
});
