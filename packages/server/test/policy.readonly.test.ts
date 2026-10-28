import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowedByRules, awkProgramPrintsOnly, BASE_ALLOWED, makePolicy, sedScriptPrintsOnly } from '../src/engine/policy.ts';
import { Config } from '@planestro/shared';

const config = () => Config.parse({
  schema_version: 2, tool_version: '0.1.0', project: { name: 'T', id_prefix: 'T' },
  code_repo: { path: '..', default_branch: 'trunk' },
  models: [{ id: 'm', label: 'M', claude_model: 'x' }], defaults: { planner: 'm', implementer: 'm', category: 'C' }, categories: ['C'],
  permissions: { allow: [], deny: [] },
});
const bash = (command: string) => ({ tool: 'Bash', input: { command } });
const wt = '/repo/.claude/worktrees/T-1';
const exists = (p: string) => ['/', '/etc', '/usr', '/Users', '/home', '/Applications'].includes(p);
const allowed = (c: string, rules: string[] = BASE_ALLOWED.implement, readOnly = false) => allowedByRules(bash(c), rules, wt, { exists, readOnly });

describe('read-only commands in the worktree (#503)', () => {
  it('allows what parked HH workers once every part only reads inside the worktree', () => {
    for (const c of [
      `grep -n '"tools/' tools/fixtures/check_impact_policy.json | awk -F: '$1>112' | head -30`,
      `sed -n 627,640p docs/underworld/soul_forge.md; grep -n "^## \\|^### " docs/underworld/soul_forge.md | awk -F: '$1>1960'`,
      `ls -la docs/building_doors docs/building_doors/captures | awk '{print $5, $9}'`,
      `for f in tools/belt_ride_check.gd tools/soul_forge_layout_check.gd; do echo "== $f"; awk '/^<<<<<<< /{p=1} p{print NR": "$0} /^>>>>>>> /{p=0; print "--"}' $f; done`,
      `grep -n '"style": "cable"' -B2 -A30 resources/layouts/x.json | grep -v '^\\s*$' | tr -d ' \\t' | tr '\\n' ' ' | sed 's/"style":"cable"/\\n&/g' | head -20`,
      `cd assets/sprites/underworld && grep size_limit sf_forge_furnace.png.import && sed -n 1,80p ../../../tools/texture_budget_check.gd | grep -n "BUDGET"`,
      `sed -n -e 1,5p -e '/func/=' tools/x.gd`, `sed -nE 's/^const ([A-Z_]+).*/\\1/p' autoload/Config.gd`, `sed ':a;N;$!ba;s/\\n/ /g' f.txt`,
      `awk -v n=3 'NR<=n' f.txt`, `awk -F'\\t' '$2 ~ /x|y/ || $3 > 4 {print $1}' f.tsv`,
    ]) expect(allowed(c), c).toBe(true);
  });

  it('reads git history in a planning turn, where no unscoped git rule stands', () => {
    for (const c of ['git diff --stat', 'git show HEAD:tools/x.py | head', 'git log --oneline -3 -- tools/x.py', 'git status --short', 'git ls-files tools | wc -l', 'git ls-tree --name-only HEAD assets/'])
      expect(allowed(c, BASE_ALLOWED.plan, true), c).toBe(true);
    for (const c of ['git diff --output=d.patch', 'git log --ext-diff -p', 'git show HEAD:x > /tmp/x', 'git diff -C/etc x'])
      expect(allowed(c, BASE_ALLOWED.plan, true), c).toBe(false);
    expect(allowed('git show --ext-diff HEAD', BASE_ALLOWED.plan)).toBe(false);
  });

  it('parks a sed or awk that writes, runs or reads by name', () => {
    for (const c of [
      "sed -i '' s/a/b/ f", 'sed -i.bak s/a/b/ f', 'sed --in-place s/a/b/ f', 'sed -I s/a/b/ f', "sed 's/a/b/w out' f", "sed 's/a/b/e' f", "sed -n 'w out' f",
      "sed '1e touch x' f", "sed 'r /etc/hosts' f", "sed 'R x' f", 'sed -f script.sed f', "sed 's/[/]/x/;w out' f", "sed 's/a/b/;W out' f", "sed '$ a hi' f",
      "awk '{print > \"out\"}' f", "awk '{print $1 >> \"/tmp/x\"}' f", "awk '{printf(\"%s\", $0) > out}' f", "awk '{print | \"sh\"}' f", "awk 'BEGIN{system(\"rm -rf x\")}'",
      "awk '{\"date\" | getline d}' f", "awk 'BEGIN{while ((getline l < \"/etc/passwd\") > 0) print l}'", 'awk -f prog.awk f', "awk -i inplace '{print}' f", "awk '@include \"x\"'",
      "awk '/x/ {print |& \"cat\"}' f", "awk -e 'BEGIN{}' f",
      // A write anywhere in the chain parks it all.
      "grep -n x f | awk '{print $1}'; sed -i s/a/b/ f", "sed -n 1p f && echo x > ../out", "awk '{print}' f; rm -rf build", 'sed -n 1p f > /etc/x', "sed -n 1p f | tee out",
      // Paths still have to stay inside.
      'sed -n 1,5p ../T-2/x', 'awk 1 /etc/passwd', "sed -n 1p ~/notes", 'cd .. && sed -n 1p x', 'grep -l x * | xargs sed -n 1p',
      // A filter given by a variable the command never set, or one that changes what runs.
      'sed "$S" f', "for s in 1p 'w x'; do sed -n \"$s\" f; done", "PATH=/x sed -n 1p f", "SCRIPT=w; sed -n $SCRIPT f",
    ]) expect(allowed(c), c).toBe(false);
  });

  it('reads sed scripts and awk programs by their syntax, not their letters', () => {
    for (const s of ['1,40p', '$p', '/start/,/end/p', '0,/x/d', '1~2p', '/a/,+3p', 's/web/out/g', 's#res://##', 'y/abc/xyz/', '/x/!d', '/a/{p;q}', '\\%a/b%p', 's/\\//x/g', '/x/I,/y/Mp', '=', 's/[]a]/b/'])
      expect(sedScriptPrintsOnly(s), s).toBe(true);
    for (const s of ['w x', 's/a/b/w x', 's/a/b/ew', 'e ls', 'r x', 'a text', 'i text', 'c text', 'F', 's/a/b', '/x', 's/[/]/x/', 'p w', 'v', 'z'])
      expect(sedScriptPrintsOnly(s), s).toBe(false);
    for (const p of ['{print $1}', '$1>625', '/a|b/{print NR": "$0}', 'NR>=84 && NR<=120 { print }', '{ s = $1 > 3 ? "a|b" : "c" }', 'BEGIN{FS=":"} {print $NF}', '$0 ~ /[/]>/ {print}'])
      expect(awkProgramPrintsOnly(p), p).toBe(true);
    for (const p of ['{print > "f"}', '{print $1 > 5}', '{print | "cat"}', '{x = "a"; print x | "sh"}', 'BEGIN{system("x")}', '{getline}', '{close("x")}', '@load "x"', '{ @f() }', '{printf "%s\\n", $0 >> "/tmp/x"}'])
      expect(awkProgramPrintsOnly(p), p).toBe(false);
  });

  it('judges the deny lists before any of it', () => {
        const policy = makePolicy(config(), 'trunk', wt, {}, ['Bash(awk *)']);
    expect(policy.deny(bash("awk '{print}' f"))).toMatch(/awk/);
    expect(policy.deny(bash("sed -i s/a/b/ f"))).toMatch(/Edit or Write/);
  });
});

describe('read-only file tools outside the worktree (#503)', () => {
  const root = mkdtempSync(join(tmpdir(), 'pl503-'));
  const tree = join(root, 'wt');
  mkdirSync(join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'src', 'a.ts'), 'x');
  writeFileSync(join(root, 'crop.png'), 'x');
  symlinkSync('/etc', join(root, 'etc-link'));
  symlinkSync('/etc', join(tree, 'out-link'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tool = (t: string, input: Record<string, unknown>) => allowedByRules({ tool: t, input }, BASE_ALLOWED.implement, tree);

  it('allows Read, Grep and Glob on the worktree and the scratch folders', () => {
    expect(tool('Read', { file_path: join(tree, 'src', 'a.ts') })).toBe(true);
    expect(tool('Read', { file_path: 'src/a.ts' })).toBe(true);
    expect(tool('Read', { file_path: join(root, 'crop.png') })).toBe(true);
    expect(tool('Read', { file_path: '/tmp/hh589/anvil.png' })).toBe(true);
    expect(tool('Grep', { pattern: 'x', path: join(tree, 'src') })).toBe(true);
    expect(tool('Grep', { pattern: 'x' })).toBe(true);
    expect(tool('Glob', { pattern: '**/*.ts' })).toBe(true);
    expect(tool('Glob', { pattern: `${root}/*.png` })).toBe(true);
  });

  it('parks what reaches outside, through .., ~ or a symlink, and every tool that writes', () => {
    expect(tool('Read', { file_path: '/Users/someone/Projects/main/docs/x.md' })).toBe(false);
    expect(tool('Read', { file_path: `${'../'.repeat(40)}etc/hosts` })).toBe(false);
    expect(tool('Read', { file_path: '~/.ssh/id_rsa' })).toBe(false);
    expect(tool('Read', { file_path: join(homedir(), '.zshrc') })).toBe(false);
    expect(tool('Read', { file_path: join(root, 'etc-link', 'hosts') })).toBe(false);
    expect(tool('Read', { file_path: join(tree, 'out-link', 'hosts') })).toBe(false);
    expect(tool('Grep', { pattern: 'x', path: '/etc' })).toBe(false);
    expect(tool('Glob', { pattern: '../**/*.ts' })).toBe(false);
    expect(tool('Glob', { pattern: '/etc/*' })).toBe(false);
    expect(tool('Glob', { pattern: '*', path: '/' })).toBe(false);
    expect(tool('Write', { file_path: join(tree, 'x') })).toBe(false);
    expect(tool('Edit', { file_path: '/tmp/x' })).toBe(false);
    // Without the worktree nothing is judged by place.
    expect(allowedByRules({ tool: 'Read', input: { file_path: '/tmp/x' } }, BASE_ALLOWED.implement)).toBe(false);
  });

  it('leaves the secret deny list first', () => {
        const policy = makePolicy(config(), 'trunk', tree);
    expect(policy.deny({ tool: 'Read', input: { file_path: join(tree, '.env') } })).toBeTruthy();
  });
});
