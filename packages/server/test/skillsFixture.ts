import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** A worktree (a git repo, committed) holding two project skills: one Codex can use, one only a person starts (#238). */
export function writeSkillsFixture(cwd: string): void {
  const skill = (name: string, text: string) => { mkdirSync(join(cwd, '.claude', 'skills', name), { recursive: true }); writeFileSync(join(cwd, '.claude', 'skills', name, 'SKILL.md'), text); };
  skill('release-notes', '---\nname: release-notes\ndescription: Write the release notes section\nallowed-tools: Bash(git log:*), Read\nmodel: claude-opus-4\ncontext: fork\n---\n\nSteps for the notes: fill in ${CLAUDE_SKILL_DIR}/template.md from `git log`.\n');
  writeFileSync(join(cwd, '.claude', 'skills', 'release-notes', 'template.md'), '# Notes\n');
  skill('deploy', '---\nname: deploy\ndescription: Deploy to production\ndisable-model-invocation: true\n---\n\nRun me by hand.\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-q', '-m', 'skills');
}
