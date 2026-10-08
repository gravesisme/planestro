/**
 * Debug instrumentation markers (#240). A worker that instruments code to find a bug fences every probe in a
 * block between these two tokens, written inside whatever comment syntax the file uses (`// …`, `# …`,
 * `<!-- … -->`, `-- …`), so the markers are the same in every project and language. planestro refuses
 * report_done while the branch still adds a line holding either one.
 */
export const DEBUG_BEGIN = 'planestro:debug-begin';
export const DEBUG_END = 'planestro:debug-end';
/** What both markers start with: the needle the refusal searches added lines for. */
export const DEBUG_MARKER = 'planestro:debug-';

/** One added line that holds a marker: its file, its line number in the worktree's copy, its text. */
export interface MarkerHit { path: string; line: number; text: string }

const SHOWN = 20;

/** Why report_done is not taken while marked lines remain (undefined: none do), in words the worker acts on. */
export function debugMarkerRefusal(hits: MarkerHit[], base: string): string | undefined {
  if (!hits.length) return undefined;
  const lines = hits.slice(0, SHOWN).map((h) => `- ${h.path}:${h.line}  ${h.text.trim().slice(0, 160)}`);
  if (hits.length > SHOWN) lines.push(`- … and ${hits.length - SHOWN} more`);
  return [
    `Rejected: your branch still adds debug instrumentation against ${base}: ${hits.length} line${hits.length === 1 ? '' : 's'} with a ${DEBUG_BEGIN} / ${DEBUG_END} marker remain${hits.length === 1 ? 's' : ''}:`,
    lines.join('\n'),
    'Remove every marked block (both markers and everything between them), keep the fix, commit, and call report_done again. Nothing was recorded.',
  ].join('\n');
}
