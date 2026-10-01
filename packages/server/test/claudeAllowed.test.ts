import { describe, it, expect } from 'vitest';
import { splitAllowed } from '../src/engine/sessions/LiveClaudePort.ts';

describe('allowedTools the SDK sees (#58)', () => {
  it('keeps only rules with a pattern; bare names are approved by canUseTool instead, so the SDK never warns they shadow it', () => {
    const { rules, whole } = splitAllowed(['Read', ' Grep ', 'Bash(git log*)', 'mcp__planestro__report_done', '', 'Bash(gh pr view*)']);
    expect(rules).toEqual(['Bash(git log*)', 'Bash(gh pr view*)']);
    expect([...whole]).toEqual(['Read', 'Grep', 'mcp__planestro__report_done']);
    expect(rules.every((r) => r.includes('('))).toBe(true);   // the SDK's own test for CLAUDE_SDK_CAN_USE_TOOL_SHADOWED
  });
});
