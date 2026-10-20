// ---- a mid-build audition (#207) ----
import { z } from 'zod';

export * from './auditionView.ts';

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
  /** How many takes the role needs (#318); unset is one. */
  pick: z.number().int().min(1).max(10).optional(),
  /** Takes the user kept in an earlier round: shown locked, still playable, never picked again. */
  kept: z.array(z.string().trim().min(1)).max(10).optional(),
  /** The candidates of this round; none for a role that its kept takes already fill. */
  takes: z.array(z.string().trim().min(1)).max(30).default([]),
});
export type AuditionRole = z.infer<typeof AuditionRole>;
export const Audition = z.object({
  title: z.string().trim().min(1).max(200),
  roles: z.array(AuditionRole).min(1).max(30),
  /** #207's opt-in to "none of these: regenerate". Accepted for older callers and ignored: regenerating is always offered (#318). */
  allow_regenerate: z.boolean().optional(),
});
export type Audition = z.infer<typeof Audition>;

/** Picks as they arrive: this shape, or #207's one `{take}` / `{regenerate}` per role, read as this shape. */
export const AuditionPicks = z.record(z.string(), z.union([
  z.strictObject({ takes: z.array(z.string()).max(30), regenerate: z.string().max(2000).optional() }),
  z.strictObject({ take: z.string() }).transform((p) => ({ takes: [p.take] })),
  z.strictObject({ regenerate: z.string().max(2000) }).transform((p) => ({ takes: [] as string[], regenerate: p.regenerate })),
]));
