/**
 * Structured progress for work that is really N parts (dogfood f4): an atlas of eight rows, a set of
 * icons, a pack of sounds. Each part is accepted, pending or rejected with a gate reason, reported by
 * the worker itself, so the orchestrator quotes it instead of summarising prose, the item page shows
 * it, and the engine can say when the parts accepted so far project past the budget.
 */
export const PART_STATES = ['accepted', 'pending', 'rejected'] as const;
export type PartState = (typeof PART_STATES)[number];
export interface Part { name: string; state: PartState; reason?: string }
export const PART_LIMITS = { maxParts: 64, name: 60, reason: 300 } as const;

/** Validate what a worker reported. Returns the error as a sentence the worker can act on. */
export function validateParts(input: unknown): { ok: true; value: Part[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || !input.length) return { ok: false, error: 'parts must be a non-empty list of { name, state, reason? }' };
  if (input.length > PART_LIMITS.maxParts) return { ok: false, error: `${input.length} parts is too many; group them into at most ${PART_LIMITS.maxParts}` };
  const out: Part[] = [];
  for (const [i, p] of (input as Array<Partial<Part>>).entries()) {
    const name = String(p?.name ?? '').trim();
    if (!name) return { ok: false, error: `part ${i} has no name` };
    if (name.length > PART_LIMITS.name) return { ok: false, error: `part "${name.slice(0, 20)}…": a name under ${PART_LIMITS.name} characters` };
    if (!PART_STATES.includes(p.state as PartState)) return { ok: false, error: `part "${name}": state must be one of ${PART_STATES.join(', ')} (got ${JSON.stringify(p?.state)})` };
    const reason = p.reason === undefined || p.reason === null ? undefined : String(p.reason).trim();
    if (reason && reason.length > PART_LIMITS.reason) return { ok: false, error: `part "${name}": the reason is ${reason.length} characters; keep it under ${PART_LIMITS.reason}` };
    if (p.state === 'rejected' && !reason) return { ok: false, error: `part "${name}" is rejected without a reason: say what gate it failed` };
    out.push({ name, state: p.state as PartState, ...(reason ? { reason } : {}) });
  }
  if (new Set(out.map((p) => p.name.toLowerCase())).size !== out.length) return { ok: false, error: 'part names must differ' };
  return { ok: true, value: out };
}

/** "4/8 accepted · 3 rejected (stomp: area ratio 0.908; …) · 1 pending", for Activity and packets. */
export function partsSummary(parts: readonly Part[]): string {
  const by = (s: PartState) => parts.filter((p) => p.state === s);
  const bits = [`${by('accepted').length}/${parts.length} accepted`];
  const rejected = by('rejected'); if (rejected.length) bits.push(`${rejected.length} rejected (${rejected.slice(0, 4).map((p) => `${p.name}: ${p.reason ?? ''}`.slice(0, 80)).join('; ')}${rejected.length > 4 ? '; …' : ''})`);
  const pending = by('pending'); if (pending.length) bits.push(`${pending.length} pending (${pending.slice(0, 6).map((p) => p.name).join(', ')}${pending.length > 6 ? ', …' : ''})`);
  return bits.join(' · ');
}
