import { describe, it, expect } from 'vitest';
import { DEBUG_BEGIN, DEBUG_END, DEBUG_MARKER, debugMarkerRefusal } from '../src/debugMarkers.ts';

describe('debug instrumentation markers (#240)', () => {
  it('are one project-neutral token that sits inside any comment syntax', () => {
    expect(DEBUG_BEGIN.startsWith(DEBUG_MARKER)).toBe(true);
    expect(DEBUG_END.startsWith(DEBUG_MARKER)).toBe(true);
    for (const line of [`// ${DEBUG_BEGIN}`, `# ${DEBUG_END}`, `<!-- ${DEBUG_BEGIN} -->`, `-- ${DEBUG_END}`, `/* ${DEBUG_BEGIN} */`]) expect(line).toContain(DEBUG_MARKER);
  });

  it('refuses in words, naming each file and line, and takes nothing when none remain', () => {
    expect(debugMarkerRefusal([], 'trunk')).toBeUndefined();
    const said = debugMarkerRefusal([
      { path: 'src/a.ts', line: 2, text: `  // ${DEBUG_BEGIN}` },
      { path: 'src/a.ts', line: 4, text: `  // ${DEBUG_END}` },
      { path: 'scripts/b.py', line: 10, text: `# ${DEBUG_BEGIN}` },
    ], 'trunk')!;
    expect(said).toMatch(/^Rejected:/);
    expect(said).toContain('src/a.ts:2');
    expect(said).toContain('src/a.ts:4');
    expect(said).toContain('scripts/b.py:10');
    expect(said).toContain('trunk');
    expect(said).toMatch(/call report_done again/);
    expect(said).toMatch(/Nothing was recorded/);
  });

  it('names at most a screenful of lines, and says how many more', () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({ path: 'a.ts', line: i + 1, text: `// ${DEBUG_BEGIN}` }));
    const said = debugMarkerRefusal(hits, 'trunk')!;
    expect(said).toContain('a.ts:20');
    expect(said).not.toContain('a.ts:21 ');
    expect(said).toMatch(/10 more/);
  });
});
