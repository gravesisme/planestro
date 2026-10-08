import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSkills, skillText } from '../src/engine/sessions/projectSkills.ts';
import { writeSkillsFixture } from './skillsFixture.ts';

const roots: string[] = [];
afterEach(() => { roots.forEach((p) => rmSync(p, { recursive: true, force: true })); roots.length = 0; });
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'planestro-skills-')); roots.push(d); return d; };

it("reads the worktree's .claude/skills, drops Claude-only fields and says which a Codex worker cannot use (#238)", () => {
  const cwd = dir(); writeSkillsFixture(cwd);
  const skills = projectSkills(cwd);
  expect(skills.map((s) => s.name)).toEqual(['deploy', 'release-notes']);
  const notes = skills.find((s) => s.name === 'release-notes')!;
  expect(notes).toMatchObject({ description: 'Write the release notes section', dir: join(cwd, '.claude', 'skills', 'release-notes') });
  expect(notes.unusable).toBeUndefined();
  expect(notes.dropped).toEqual(['allowed-tools', 'model', 'context']);
  const text = skillText(notes);
  expect(text).toMatch(/^---\nname: release-notes\ndescription: Write the release notes section\n---\n/);
  expect(text).toContain(`fill in ${join(notes.dir, 'template.md')}`);
  expect(text).not.toMatch(/allowed-tools|claude-opus-4|context: fork/);
  expect(skills.find((s) => s.name === 'deploy')!.unusable).toMatch(/person/);
});
it('a project without skills has none; an unreadable one is listed as unusable, never thrown (#238)', () => {
  expect(projectSkills(dir())).toEqual([]);
  const cwd = dir(); mkdirSync(join(cwd, '.claude', 'skills', 'broken'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'skills', 'broken', 'SKILL.md'), '---\nname: [unclosed\n---\nbody');
  mkdirSync(join(cwd, '.claude', 'skills', 'empty-dir'), { recursive: true });
  const skills = projectSkills(cwd);
  expect(skills.map((s) => s.name)).toEqual(['broken']);
  expect(skills[0].unusable).toMatch(/frontmatter/);
});
