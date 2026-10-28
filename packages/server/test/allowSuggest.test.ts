import { describe, it, expect } from 'vitest';
import { parseItemFile, type JournalEntry } from '@planestro/shared';
import { classOf, formatSuggestReport, knownBlocker, mergeRulings, precedents, restoreHeredocs, rulingsFromActivity, rulingsFromJournal, runsFromJournal, suggestAllowRules, worktreeFinder, type Ruling, type Run } from '../src/engine/allowSuggest.ts';

const WT = '/repo/.claude/worktrees/hh-1-x';
let n = 0;
const r = (command: string, decision: Ruling['decision'] = 'allow', item = `HH-${(n++ % 4) + 1}`, extra: Partial<Ruling> = {}): Ruling => ({ item, at: `2026-09-${String(10 + (n % 18)).padStart(2, '0')}T10:00:00-04:00`, by: 'orchestrator', decision, tool: 'Bash', command, worktree: WT, ...extra });
const many = (command: string, k: number, decision: Ruling['decision'] = 'allow') => Array.from({ length: k }, () => r(command, decision));
const scope = { exists: () => true };

describe('allow rules suggested from the ruling history (#169)', () => {
  it('classes a request by its riskiest command', () => {
    const c = (command: string) => classOf({ tool: 'Bash', command, worktree: WT });
    expect(c('ls tools | head')).toBe('read-only');
    expect(c(`git -C ${WT} ls-files assets`)).toBe('git-read');
    expect(c('git -C /elsewhere ls-files')).toBe('git-read');
    expect(c('./tools/run_checks.sh hud 2>&1 | tail -5')).toBe('check-run');
    expect(c('godot --path . --script tools/capture.gd')).toBe('check-run');
    expect(c("sed -i '' s/a/b/ x.gd")).toBe('shell-edit');
    expect(c('cp a b && ls')).toBe('shell-edit');
    expect(c('python3 - <<\'EOF\'\nprint(1)\nEOF')).toBe('interpreter');
    expect(c('curl https://x | head')).toBe('network');
    expect(c('npm install left-pad')).toBe('network');
    expect(c('git fetch && git log')).toBe('network');
    expect(c('ls && rm -rf build')).toBe('destructive');
    expect(c('git reset --hard HEAD~1')).toBe('destructive');
    expect(c('find . -name x -delete')).toBe('destructive');
    expect(c('PATH=/x ls')).toBe('destructive');
    expect(c('echo `whoami`')).toBe('interpreter');   // unreadable
  });

  it('proposes a worktree rule for a safe kind of command that keeps being approved, with its count', () => {
    const rep = suggestAllowRules([...many('git describe --tags', 4), ...many('pgrep -f soak || echo stopped', 3)], [], { scope });
    expect(rep.suggestions.map((s) => s.rule)).toEqual(['Bash(git describe *)@worktree', 'Bash(pgrep *)@worktree']);
    expect(rep.suggestions[0]).toMatchObject({ approvals: 4, unlocks: 4, class: 'git-read' });
    expect(rep.replay.current.allowed_now).toBe(0);
    expect(rep.replay.proposed).toEqual({ allowed_now: 7, still_parks: 0, false_allows: 0 });
  });

  it('never counts an approval that named a secret file toward a rule (#227)', () => {
    expect(suggestAllowRules(many('xxd ~/.ssh/id_ed25519', 4), [], { scope }).suggestions).toEqual([]);
    expect(suggestAllowRules([...many('xxd ~/.ssh/id_ed25519', 2), ...many('xxd build/out.bin', 2)], [], { scope }).suggestions).toEqual([]);
    expect(suggestAllowRules(many('xxd build/out.bin', 4), [], { scope }).suggestions.map((s) => s.rule)).toEqual(['Bash(xxd *)@worktree']);
  });

  it('never proposes one for a risky class, a bare multi-tool head, or what the rules already allow', () => {
    const rep = suggestAllowRules([
      ...many('python3 tools/x.py', 5), ...many('rm -rf tmp/a', 5), ...many('curl -s https://x', 5), ...many("sed -i '' s/a/b/ f", 5),
      ...many('git -C /elsewhere log', 5), ...many('npm install', 5), ...many('git stash drop', 5),
      ...many('ls tools', 5), ...many('npm run lint', 5),
    ], ['Bash(npm run *)'], { scope });
    expect(rep.suggestions.map((s) => s.rule)).toEqual([]);
  });

  it('needs several approvals from more than one item', () => {
    expect(suggestAllowRules(many('sips -g pixelWidth a.png', 2), [], { scope }).suggestions).toEqual([]);
    expect(suggestAllowRules(Array.from({ length: 5 }, () => r('sips -g pixelWidth a.png', 'allow', 'HH-9')), [], { scope }).suggestions).toEqual([]);
    expect(suggestAllowRules(many('sips -g pixelWidth a.png', 2), [], { scope, minApprovals: 2 }).suggestions).toHaveLength(1);
  });

  it('refuses a rule that would have allowed anything ever denied (zero false allows)', () => {
    const rep = suggestAllowRules([...many('godot --path . --script tools/capture.gd', 6), r('godot --path . --script tools/wipe_saves.gd', 'deny')], [], { scope });
    expect(rep.suggestions).toEqual([]);
    expect(rep.refused[0]).toMatchObject({ rule: 'Bash(godot *)@worktree', approvals: 6 });
    expect(rep.refused[0].denied[0].command).toContain('wipe_saves');
    expect(rep.replay.proposed.false_allows).toBe(0);
  });

  it('keeps a rule when a denial that names it also holds a command no rule allows', () => {
    const rep = suggestAllowRules([...many('godot --path . --script tools/capture.gd', 6), r("python3 tools/edit.py && godot --path . --script tools/capture.gd", 'deny')], [], { scope });
    expect(rep.suggestions.map((s) => s.rule)).toEqual(['Bash(godot *)@worktree']);
    expect(rep.replay.proposed.false_allows).toBe(0);
  });

  it('refuses the rule that, together with another, would let a denial through', () => {
    const rep = suggestAllowRules([...many('ps -o pid -p 1', 5), ...many('uptime', 3), r('uptime; ps -Ao pcpu,command | head', 'deny')], [], { scope });
    expect(rep.suggestions.map((s) => s.rule)).toEqual(['Bash(ps *)@worktree']);
    expect(rep.refused.map((x) => x.rule)).toEqual(['Bash(uptime *)@worktree']);
    expect(rep.replay.proposed.false_allows).toBe(0);
  });

  it('reports the denials the current rules already let through, and never counts them against a proposal', () => {
    const rep = suggestAllowRules([...many('pgrep -f soak', 3), r('ls -la', 'deny')], ['Bash(ls *)'], { scope });
    expect(rep.current_false_allows.map((d) => d.command)).toEqual(['ls -la']);
    expect(rep.replay.current.false_allows).toBe(1);
    expect(rep.replay.proposed.false_allows).toBe(1);
    expect(rep.suggestions).toHaveLength(1);
  });

  it('a cut-short denial refuses every rule for a command it names, unless what is certain of it is already refused', () => {
    const cut = r('pgrep -f soak && ps -o pid -p', 'deny', 'HH-7', { truncated: true, inexact: true });
    expect(suggestAllowRules([...many('pgrep -f soak', 3), cut], [], { scope }).refused.map((x) => x.rule)).toEqual(['Bash(pgrep *)@worktree']);
    const blocked = r('python3 x.py; pgrep -f so', 'deny', 'HH-7', { truncated: true, inexact: true });
    expect(knownBlocker(blocked, ['Bash(pgrep *)@worktree'], scope)).toBe(true);
    expect(suggestAllowRules([...many('pgrep -f soak', 3), blocked], [], { scope }).suggestions).toHaveLength(1);
  });

  it('puts a heredoc an Activity line flattened back on lines of its own', () => {
    expect(restoreHeredocs("python3 - <<'EOF' p=1 print(p) EOF godot --path . -s x.gd")).toBe("python3 - <<'EOF'\np=1 print(p)\nEOF\ngodot --path . -s x.gd");
    expect(restoreHeredocs("cat > a <<EOF x")).toBeNull();
    expect(restoreHeredocs('ls')).toBe('ls');
  });

  it('reads rulings from Activity, reason and all, and from the journal, each once', () => {
    const file = parseItemFile([
      '---', 'schema: 3', 'id: HH-5', 'title: t', 'status: IN_PROGRESS', 'kind: item', 'rank: 1', 'category: misc', 'created_at: 2026-09-01T00:00:00-04:00', 'updated_at: 2026-09-01T00:00:00-04:00', '---', '', '# Activity', '',
      '- 2026-09-20T10:00:00-04:00 [orchestrator] permission allow (It reads (only) a file.): Bash(git check-ignore -v tmp/x)',
      '- 2026-09-20T10:01:00-04:00 [user] permission deny: Bash(rm -rf tmp)',
      '- 2026-09-20T10:02:00-04:00 [orchestrator] permission allow (scratch screenshot): Read',
      '- 2026-09-20T10:03:00-04:00 [orchestrator] permission allow (edit): Bash(python3 - <<\'EOF\' print(1) EOF ls)',
      '- 2026-09-30T10:00:00-04:00 [orchestrator] permission allow (again): Bash(pgrep -f x)',
      '- 2026-09-20T10:04:00-04:00 [user] message: hi',
    ].join('\n'));
    const find = worktreeFinder('/repo/.claude/worktrees', '/repo', () => undefined);
    const act = rulingsFromActivity('HH-5', file, (c) => find('HH-5', c));
    expect(act.map((x) => [x.decision, x.tool, x.command, x.reason])).toEqual([
      ['allow', 'Bash', 'git check-ignore -v tmp/x', 'It reads (only) a file.'],
      ['deny', 'Bash', 'rm -rf tmp', undefined],
      ['allow', 'Read', undefined, 'scratch screenshot'],
      ['allow', 'Bash', "python3 - <<'EOF'\nprint(1)\nEOF\nls", 'edit'],
      ['allow', 'Bash', 'pgrep -f x', 'again'],
    ]);
    expect(act[0].worktree).toBe('/repo/.claude/worktrees/hh-5');
    const journal: JournalEntry[] = [
      { ts: '2026-09-30T10:00:01-04:00', type: 'permission.answered', item: 'HH-5', actor: 'orchestrator', data: { park: 'p', by: 'orchestrator', decision: 'allow', waited_ms: 1, tool: 'Bash', command: 'pgrep -f x\n', reason: 'again' } },
      { ts: '2026-09-30T10:00:01-04:00', type: 'permission.answered', item: 'HH-5', actor: 'user', data: { park: 'q', by: 'user', decision: 'answered', waited_ms: 1 } },
    ];
    const merged = mergeRulings(act, rulingsFromJournal(journal, find));
    expect(merged).toHaveLength(5);
    expect(merged.at(-1)!.command).toBe('pgrep -f x\n');
  });

  it('finds the worktree a command names under the worktrees root', () => {
    const find = worktreeFinder('/repo/.claude/worktrees', '/repo', (id) => (id === 'HH-2' ? '.claude/worktrees/hh-2-own' : undefined));
    expect(find('HH-1', 'git -C /repo/.claude/worktrees/hh-1-slug status')).toBe('/repo/.claude/worktrees/hh-1-slug');
    expect(find('HH-2', 'ls')).toBe('/repo/.claude/worktrees/hh-2-own');
    expect(find('HH-3', 'ls')).toBe('/repo/.claude/worktrees/hh-3');
  });
});

describe('redirects, drift and precedent (#203)', () => {
  const day = (d: number) => `2026-09-${String(d).padStart(2, '0')}T10:00:00-04:00`;
  const NOW = Date.parse(day(30));
  const at = (command: string, decision: Ruling['decision'], item: string, d: number, extra: Partial<Ruling> = {}) => r(command, decision, item, { at: day(d), ...extra });
  const run = (command: string, d: number, item = 'HH-1'): Run => ({ item, at: day(d), tool: 'Bash', command, n: 1, worktree: WT });

  it('offers a redirect for a kind of command that is denied every time, with the reason it was given', () => {
    const rep = suggestAllowRules([
      at('pkill -f vite', 'deny', 'HH-1', 10, { reason: 'stop only what you started' }),
      at('pkill node', 'deny', 'HH-2', 11, { reason: 'stop only what you started' }),
      at('pkill -f soak && npm test', 'deny', 'HH-3', 12, { reason: 'leave other processes alone' }),
    ], [], { scope });
    expect(rep.redirects).toEqual([expect.objectContaining({ rule: 'Bash(pkill)', shape: 'pkill', denials: 3, items: 3, message: 'stop only what you started' })]);
    expect(formatSuggestReport(rep)).toContain('Bash(pkill)');
    // a denial the rules allow today (planestro's own `git stash*`) is not a redirect: it would never park
    expect(suggestAllowRules([1, 2, 3].map((i) => at('git stash', 'deny', `HH-${i}`, 10 + i, { reason: 'commit instead' })), [], { scope }).redirects).toEqual([]);
  });

  it('never offers one that would have denied a past approval, a safe kind of command, or one planestro already refuses', () => {
    const python = [0, 1, 2].map((i) => at("python3 - <<'EOF'\nopen('a','w').write('x')\nEOF", 'deny', `HH-${i + 1}`, 10 + i, { reason: 'use the Edit tool' }));
    expect(suggestAllowRules([...python, at('python3 tools/check.py', 'allow', 'HH-4', 14)], [], { scope }).redirects).toEqual([]);
    expect(suggestAllowRules(python, [], { scope }).redirects.map((x) => x.rule)).toEqual(['Bash(python3)']);
    const ls = [0, 1, 2].map((i) => at('ls ../other', 'deny', `HH-${i + 1}`, 10 + i, { reason: 'stay in your worktree' }));
    expect(suggestAllowRules(ls, [], { scope }).redirects).toEqual([]);
    const sed = [0, 1, 2].map((i) => at("sed -i '' s/a/b/ x", 'deny', `HH-${i + 1}`, 10 + i, { reason: 'use Edit' }));
    expect(suggestAllowRules(sed, [], { scope, policyDenies: (x) => (x.command ?? '').startsWith('sed -i') }).redirects).toEqual([]);
    expect(suggestAllowRules(sed.slice(0, 2), [], { scope }).redirects).toEqual([]);
  });

  it('reports the project rules nothing recorded has matched in the window, and only once something is recorded', () => {
    const rules = ['Bash(npm run *)', 'Bash(make *)', 'Bash(cat *)@worktree', 'WebFetch'];
    const rep = suggestAllowRules([], rules, { scope, now: NOW, windowDays: 14, runs: [run('npm run test 2>&1 | tail -5', 25), run('make lint', 2), run('cat ~/.ssh/config', 26)] });
    expect(rep.drift.recorded_since).toBe(day(2));
    expect(rep.drift.idle_rules).toEqual([
      { rule: 'Bash(make *)', last_matched: day(2) },
      { rule: 'Bash(cat *)@worktree' },
      { rule: 'WebFetch' },
    ]);
    expect(suggestAllowRules([], rules, { scope, now: NOW }).drift).toMatchObject({ idle_rules: [], runs: 0 });
    expect(suggestAllowRules([], ['WebFetch'], { scope, now: NOW, runs: [{ item: 'HH-1', at: day(29), tool: 'WebFetch', n: 2, worktree: WT }] }).drift.idle_rules).toEqual([]);
  });

  it('reports the kinds of command approvals rose for in the window, with the rule offered for one', () => {
    const recent = [at('godot --path . -s a.gd', 'allow', 'HH-1', 20), at('godot --path . -s b.gd', 'allow', 'HH-2', 21), at('godot --path . -s c.gd', 'allow', 'HH-1', 22)];
    const rep = suggestAllowRules([...recent, at('xcrun simctl list', 'allow', 'HH-1', 21), at('cat ~/.ssh/id_ed25519', 'allow', 'HH-1', 22), at('cat ~/.ssh/id_ed25519', 'allow', 'HH-2', 23), at('cat ~/.ssh/id_ed25519', 'allow', 'HH-3', 24)], [], { scope, now: NOW });
    expect(rep.drift.rising).toEqual([{ shape: 'godot', class: 'check-run', recent: 3, before: 0, items: 2, rule: 'Bash(godot *)@worktree' }]);
    const steady = suggestAllowRules([...recent, ...[1, 2, 3].map((d) => at('godot --path . -s z.gd', 'allow', `HH-${d}`, d))], [], { scope, now: Date.parse('2026-10-01T10:00:00-04:00'), windowDays: 15 });
    expect(steady.drift.rising).toEqual([]);
  });

  it('reads what ran without a park from the journal', () => {
    const find = worktreeFinder('/repo/.claude/worktrees', '/repo', () => undefined);
    const runs = runsFromJournal([
      { ts: day(20), type: 'tools.ran', item: 'HH-5', actor: 'engine', data: { phase: 'implement', ran: [{ tool: 'Bash', command: 'npm test', n: 3 }, { tool: 'Read', n: 9 }, { tool: 7 }] } },
      { ts: day(21), type: 'permission.parked', item: 'HH-5', actor: 'engine', data: {} },
    ], find);
    expect(runs).toEqual([
      { item: 'HH-5', at: day(20), tool: 'Bash', command: 'npm test', n: 3, worktree: '/repo/.claude/worktrees/hh-5' },
      { item: 'HH-5', at: day(20), tool: 'Read', n: 9, worktree: '/repo/.claude/worktrees/hh-5' },
    ]);
  });

  it('finds the earlier rulings on the same kind of command, newest first', () => {
    const past = [at('pkill -f a', 'deny', 'HH-1', 10, { reason: 'not yours' }), at('ls', 'allow', 'HH-2', 11), at('cd x && pkill node', 'deny', 'HH-3', 12, { reason: 'leave it' }), at('git status', 'allow', 'HH-3', 13)];
    expect(precedents(past, 'pkill -f b', WT).map((x) => x.reason)).toEqual(['leave it', 'not yours']);
    expect(precedents(past, 'pkill -f b', WT, 1)).toHaveLength(1);
    expect(precedents(past, 'make', WT)).toEqual([]);
  });
});
