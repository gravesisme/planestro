import type { JournalEntry } from '@planestro/shared';

/**
 * What the orchestrator costs, wake by wake (#49), read from its `orchestrator.done` journal entries: the
 * turn already reported its cost and context size, so nothing is asked of a model (invariant 4). HH and LM
 * tuned rotation by guesswork because only the total was visible.
 */
export interface Wake { at: string; events: string[]; items: string[]; cost: number; context_tokens?: number; model?: string; session?: string; wake?: number; fresh: boolean; summary: string; failed: boolean }
export interface Spend {
  wakes: Wake[];
  /** Since local midnight. */
  today: { wakes: number; cost: number };
  /** The conversation the latest wake was in: it starts again on rotation. */
  conversation: { wakes: number; cost: number; context_tokens?: number } | null;
}

export function orchestratorSpend(entries: JournalEntry[], now = new Date(), recent = 30): Spend {
  const all: Wake[] = entries.filter((e) => e.type === 'orchestrator.done').map((e) => {
    const d = e.data ?? {};
    return {
      at: e.ts, events: (d.events as string[] | undefined) ?? [], items: (d.items as string[] | undefined) ?? [], cost: Number(d.cost ?? 0),
      ...(typeof d.context_tokens === 'number' ? { context_tokens: d.context_tokens } : {}), ...(typeof d.model === 'string' ? { model: d.model } : {}),
      ...(typeof d.session === 'string' ? { session: d.session } : {}), ...(typeof d.wake === 'number' ? { wake: d.wake } : {}),
      fresh: d.fresh === true, summary: String(d.summary ?? ''), failed: typeof d.subtype === 'string' && d.subtype !== 'success',
    };
  });
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const today = all.filter((w) => Date.parse(w.at) >= midnight.getTime());
  const last = all.at(-1);
  // The latest conversation: back from the last wake while the session is the same, down to the wake that started it.
  let conversation: Spend['conversation'] = null;
  if (last?.session) {
    const mine: Wake[] = [];
    for (let i = all.length - 1; i >= 0 && all[i].session === last.session; i--) { mine.push(all[i]); if (all[i].fresh) break; }
    conversation = { wakes: mine.length, cost: round(mine.reduce((n, w) => n + w.cost, 0)), ...(last.context_tokens !== undefined ? { context_tokens: last.context_tokens } : {}) };
  }
  return { wakes: all.slice(-recent).reverse(), today: { wakes: today.length, cost: round(today.reduce((n, w) => n + w.cost, 0)) }, conversation };
}

const round = (n: number) => Math.round(n * 100) / 100;
