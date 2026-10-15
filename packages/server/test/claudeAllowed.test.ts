import { describe, it, expect } from 'vitest';
import { customAllowedTools, RanWatch, splitAllowed } from '../src/engine/sessions/LiveClaudePort.ts';

describe('allowedTools the SDK sees (#58)', () => {
  it('keeps only rules with a pattern; bare names are approved by canUseTool instead, so the SDK never warns they shadow it', () => {
    const { rules, whole } = splitAllowed(['Read', ' Grep ', 'Bash(git log*)', 'mcp__planestro__report_done', '', 'Bash(gh pr view*)']);
    expect(rules).toEqual(['Bash(git log*)', 'Bash(gh pr view*)']);
    expect([...whole]).toEqual(['Read', 'Grep', 'mcp__planestro__report_done']);
    expect(rules.every((r) => r.includes('('))).toBe(true);   // the SDK's own test for CLAUDE_SDK_CAN_USE_TOOL_SHADOWED
  });

  it('a dontAsk custom turn (the orchestrator) lists every tool it may use, since canUseTool is never consulted there (#153)', () => {
    const mcpTools = [{ name: 'read_item' }, { name: 'approve_plan' }, { name: 'done_with_wake' }] as any;
    const orch = customAllowedTools({ permissionMode: 'dontAsk', allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git log*)'], mcpTools });
    for (const t of ['Read', 'Grep', 'Glob', 'Bash(git log*)', 'mcp__planestro__read_item', 'mcp__planestro__approve_plan', 'mcp__planestro__done_with_wake']) expect(orch, t).toContain(t);
    // a mode that does consult the callback keeps #58's split
    expect(customAllowedTools({ permissionMode: 'default', allowedTools: ['Read', 'Bash(git log*)'], mcpTools })).toEqual(['Bash(git log*)']);
  });
});

describe('what ran without a park (#203)', () => {
  const sig = { signal: new AbortController().signal };
  it('counts each tool call that ran, by command for Bash, and leaves out what was refused, parked or interrupted', async () => {
    const w = new RanWatch();
    const post = (id: string, tool_name: string, tool_input: unknown, event = 'PostToolUse', extra = {}) => w.hook()({ hook_event_name: event, tool_name, tool_input, tool_use_id: id, ...extra } as any, id, sig);
    expect(await post('1', 'Bash', { command: 'npm test ' })).toEqual({ continue: true });
    await post('2', 'Bash', { command: 'npm test' });
    await post('3', 'Bash', { command: 'npm run lint' }, 'PostToolUseFailure', { error: 'exit 1' });
    await post('4', 'Read', { file_path: 'a.ts' });
    await post('5', 'mcp__planestro__add_note', {});
    w.refused('6'); await post('6', 'Bash', { command: 'node -e 1' }, 'PostToolUseFailure', { error: 'denied' });
    await post('7', 'Bash', { command: 'sleep 99' }, 'PostToolUseFailure', { error: 'x', is_interrupt: true });
    await post('8', 'Bash', {}, 'PreToolUse');
    expect(w.list()).toEqual([{ tool: 'Bash', command: 'npm test', n: 2 }, { tool: 'Bash', command: 'npm run lint', n: 1 }, { tool: 'Read', n: 1 }]);
  });

  it('tells each Bash command that ran as it ends, with its exit and wall time, for the test-run record (#347)', async () => {
    const heard: { command: string; ok: boolean; ms: number }[] = [];
    const w = new RanWatch((r) => heard.push(r));
    const call = (h: ReturnType<RanWatch['hook']>, id: string, event: string, command: string, extra = {}) => h({ hook_event_name: event, tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...extra } as any, id, sig);
    await call(w.started(), '1', 'PreToolUse', 'npm test');
    await call(w.hook(), '1', 'PostToolUse', 'npm test');
    await call(w.started(), '2', 'PreToolUse', 'npm test');
    await call(w.hook(), '2', 'PostToolUseFailure', 'npm test', { error: 'exit 1' });
    w.refused('3'); await call(w.hook(), '3', 'PostToolUseFailure', 'npm test', { error: 'denied' });
    expect(heard.map((r) => [r.command, r.ok])).toEqual([['npm test', true], ['npm test', false]]);
    expect(heard.every((r) => r.ms >= 0)).toBe(true);
  });
});
