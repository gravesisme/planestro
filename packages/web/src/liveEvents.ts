/**
 * How the page follows the server's event stream without refetching the whole state for every line a session prints.
 * Pure, so it is tested without a browser.
 */

/** Events that change nothing `/api/state` holds beyond what the page keeps itself: a console line, a session's last output, the engine log. */
const KEPT_LOCALLY = new Set(['session.output', 'engine.log', 'journal.appended', 'question.updated']);
export const refreshesState = (type: string): boolean => !KEPT_LOCALLY.has(type);

/**
 * At most one call per `gap` ms, the first `settle` ms after the event that asked (so one change's burst of events
 * is one call), and always one after the last request: a debounce alone never ran while a session streamed.
 */
export function throttled(run: () => void, opts: { gap: number; settle: number; now: () => number; later: (f: () => void, ms: number) => unknown }): () => void {
  let last = -Infinity;
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    opts.later(() => { pending = false; last = opts.now(); run(); }, Math.max(opts.settle, last + opts.gap - opts.now()));
  };
}

/** A console's lines with these appended, stamped, blank ones dropped, the oldest beyond `max` gone. */
export function appendConsole(cur: string[] | undefined, lines: string[], stamp: string, max = 800): string[] {
  const add = lines.filter((l) => l.trim()).map((l) => `${stamp}  ${l}`);
  if (!add.length) return cur ?? [];
  return [...(cur ?? []), ...add].slice(-max);
}

/** The consoles held, this one written last; beyond `maxItems`, the one written longest ago goes. */
export function keepConsole(consoles: Record<string, string[]>, id: string, lines: string[], maxItems = 24): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  const others = Object.keys(consoles).filter((k) => k !== id);
  for (const k of others.slice(Math.max(0, others.length - (maxItems - 1)))) next[k] = consoles[k];
  next[id] = lines;
  return next;
}

/** A message from the socket, or undefined when it is not JSON with a type. */
export function parseEvent(data: unknown): { type: string; [k: string]: any } | undefined {
  try { const e = JSON.parse(String(data)); return e && typeof e.type === 'string' ? e : undefined; } catch { return undefined; }
}

/** The wait before reconnecting after `failures` attempts in a row: 1 s, doubling, at most 30 s. */
export const reconnectDelay = (failures: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, failures));
