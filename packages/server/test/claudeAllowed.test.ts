import { describe, it, expect } from 'vitest';
import { customAllowedTools, splitAllowed } from '../src/engine/sessions/LiveClaudePort.ts';

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
