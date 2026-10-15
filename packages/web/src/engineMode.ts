/** The engine mode three ways, as `/api/state` reports it (#335). */
export interface EngineModes { configured: string; local: string | null; saved: string; running: string; restart_to_apply: boolean }

/**
 * "saved: live · running: dry-run — restart to apply", naming this machine's override when it is what differs from the
 * project's setting; undefined while the running engine is the saved one.
 */
export function modeNote(m: EngineModes | undefined): string | undefined {
  if (!m?.restart_to_apply) return undefined;
  const why = m.local && m.local !== m.configured ? ` (this machine's planestro.local.yml sets ${m.local}; the project says ${m.configured})` : '';
  return `saved: ${m.saved}${why} · running: ${m.running} — restart to apply`;
}

/** What a task created now gets until the restart. */
export function newItemModeNote(m: EngineModes | undefined): string | undefined {
  if (!m?.restart_to_apply) return undefined;
  return m.running === 'dry-run'
    ? `The engine is still running dry-run (saved: ${m.saved}): until planestro restarts, this item's work is simulated.`
    : `The engine is still running live (saved: ${m.saved}): until planestro restarts, this item's work is real.`;
}
