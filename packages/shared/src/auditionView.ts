// ---- a mid-build audition (#207): the pure part, free of zod for the web's view entry (#408) ----
import type { Audition, AuditionRole } from './audition.ts';

/** At most this many takes (kept and new) in one audition, across its roles. */
export const AUDITION_MAX_TAKES = 120;

/** The user's answer for one role: the takes kept from this round and, when that is fewer than it needs, regenerate the rest with an optional note. */
export type AuditionPick = { takes: string[]; regenerate?: string };

const pickOf = (r: AuditionRole) => r.pick ?? 1;
const keptOf = (r: AuditionRole) => r.kept ?? [];
/** How many more takes the role needs this round. */
export const auditionNeed = (r: AuditionRole): number => Math.max(0, pickOf(r) - keptOf(r).length);

/** Every take this audition may serve: the kept ones and the new ones. */
export function auditionTakes(a: Audition): string[] { return a.roles.flatMap((r) => [...keptOf(r), ...r.takes]); }

/** Why this audition cannot be put to the user, or undefined. Files are the engine's to check. */
export function auditionProblem(a: Audition): string | undefined {
  const ids = new Set<string>();
  for (const r of a.roles) {
    if (ids.has(r.id)) return `role id "${r.id}" is used twice; give each role its own id`;
    ids.add(r.id);
    const kept = keptOf(r);
    if (new Set(r.takes).size !== r.takes.length || new Set(kept).size !== kept.length) return `role "${r.id}" lists a take twice`;
    if (kept.length > pickOf(r)) return `role "${r.id}" keeps ${kept.length} takes but needs only ${pickOf(r)} (pick)`;
    const both = r.takes.find((t) => kept.includes(t));
    if (both) return `role "${r.id}": ${both} is both kept and offered; list it only in kept`;
    if (auditionNeed(r) > 0 && !r.takes.length) return `role "${r.id}" needs ${auditionNeed(r)} more but offers no takes`;
    for (const t of [...kept, ...r.takes]) if (takePathProblem(t)) return `role "${r.id}": ${takePathProblem(t)}`;
  }
  if (!a.roles.some((r) => auditionNeed(r) > 0)) return 'every role is already filled by its kept takes: nothing left to pick';
  const n = auditionTakes(a).length;
  if (n > AUDITION_MAX_TAKES) return `${n} takes is too many for one audition (at most ${AUDITION_MAX_TAKES}); put fewer up at once`;
  return undefined;
}

/** A take is named by its path inside the worktree: never absolute, never through `..`. */
export function takePathProblem(path: string): string | undefined {
  if (/^([\\/]|[a-zA-Z]:)/.test(path)) return `${path} is absolute; name it relative to your worktree`;
  if (path.split(/[\\/]/).includes('..')) return `${path} leaves your worktree`;
  return undefined;
}

/**
 * Why these picks do not answer this audition, or undefined: a role that needs takes gets up to what it needs, from this
 * round's takes, and, short of that, a regenerate (its note optional). A role its kept takes fill takes no picks.
 */
export function auditionPicksProblem(a: Audition, picks: Record<string, AuditionPick>): string | undefined {
  for (const id of Object.keys(picks)) if (!a.roles.some((r) => r.id === id)) return `there is no role "${id}" in this audition`;
  for (const r of a.roles) {
    const p = picks[r.id]; const need = auditionNeed(r); const label = `${r.name} (${r.id})`;
    if (need === 0) { if (p?.takes.length) return `${label} is already filled by its kept takes`; continue; }
    if (!p) return `pick ${need === 1 ? 'a take' : `${need} takes`} for ${label}, or regenerate the rest`;
    if (new Set(p.takes).size !== p.takes.length) return `${label}: a take is picked twice`;
    const stray = p.takes.find((t) => !r.takes.includes(t));
    if (stray) return `${stray} is not one of the takes for ${label}`;
    if (p.takes.length > need) return `${label}: pick at most ${need}${keptOf(r).length ? ' more' : ''}`;
    if (p.takes.length < need && p.regenerate === undefined) return `${label}: ${keptOf(r).length + p.takes.length} of ${pickOf(r)} picked; pick more or regenerate the rest`;
  }
  return undefined;
}

/** Whether these picks fill every role, so no round follows. */
export function auditionComplete(a: Audition, picks: Record<string, AuditionPick>): boolean {
  return a.roles.every((r) => (picks[r.id]?.takes.length ?? 0) >= auditionNeed(r));
}

const oneLine = (s: string) => s.trim().replace(/\s+/g, ' ');
function roleAnswer(r: AuditionRole, p: AuditionPick | undefined) {
  const keep = [...keptOf(r), ...(p?.takes ?? [])];
  const more = Math.max(0, pickOf(r) - keep.length);
  return { keep, more, note: more ? oneLine(p?.regenerate ?? '') : '' };
}

/** One line per role, as the worker reads it back: `<role> keep <takes…>`, then `; regenerate <k> more: <note>` while it is short. */
export function auditionPickLines(a: Audition, picks: Record<string, AuditionPick>): string[] {
  return a.roles.map((r) => {
    const { keep, more, note } = roleAnswer(r, picks[r.id]);
    const regen = more ? `regenerate ${more} more${note ? `: ${note}` : ''}` : '';
    return [`${r.id}${keep.length ? ` keep ${keep.join(' ')}` : ''}`, regen].filter(Boolean).join(keep.length ? '; ' : ' ');
  });
}

/** The picks as they are kept on the item, under the role names the user saw: every kept take so far, and what is asked again. */
export function auditionNote(a: Audition, picks: Record<string, AuditionPick>): string {
  const lines = a.roles.map((r) => {
    const { keep, more, note } = roleAnswer(r, picks[r.id]);
    return `- ${r.name} (\`${r.id}\`): ${keep.length ? keep.map((t) => `\`${t}\``).join(', ') : 'none kept'} (${keep.length} of ${pickOf(r)})${more ? `; regenerate ${more} more${note ? `: ${note}` : ''}` : ''}`;
  });
  return `**Audition: ${a.title}**\n\n${lines.join('\n')}`;
}
