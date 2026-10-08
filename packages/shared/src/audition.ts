// ---- a mid-build audition (#207) ----
import { z } from 'zod';

/**
 * Takes a worker made for the user to hear (or see) and pick from before it builds on one: a sound's a/b/c, a model's
 * variants. The paths are worktree-relative and may be in ignored folders (`tmp/`); only the takes listed here are
 * ever served, and only while the item waits on them.
 */
export const AuditionRole = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  /** Where it plays in the project ("desert overworld, loop"). */
  where: z.string().max(500).optional(),
  /** What the takes were generated from. */
  prompt: z.string().max(2000).optional(),
  takes: z.array(z.string().trim().min(1)).min(1).max(12),
});
export type AuditionRole = z.infer<typeof AuditionRole>;
export const Audition = z.object({
  title: z.string().trim().min(1).max(200),
  roles: z.array(AuditionRole).min(1).max(30),
  /** Whether the user may answer "none of these: regenerate", with a note. */
  allow_regenerate: z.boolean().optional(),
});
export type Audition = z.infer<typeof Audition>;

/** The user's answer for one role: one of its takes, or (when allowed) none of them, with what to change. */
export type AuditionPick = { take: string } | { regenerate: string };

/** Why this audition cannot be put to the user, or undefined. Files are the engine's to check. */
export function auditionProblem(a: Audition): string | undefined {
  const ids = new Set<string>();
  for (const r of a.roles) {
    if (ids.has(r.id)) return `role id "${r.id}" is used twice; give each role its own id`;
    ids.add(r.id);
    if (new Set(r.takes).size !== r.takes.length) return `role "${r.id}" lists a take twice`;
    for (const t of r.takes) if (takePathProblem(t)) return `role "${r.id}": ${takePathProblem(t)}`;
  }
  return undefined;
}

/** A take is named by its path inside the worktree: never absolute, never through `..`. */
export function takePathProblem(path: string): string | undefined {
  if (/^([\\/]|[a-zA-Z]:)/.test(path)) return `${path} is absolute; name it relative to your worktree`;
  if (path.split(/[\\/]/).includes('..')) return `${path} leaves your worktree`;
  return undefined;
}

/** Why these picks do not answer this audition, or undefined: every role needs exactly one pick, from its own takes. */
export function auditionPicksProblem(a: Audition, picks: Record<string, AuditionPick>): string | undefined {
  for (const id of Object.keys(picks)) if (!a.roles.some((r) => r.id === id)) return `there is no role "${id}" in this audition`;
  for (const r of a.roles) {
    const p = picks[r.id];
    if (!p) return `pick a take for ${r.name} (${r.id})`;
    if ('take' in p) { if (!r.takes.includes(p.take)) return `${p.take} is not one of the takes for ${r.name} (${r.id})`; }
    else if (!a.allow_regenerate) return `${r.name} (${r.id}): the worker did not offer to regenerate; pick one of its takes`;
    else if (!String(p.regenerate ?? '').trim()) return `${r.name} (${r.id}): say what to change for the regenerated takes`;
  }
  return undefined;
}

/** One line per role, as the worker reads it back: `<role> <take>`, or `<role> regenerate: <note>`. */
export function auditionPickLines(a: Audition, picks: Record<string, AuditionPick>): string[] {
  return a.roles.map((r) => { const p = picks[r.id]; return 'take' in p ? `${r.id} ${p.take}` : `${r.id} regenerate: ${p.regenerate.trim().replace(/\s+/g, ' ')}`; });
}

/** The picks as they are kept on the item, under the role names the user saw. */
export function auditionNote(a: Audition, picks: Record<string, AuditionPick>): string {
  const lines = a.roles.map((r) => { const p = picks[r.id]; return `- ${r.name} (\`${r.id}\`): ${'take' in p ? `\`${p.take}\`` : `none, regenerate: ${p.regenerate.trim()}`}`; });
  return `**Audition: ${a.title}**\n\n${lines.join('\n')}`;
}
