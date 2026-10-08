import { describe, it, expect } from 'vitest';
import { filterPattern, findWorkflow, prSkippedByPaths, namedInLog } from '../src/engine/ciFilters.ts';

const HH = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [develop, main, 'feature/**']
    types: [opened, synchronize, reopened, ready_for_review]
    paths-ignore:
      - '**.md'
      - 'docs/**'
`;

describe('CI path filters (HH-324)', () => {
  it("reads GitHub's glob rules: ** crosses directories, * does not", () => {
    expect(filterPattern('**.md').test('docs/surface_update/city/design.md')).toBe(true);
    expect(filterPattern('**.md').test('README.md')).toBe(true);
    expect(filterPattern('*.md').test('docs/a.md')).toBe(false);
    expect(filterPattern('docs/**').test('docs/a/b.png')).toBe(true);
    expect(filterPattern('**/tests/*.gd').test('scripts/tests/a.gd')).toBe(true);
    expect(filterPattern('**/tests/*.gd').test('tests/a.gd')).toBe(true);
  });

  it("HH's ci.yml runs nothing for a docs-only PR, and runs for one that also touches code", () => {
    const wf = findWorkflow([{ path: '.github/workflows/cache.yml', text: 'name: Cache\non: push\n' }, { path: '.github/workflows/ci.yml', text: HH }], 'CI')!;
    expect(wf.path).toBe('.github/workflows/ci.yml');
    expect(prSkippedByPaths(wf.doc, ['docs/surface_update/city/design.md'])).toBe("every changed file matches its paths-ignore (**.md, docs/**)");
    expect(prSkippedByPaths(wf.doc, ['docs/x.md', 'scripts/game.gd'])).toBeNull();
    expect(prSkippedByPaths(wf.doc, Array.from({ length: 300 }, (_, i) => `docs/${i}.md`))).toBeNull();   // past 300 files GitHub always runs
  });

  it('paths: only a change that matches runs it; ! negates, the last match decides; no filters, no pull_request: it runs', () => {
    const doc = { on: { pull_request: { paths: ['src/**', '!src/**/*.md'] } } };
    expect(prSkippedByPaths(doc, ['src/a.ts'])).toBeNull();
    expect(prSkippedByPaths(doc, ['src/notes.md', 'README.md'])).toMatch(/no changed file matches its paths/);
    expect(prSkippedByPaths({ on: { pull_request: {} } }, ['docs/a.md'])).toBeNull();
    expect(prSkippedByPaths({ on: ['push', 'pull_request'] }, ['docs/a.md'])).toBeNull();
    expect(prSkippedByPaths({ on: { push: {} } }, ['docs/a.md'])).toBeNull();
  });
});

describe('namedInLog: the files a failed run names (#204)', () => {
  it('matches a path, a file name, or a long stem standing alone', () => {
    const log = 'mine_cart_check: failure\nFAIL checks/mine_cart_check.gd:42\nError in util.ts';
    expect(namedInLog(log, 'checks/mine_cart_check.gd')).toBe(true);
    expect(namedInLog('job mine_cart_check failed', 'checks/mine_cart_check.gd')).toBe(true);
    expect(namedInLog(log, 'src/util.ts')).toBe(true);
  });
  it('does not match a short stem, a longer name that contains it, or the same name in another directory', () => {
    expect(namedInLog('the config was wrong', 'src/config.ts')).toBe(false);
    expect(namedInLog('FAIL checks/mine_cart_check_extra.gd', 'checks/mine_cart_check.gd')).toBe(false);
    expect(namedInLog('FAIL other/mine_cart_check.gd:1', 'checks/mine_cart_check.gd')).toBe(false);
  });
});
