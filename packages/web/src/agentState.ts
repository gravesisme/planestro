import type { ItemView, SessionView, State } from './api.ts';
import { pendingTurnWait, SLOT_WAIT } from './pendingTurn.ts';

/** What the board says about an item's agent (#299): running now, queued for a session slot, or a saved instruction waiting on something else. */
export type AgentState =
  | { kind: 'running'; label: string; output?: string }
  | { kind: 'slot'; reason: string }
  | { kind: 'wait'; reason: string };

const DOING: Record<string, string> = { plan: 'planning…', implement: 'implementing…', fix: 'fixing…' };
/** "planning…" for a busy session's phase. */
export const runningLabel = (op?: string): string => (op && DOING[op]) ?? 'running…';

/** `lastOutput`: the newest line from the event stream, newer than the state's own when there is one. */
export function agentStateOf(item: ItemView, state: State | null | undefined, lastOutput?: string): AgentState | undefined {
  const session = state?.engine.sessions.find((s) => s.item === item.id);
  const output = lastOutput ?? session?.last_output;
  if (session?.busy) return { kind: 'running', label: runningLabel(session.op), ...(output ? { output } : {}) };
  const wait = pendingTurnWait(item.frontmatter, state);
  if (wait && wait !== SLOT_WAIT) return { kind: 'wait', reason: wait };
  if (wait) return { kind: 'slot', reason: wait };
  // A turn the engine started that has no process yet: its op names the slot it is queued for.
  if (session) return { kind: 'slot', reason: `Queued: ${session.op ?? 'turn'}. It starts when a session slot frees up.` };
  return undefined;
}

/** The sessions with an agent running, each with its item when the board has it, in the engine's order. */
export function runningItems(state: State): { session: SessionView; item?: ItemView }[] {
  return state.engine.sessions.filter((s) => s.busy).map((session) => ({ session, item: state.items.find((i) => i.id === session.item) }));
}

const byIdCache = new WeakMap<ItemView[], Map<string, ItemView>>();
/** The items by id, built once per list the server sent: each card looked up its children in the whole list. */
export function itemsById(items: ItemView[]): Map<string, ItemView> {
  let m = byIdCache.get(items);
  if (!m) { m = new Map(items.map((i) => [i.id, i])); byIdCache.set(items, m); }
  return m;
}
