import { createHash } from 'node:crypto';
import type { ItemFrontmatter, QuestionFrontmatter, ServerEvent } from '@planestro/shared';
import { waitKindOf, type WaitKind } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';

export type { WaitKind };

/**
 * One wait on a person: an item whose `needs_you` is true, or an open orchestrator question. `key` names this wait and
 * no other, so it is notified once: a different kind, card, request, reason or hold is a new wait, and so is the same
 * one again after it ended.
 */
export interface Wait { key: string; subject: string; item?: string; question?: string; kind: WaitKind; path: string; title: string; message: string }

/** The wait this item is, or undefined when it does not need you (the same answer as the board's `needs_you`). */
export function itemWait(fm: ItemFrontmatter): Wait | undefined {
  const kind = waitKindOf(fm);
  if (!kind) return undefined;
  const d = (fm.awaiting_data ?? {}) as Record<string, unknown>;
  const what: Record<WaitKind, [string, string]> = {
    plan: ['plan ready', fm.plan_ready_at ?? ''],
    breakdown: ['breakdown ready', fm.plan_ready_at ?? ''],
    permission: ['permission requested', String(d.requested_at ?? '')],
    question: ['the worker asks', String(d.requested_at ?? '')],
    audition: ['takes to hear and pick', String(d.requested_at ?? '')],
    review: ['ready for your review', String(fm.ci_head_sha ?? '')],
    decision: ['decision needed', d.decision ? createHash('sha1').update(JSON.stringify(d.decision)).digest('hex').slice(0, 12) : ''],
    blocked: [`blocked (${fm.blocked_reason ?? 'no reason'})`, fm.blocked_reason ?? ''],
    hold: ['pull request held for you', fm.hold_reason ?? ''],
  };
  const [said, stamp] = what[kind];
  return { key: `${fm.id}:${kind}:${stamp}`, subject: fm.id, item: fm.id, kind, path: `/items/${fm.id}#${kind}`, title: `${fm.id} needs you: ${said}`, message: fm.title };
}

/** An open orchestrator question is a wait on you until it is resolved or withdrawn. */
export function questionWait(fm: QuestionFrontmatter): Wait | undefined {
  if (fm.status !== 'open') return undefined;
  return { key: `${fm.id}:question:${fm.asked_at}`, subject: fm.id, ...(fm.item ? { item: fm.item } : {}), question: fm.id, kind: 'question', path: `/questions/${fm.id}`, title: `${fm.id}: the orchestrator asks${fm.item ? ` about ${fm.item}` : ''}`, message: fm.headline };
}

export interface NeedsYouDeps {
  announce(w: Wait): void;
  /** Epoch ms. */
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
  /** notifications.idle_after_min, in ms. */
  idleAfterMs(): number;
}

/**
 * Notifies when an item needs you or a question opens (#224), once per wait. A wait is announced only once every
 * client has been idle for notifications.idle_after_min: while someone is at a planestro tab (its heartbeat, on input),
 * it is held back, and one answered in that window is never sent. It also settles for SETTLE_MS first, so a stop the
 * engine moves on from at once (a block that goes to triage in a later write) is not announced.
 *
 * Its memory is the journal: at start, a wait still open that a `notification` already named is not sent again.
 */
export const SETTLE_MS = 1_000;
export class NeedsYouWatch {
  private readonly live = new Map<string, Wait>();
  private readonly sent = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private lastActive = -Infinity;
  private seeded = false;
  private stopped = false;

  constructor(private readonly store: DataStore, private readonly deps: NeedsYouDeps) {}

  /** Read every wait there is now; those the journal already announced stay announced. */
  start(): void { this.stopped = false; this.seed(); }
  stop(): void { this.stopped = true; for (const cancel of this.timers.values()) cancel(); this.timers.clear(); }

  /** A client heartbeat: someone is using planestro now. */
  clientActive(): void { this.lastActive = this.deps.now(); }

  observe(e: ServerEvent): void {
    if (this.stopped) return;
    if (!this.seeded) { this.seed(); return; }
    if (e.type === 'item.created' || e.type === 'item.updated') { const it = this.store.getItem(e.id); this.update(e.id, it ? itemWait(it.file.frontmatter) : undefined); }
    else if (e.type === 'item.deleted') this.update(e.id, undefined);
    else if (e.type === 'question.updated') { const q = this.store.getQuestion(e.id); this.update(e.id, q ? questionWait(q.file.frontmatter) : undefined); }
    else if (e.type === 'index.reloaded') this.scan();
  }

  private seed(): void {
    this.seeded = true;
    const named = new Set(this.store.journal.read({ type: 'notification' }).filter((j) => j.data?.event === 'on_needs_you' && typeof j.data.wait === 'string').map((j) => String(j.data!.wait)));
    for (const w of this.waits()) if (named.has(w.key)) { this.live.set(w.subject, w); this.sent.add(w.key); }
    this.scan();
  }

  private waits(): Wait[] {
    return [
      ...this.store.listItems().map((i) => itemWait(i.file.frontmatter)),
      ...this.store.listQuestions({ status: 'open' }).map((q) => questionWait(q.file.frontmatter)),
    ].filter((w): w is Wait => w !== undefined);
  }

  private scan(): void {
    const now = new Map(this.waits().map((w) => [w.subject, w]));
    for (const subject of [...this.live.keys()]) if (!now.has(subject)) this.update(subject, undefined);
    for (const [subject, w] of now) this.update(subject, w);
  }

  private update(subject: string, w: Wait | undefined): void {
    const prev = this.live.get(subject);
    if (prev?.key === w?.key) return;
    if (prev) { this.live.delete(subject); this.sent.delete(prev.key); this.timers.get(subject)?.(); this.timers.delete(subject); }
    if (!w) return;
    this.live.set(subject, w);
    if (!this.sent.has(w.key)) this.later(w, SETTLE_MS);
  }

  private later(w: Wait, ms: number): void {
    this.timers.get(w.subject)?.();
    this.timers.set(w.subject, this.deps.schedule(() => { this.timers.delete(w.subject); this.due(w); }, ms));
  }

  private due(w: Wait): void {
    if (this.stopped || this.live.get(w.subject)?.key !== w.key || this.sent.has(w.key)) return;
    const idleFor = this.deps.now() - this.lastActive;
    const window = this.deps.idleAfterMs();
    if (idleFor < window) { this.later(w, window - idleFor); return; }
    this.sent.add(w.key);
    this.deps.announce(w);
  }
}
