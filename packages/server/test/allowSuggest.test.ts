import { describe, it, expect } from 'vitest';
import { parseItemFile, type JournalEntry } from '@planestro/shared';
import { classOf, knownBlocker, mergeRulings, restoreHeredocs, rulingsFromActivity, rulingsFromJournal, suggestAllowRules, worktreeFinder, type Ruling } from '../src/engine/allowSuggest.ts';

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
    const rep = suggestAllowRules([...many('git check-ignore -v tmp/x', 4), ...many('pgrep -f soak || echo stopped', 3)], [], { scope });
    expect(rep.suggestions.map((s) => s.rule)).toEqual(['Bash(git check-ignore *)@worktree', 'Bash(pgrep *)@worktree']);
    expect(rep.suggestions[0]).toMatchObject({ approvals: 4, unlocks: 4, class: 'git-read' });
    expect(rep.replay.current.allowed_now).toBe(0);
    expect(rep.replay.proposed).toEqual({ allowed_now: 7, still_parks: 0, false_allows: 0 });
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
