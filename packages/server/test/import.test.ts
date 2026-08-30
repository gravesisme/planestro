import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataStore } from '../src/store/DataStore.ts';
import { importPrompts, splitBlocks, parseBlock } from '../src/import/promptsImport.ts';
import { makeFixture } from './helpers.ts';

let store: DataStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const EXCERPT = `
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# NON-GAME RELATED EXTRA
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

---

# FABLE 5: NOT SUBMITTED

## FENCED EXAMPLE

An internal tool whose description holds an example file:

\`\`\`
---
id: HH-143
title: Example
---
# Description
inside the fence
\`\`\`

That fence must stay one block.

---
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# COMMON TERMS
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

---

Please perform this work in a new worktree and add that to the plan.

---

Please monitor the PR and once CI is green, go ahead and merge it. If CI fails, please fix the PR and monitor it again to try and merge.

---

------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# NON-GAME RELATED BACKLOG ITEMS GO BELOW HERE
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

---

Website flip to "Available on the App Store" (badge + link, hero copy) → develop → release to main.

---

# FABLE 5: NOT SUBMITTED

## INTERNAL TOOL THING

Please perform this work in a new worktree and add that to the plan.

I want an internal tool with a screenshot at ./tmp/missing-shot.png that helps.

---

------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# [ICEBOX] GAME RELATED BACKLOG ITEMS GO BELOW HERE
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

---

# FABLE 5: NOT SUBMITTED

## IMPROVED ARCANE BLADES ANIMATION

make the arcane blades spin like a cosine wave

---

_NONE_

---

------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
# FINISHED GAME RELATED BACKLOG ITEMS GO BELOW HERE
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

---

# FABLE 5: FINISHED

## SOUNDTRACK SCREEN

Please perform this work in a new worktree and add that to the plan.

Add a soundtrack screen.

---

# OPUS 5: FINISHED

## BUG FIX: HOLD FOR HURRICANE

Fix the hold.

---

##  codex-5.6.sol: FINISHED

## NEW SKILL ICONS

Draw the icons.
`;

describe('prompts-file import', () => {
  it('parses sections, headers, models and bodies', () => {
    const blocks = splitBlocks(EXCERPT);
    expect(blocks.map((b) => b.section)).toContain('COMMON TERMS');
    const finished = blocks.filter((b) => /FINISHED GAME/.test(b.section));
    expect(finished).toHaveLength(3);
    const p = parseBlock(finished[0].text);
    expect(p.title).toBe('SOUNDTRACK SCREEN');
    expect(p.status).toBe('FINISHED');
    expect(p.planner).toBe('fable-5');
    const codex = parseBlock(finished[2].text);
    expect(codex.implementer).toBe('codex-5.6-sol');
    expect(codex.title).toBe('NEW SKILL ICONS');
  });

  it('dry-runs without writing, then imports idempotently with statuses, categories, attachments and estimated dates', async () => {
    const { dataDir } = makeFixture();
    store = await DataStore.open(dataDir);
    const file = join(dataDir, 'LEGACY.md');
    writeFileSync(file, EXCERPT);
    const dry = importPrompts(store, file, { commit: false });
    expect(store.items.size).toBe(0);
    expect(dry.items).toBe(7);
    expect(dry.prompts).toBe(2);
    const real = importPrompts(store, file, { commit: true });
    expect(real.items).toBe(7);
    const fenced = store.listItems().find((i) => i.file.frontmatter.title === 'FENCED EXAMPLE')!;
    expect(fenced.file.frontmatter.category).toBe('Tools');
    expect(fenced.file.sections.find((s) => s.title === 'Description')!.body).toContain('id: HH-143');
    const items = store.listItems().map((i) => i.file.frontmatter);
    const tool = items.find((f) => f.title === 'INTERNAL TOOL THING')!;
    expect(tool.status).toBe('NOT_YET_SUBMITTED');
    expect(tool.category).toBe('Tools');
    expect(tool.attachments[0]).toMatchObject({ kind: 'reference', path: 'tmp/missing-shot.png' });
    expect(store.getItem(tool.id)!.file.sections.find((s) => s.title === 'Description')!.body).not.toContain('new worktree');
    const icebox = items.find((f) => f.title === 'IMPROVED ARCANE BLADES ANIMATION')!;
    expect(icebox.status).toBe('ICEBOX');
    const site = items.find((f) => f.title.startsWith('Website flip'))!;
    expect(site.category).toBe('Marketing Site');
    const finished = items.filter((f) => f.status === 'FINISHED');
    expect(finished).toHaveLength(3);
    expect(finished.every((f) => f.dates_estimated && f.finished_at)).toBe(true);
    // newest-first order of the file preserved in finished_at desc
    const sorted = [...finished].sort((a, b) => (b.finished_at ?? '').localeCompare(a.finished_at ?? ''));
    expect(sorted[0].title).toBe('SOUNDTRACK SCREEN');
    expect(store.getPrompt('monitor-ci-and-merge')).toBeDefined();
    const again = importPrompts(store, file, { commit: true });
    expect(again.items).toBe(0);
    expect(again.skipped).toBeGreaterThan(5);
    expect(store.listItems().length).toBe(7);
  });
});
