import { z } from 'zod';
import { auditDigest, turnsOn, dayBefore, parseCron, prevSlot, isoInZone, isoLocal, modelCapabilities, usageTurnData, USAGE_TURN, EFFICIENCY_AUDIT, AUDIT_DIGEST_TYPES, type AuditRecord, type PreviousRecommendation, type JournalEntry } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { Ports, TurnResult, CustomToolDef } from './ports.ts';
import type { Orchestrator } from './orchestrator.ts';
import { NOTE_TYPE, NOTE_LINK_TYPE, notesWithLinks } from './feedback.ts';

// ---- the daily one-fix efficiency audit (#348) ----
// Once a day, at `efficiency_audit.cron` on this machine's clock, code builds a digest of the last days' usage (no model
// cost) and one wake on the orchestrator's model reads it and names the single biggest waste: one planestro feedback
// note, or, when that is still yesterday's note and nothing was done with it, a line on that note instead of a duplicate.
// Its only tool files that one note. The slot is its memory: a slot begun (`op.begin`) is never run again, so a restart
// mid-audit never pays twice.

const OP = 'efficiency_audit';
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The slot to audit now, or undefined: off, not yet time, or this slot already begun. */
export function auditSlotDue(store: DataStore, now: Date, tz = localZone()): string | undefined {
  const cfg = store.config.efficiency_audit;
  if (!cfg.enabled) return undefined;
  let at: Date | undefined;
  try { at = prevSlot(parseCron(cfg.cron), tz, now); } catch { return undefined; }
  if (!at) return undefined;
  const slot = isoInZone(at, tz);
  const since = isoLocal(new Date(at.getTime() - 86_400_000));
  const begun = store.journal.read({ since, type: 'op.begin' }).some((e) => e.data?.op === OP && e.data?.slot === slot);
  return begun ? undefined : slot;
}

/** The last recommendation the audit filed or repeated, and whether its note was acted on (filed as an issue, or handled). */
export function previousRecommendation(store: DataStore): (PreviousRecommendation & { note: string }) | undefined {
  const last = store.journal.read({ type: EFFICIENCY_AUDIT }).filter((e) => (e.data?.outcome === 'noted' || e.data?.outcome === 'repeat') && typeof e.data?.note === 'string').at(-1);
  if (!last) return undefined;
  const d = last.data as unknown as AuditRecord;
  const note = notesWithLinks(store).find((n) => n.ts === d.note);
  return { at: last.ts, key: String(d.key ?? ''), what: String(d.what ?? ''), note: d.note!, acted: Boolean(note && (note.links.handled || note.links.issues.length)) };
}

export interface AuditDeps {
  store: DataStore;
  agents: Ports['agents'];
  orchestrator: Pick<Orchestrator, 'modelForWake'>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  signal?: AbortSignal;
}

/** Run the audit for `slot`: the digest, the one wake, the one note. Returns what it recorded. */
export async function runEfficiencyAudit(deps: AuditDeps, slot: string): Promise<AuditRecord> {
  const { store } = deps;
  const cfg = store.config.efficiency_audit;
  const opId = store.journal.begin(OP, undefined, { slot });
  const finish = (r: AuditRecord): AuditRecord => {
    store.journal.append({ type: EFFICIENCY_AUDIT, actor: 'engine', data: { ...r } });
    store.journal.end(opId, undefined, r.outcome === 'failed' ? 'failed' : 'ok', { outcome: r.outcome });
    deps.log(r.outcome === 'failed' ? 'warn' : 'info', `efficiency audit ${slot.slice(0, 10)}: ${r.outcome}${r.what ? `: ${r.what}` : r.reason ? ` (${r.reason})` : ''}`);
    return r;
  };
  // The slot's day is the day it runs on: the digest ends the day before, whose turns are all in.
  const through = dayBefore(slot.slice(0, 10), 1);
  const types = new Set(AUDIT_DIGEST_TYPES);
  const entries: JournalEntry[] = store.journal.read({ since: dayBefore(through, cfg.days - 1) }).filter((e) => types.has(e.type));
  if (!turnsOn(entries, through)) return finish({ slot, outcome: 'skipped', reason: `no turns on ${through}` });
  const pick = deps.orchestrator.modelForWake();
  const agent = deps.agents[pick.runner];
  if (!agent?.runCustomTurn) return finish({ slot, outcome: 'skipped', reason: `the ${pick.runner} runner cannot run it` });
  if (pick.accountMissing) return finish({ slot, outcome: 'skipped', reason: pick.accountMissing });
  const previous = previousRecommendation(store);
  const digest = auditDigest(entries, { today: through, days: cfg.days, ...(previous ? { previous } : {}) });
  let filed: AuditRecord | undefined;
  const tool: CustomToolDef = {
    name: 'file_recommendation',
    description: 'File your one recommendation for today. Call it exactly once.',
    schema: {
      key: z.string().describe('A short stable name for what the waste is about, e.g. "planner-fable-cost" or "HH-412-whole-suite-runs". Reuse the last recommendation\'s key when it is the same waste.'),
      what: z.string().describe('The waste, in one line.'),
      evidence: z.string().describe('The numbers from the digest that show it.'),
      change: z.string().describe('One specific mechanical change: an allow rule, a prompt-partial trim, a test filter, a model for one role, a setting.'),
      saving: z.string().describe('The expected saving, per day or per item, with how you estimated it.'),
    },
    handler: async (a) => {
      if (filed) return 'Already filed: one recommendation a day. End your turn.';
      const key = String(a.key ?? '').trim().slice(0, 80) || 'unnamed';
      const what = String(a.what ?? '').trim().slice(0, 300);
      if (previous && !previous.acted && key === previous.key) {
        store.journal.append({ type: NOTE_LINK_TYPE, actor: 'orchestrator', data: { note: previous.note, comment: `still the biggest waste on ${through} (efficiency audit): ${String(a.evidence ?? '').slice(0, 600)}` } });
        filed = { slot, outcome: 'repeat', key, what: what || previous.what, note: previous.note };
        return 'Recorded on the last note, which is still open: nothing new was filed. End your turn.';
      }
      const text = [`Efficiency audit ${through}: ${what}`, `Evidence: ${String(a.evidence ?? '')}`, `Change: ${String(a.change ?? '')}`, `Expected saving: ${String(a.saving ?? '')}`].join('\n\n');
      const note = store.journal.append({ type: NOTE_TYPE, actor: 'orchestrator', data: { text, source: 'efficiency_audit', key } });
      filed = { slot, outcome: 'noted', key, what, note: note.ts };
      return `Filed under planestro feedback at ${note.ts}. End your turn.`;
    },
  };
  const prompt = [
    `# Daily efficiency audit, ${through}`,
    `Below is a digest of planestro's usage over the ${cfg.days} days up to ${through}, counted by code from what it records. Find the single biggest avoidable waste in it and name ONE fix: a dumb, mechanical change (an allow rule, a prompt-partial trim, a test filter, a model switch for one role, a setting) with the evidence and the expected saving. Prefer the largest saving you can back with the numbers here.`,
    previous ? `The last recommendation (${previous.at.slice(0, 10)}, key \`${previous.key}\`) was ${previous.acted ? 'acted on' : 'NOT acted on yet'}. If it is still the biggest waste, file it with the same key: planestro then notes it on that recommendation instead of filing a duplicate.` : '',
    'Call file_recommendation exactly once, then end your turn. You have no other tools and need none: everything is in the digest.',
    '---',
    digest,
  ].filter(Boolean).join('\n\n');
  let result: TurnResult;
  try {
    result = await agent.runCustomTurn({
      label: OP, cwd: store.codeRepoPath(), model: pick.model, permissionMode: 'dontAsk', prompt,
      systemAppend: 'You are planestro\'s efficiency auditor. You read one digest and file one recommendation with your only tool. Do not read files or run commands.',
      allowedTools: [], mcpTools: [tool], maxTurns: 4, maxTokens: cfg.budget_tokens, maxBudgetUsd: cfg.budget_usd,
      ...(pick.account ? { account: { name: pick.account, ...(pick.accountHome ? { home: pick.accountHome } : {}) } } : {}),
      onOutput: () => {}, ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (e) {
    return finish({ slot, outcome: 'failed', reason: (e as Error).message.slice(0, 300) });
  }
  // What it spent is a turn like any other (#236), the orchestrator's.
  const spent = usageTurnData({ provider: pick.runner, model: pick.model, role: 'orchestrator', op: OP, accounting: pick.def ? modelCapabilities(pick.def).accounting : pick.runner === 'claude' ? 'dollars' : 'tokens', stage: 'orchestrator', resumed: false, result });
  if (spent) store.journal.append({ type: USAGE_TURN, actor: 'orchestrator', data: { ...spent } });
  const paid = { ...(spent?.usd !== undefined ? { usd: spent.usd } : {}), ...(spent?.tokens ? { tokens: spent.tokens } : {}) };
  if (filed) return finish({ ...filed, ...paid });
  return finish({ slot, outcome: 'failed', reason: result.isError ? `${result.subtype}: ${result.error ?? ''}`.slice(0, 300) : 'the wake ended without a recommendation', ...paid });
}
