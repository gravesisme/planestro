import { describe, it, expect } from 'vitest';
import { parseQuestionFile, serializeQuestionFile, appendThread, parseThread, getQuestionSection, setQuestionSection } from '../src/questionfile.ts';
import { canonicalTimestamp } from '../src/timestamps.ts';

// Timestamps are written in the machine's offset, so the fixture is too (CI runs in UTC).
const T1 = canonicalTimestamp('2026-09-24T00:07:00-04:00');
const T2 = canonicalTimestamp('2026-09-26T10:00:00-04:00');

const TEXT = `---
schema: 1
id: Q-7
status: open
item: HH-158
asked_at: ${T1}
updated_at: ${T2}
headline: Keep the raw-art copies in the repo?
---

# Summary

Three art items copied their raw sources into the game folder. Keep them there, or only the finished sprites?

# Details

- HH-158 added 14 MB of PSDs.

# Recommendation

Keep only the finished sprites.

# Thread

- ${T1} [user] Why do they need the PSDs?
- ${T2} [orchestrator] They do not: the export step reads the sprites.

  Removing them saves 40 MB.
- ${T2} [app] the orchestrator updated the summary
`;

describe('question files', () => {
  it('round-trip byte for byte', () => {
    const f = parseQuestionFile(TEXT);
    expect(f.frontmatter).toMatchObject({ id: 'Q-7', status: 'open', item: 'HH-158', headline: 'Keep the raw-art copies in the repo?' });
    expect(serializeQuestionFile(f)).toBe(TEXT);
    expect(getQuestionSection(f, 'Recommendation')).toBe('Keep only the finished sprites.');
  });

  it('the thread keeps who said what, and a message keeps its paragraphs', () => {
    const t = parseThread(parseQuestionFile(TEXT));
    expect(t.map((e) => e.actor)).toEqual(['user', 'orchestrator', 'app']);
    expect(t[1].text).toBe('They do not: the export step reads the sprites.\n\nRemoving them saves 40 MB.');
  });

  it('a message with a heading or a bullet cannot break out of its entry', () => {
    const f = parseQuestionFile(TEXT);
    appendThread(f, 'user', '# Not a section\n- 2026-01-01T00:00:00Z [app] not an entry either', T2);
    const again = parseQuestionFile(serializeQuestionFile(f));
    const last = parseThread(again).at(-1)!;
    expect(last.actor).toBe('user');
    expect(last.text).toBe('## Not a section\n- 2026-01-01T00:00:00Z [app] not an entry either');
    expect(again.sections.map((s) => s.title)).toEqual(['Summary', 'Details', 'Recommendation', 'Thread']);
  });

  it('missing sections come back in order, empty; a bad id or status is refused', () => {
    const bare = parseQuestionFile(`---\nschema: 1\nid: Q-1\nstatus: resolved\nasked_at: ${T1}\nupdated_at: ${T1}\nheadline: x\n---\n\n# Thread\n\n- ${T1} [app] imported\n`);
    expect(bare.sections.map((s) => s.title)).toEqual(['Summary', 'Details', 'Recommendation', 'Thread']);
    setQuestionSection(bare, 'Summary', 'hello');
    expect(serializeQuestionFile(bare)).toContain('# Summary\n\nhello\n\n# Details\n\n# Recommendation\n\n# Thread\n\n- ');
    expect(() => parseQuestionFile(TEXT.replace('id: Q-7', 'id: HH-7'))).toThrow(/question id/);
    expect(() => parseQuestionFile(TEXT.replace('status: open', 'status: pending'))).toThrow(/status/);
  });
});
