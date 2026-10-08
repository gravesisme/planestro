import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { CustomToolDef } from '../ports.ts';

/**
 * A project's `.claude/skills` for a Codex worker (#238). Claude loads them itself (settingSources: project); Codex
 * runs from one shared isolated home with host skill discovery off, so they are read from the worktree here and
 * delivered through the turn: an index and `read_skill` on app-server, the text in the prompt on exec. Nothing is
 * written anywhere: concurrent sessions share the home, and a copy in the worktree could be committed.
 */
export interface ProjectSkill {
  name: string;
  description: string;
  /** The skill's folder: what `${CLAUDE_SKILL_DIR}` names, where its other files are read from. */
  dir: string;
  body: string;
  /** Frontmatter fields only Claude reads, left out of what Codex is given. */
  dropped: string[];
  /** Why a Codex worker cannot use it; it is listed, never delivered. */
  unusable?: string;
}

/** Fields the open skill format defines; every other frontmatter key is Claude's (allowed-tools, model, context, hooks…). */
const PORTABLE = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);

export function projectSkills(cwd: string): ProjectSkill[] {
  const root = join(cwd, '.claude', 'skills');
  if (!existsSync(root)) return [];
  const skills: ProjectSkill[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(root, entry.name);
    let text: string;
    try { text = readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { continue; }
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    let front: Record<string, unknown> = {};
    try { const parsed = m ? YAML.parse(m[1]) : {}; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) front = parsed; else if (m && parsed != null) throw new Error('not a map'); }
    catch { skills.push({ name: entry.name, description: '', dir, body: '', dropped: [], unusable: 'its frontmatter could not be read' }); continue; }
    const body = (m ? text.slice(m[0].length) : text).replaceAll('${CLAUDE_SKILL_DIR}', dir).trim();
    const name = typeof front.name === 'string' && front.name.trim() ? front.name.trim() : entry.name;
    const description = typeof front.description === 'string' && front.description.trim() ? front.description.trim().replace(/\s+/g, ' ') : body.split('\n').find((l) => l.trim())?.trim() ?? '';
    const dropped = Object.keys(front).filter((k) => !PORTABLE.has(k));
    const unusable = front['disable-model-invocation'] === true ? 'only a person starts it (disable-model-invocation), and no one types commands into a Codex worker' : undefined;
    skills.push({ name, description, dir, body, dropped, ...(unusable ? { unusable } : {}) });
  }
  return skills;
}

/** What Codex reads for one skill: the portable frontmatter, where its files are, and its instructions. */
export function skillText(s: ProjectSkill): string {
  const caveats = [
    `Its folder is ${s.dir}: read any file it names from there.`,
    ...(s.dropped.includes('context') || s.dropped.includes('agent') ? ['Claude runs this skill in a subagent; here you follow it in your own turn.'] : []),
    ...(/!`[^`]+`/.test(s.body) ? ["Lines written !`command` are expanded by Claude before it reads the skill; run those commands yourself."] : []),
  ];
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description).slice(1, -1)}\n---\n\n${caveats.join('\n')}\n\n${s.body}\n`;
}

const unusableLines = (skills: ProjectSkill[]) => skills.filter((s) => s.unusable).map((s) => `- ${s.name}: you cannot use it: ${s.unusable}.`);

/** App-server: the index for the developer instructions; the bodies come through `read_skill`. Empty with no skills. */
export function skillIndex(skills: ProjectSkill[]): string {
  if (!skills.length) return '';
  const usable = skills.filter((s) => !s.unusable).map((s) => `- ${s.name}: ${s.description}`);
  return ['## Project skills', '', 'The project\'s skills: instructions for tasks it does often. When one fits your work, call read_skill with its name and follow what it says.', '', ...usable, ...unusableLines(skills)].join('\n');
}

/** Exec, which has no tools: every usable skill's text, in the prompt. Empty with no skills. */
export function skillsInPrompt(skills: ProjectSkill[]): string {
  if (!skills.length) return '';
  const usable = skills.filter((s) => !s.unusable).map((s) => `### Skill: ${s.name}\n\n${skillText(s).trim()}`);
  return ['## Project skills', '', 'The project\'s skills: instructions for tasks it does often. When one fits your work, follow it.', ...(unusableLines(skills).length ? ['', ...unusableLines(skills)] : []), ...usable.flatMap((u) => ['', u])].join('\n');
}

/** The scoped tool that returns a skill's text on request. Read at the call, so an edited skill is read as it stands. */
export function readSkillTool(cwd: string): CustomToolDef {
  return { name: 'read_skill', description: "Read one of the project's skills (named in your instructions under Project skills) before following it.", schema: { name: z.string().describe('The skill name') },
    handler: async (a) => {
      const skill = projectSkills(cwd).find((s) => s.name === a.name);
      if (!skill) return `Rejected: no project skill is named ${String(a.name)}`;
      if (skill.unusable) return `Rejected: ${skill.name} is not for a Codex worker: ${skill.unusable}`;
      return skillText(skill);
    } };
}
