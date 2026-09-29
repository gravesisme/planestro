import { isoLocal, kindConversionRefusal, type ServerEvent } from '@planestro/shared';
import type { DataStore } from '../store/DataStore.ts';
import type { Engine, SessionView } from './Engine.ts';

/** No sessions, no git: only the user-driven transitions. Lets the UI be built before the real engine exists. */
export class MockEngine implements Engine {
  readonly mode = 'dry-run' as const;
  log: ServerEvent[] = [];
  private _paused: boolean;
  constructor(private readonly store: DataStore, private readonly emit: (e: ServerEvent) => void) { this._paused = store.local.engine.paused; }
  get paused(): boolean { return this._paused; }
  async start(): Promise<void> { this.note('info', 'mock engine: no sessions will run'); }
  async stop(): Promise<void> {}
  pause(): void { this._paused = true; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: true } }); this.emit({ type: 'engine.paused', paused: true }); }
  resume(): void { this._paused = false; this.store.updateLocal({ engine: { ...this.store.local.engine, paused: false } }); this.emit({ type: 'engine.paused', paused: false }); }
  poke(): void {}
  async approvePlan(id: string, notes?: string, _by?: 'user' | 'orchestrator', { hold }: { asItem?: boolean; hold?: string } = {}): Promise<void> {
    this.store.mutateItem(id, [{ transition: { to: 'IN_PROGRESS', actor: 'user' } }, ...(notes ? [{ activity: { actor: 'user' as const, text: `approval notes: ${notes}` } }] : []), ...(hold?.trim() ? [{ set: { skip_merge: true, hold_reason: hold.trim() } }, { activity: { actor: 'user' as const, text: `held out of the merge queue: ${hold.trim()}` } }] : [])], 'user', { commit: `${id}: approve plan` });
  }
  async rejectPlan(id: string, message: string): Promise<void> {
    this.store.mutateItem(id, [{ transition: { to: 'PLAN_IN_PROGRESS', actor: 'user' } }, { activity: { actor: 'user', text: `plan changes requested: ${message}` } }], 'user', { commit: `${id}: request plan changes` });
  }
  async message(id: string, text: string): Promise<void> { this.store.mutateItem(id, [{ activity: { actor: 'user', text: `message (no engine): ${text}` } }], 'user'); }
  async respond(): Promise<void> { throw new Error('no engine is running'); }
  async planEpic(): Promise<void> { throw new Error('no engine is running'); }
  /** Without an engine only the bookkeeping half exists: a kind that never started planning (no checkout to judge) changes; anything else needs the engine. */
  async convertKind(id: string, to: 'item' | 'epic', by: 'user' | 'orchestrator' = 'user', why?: string): Promise<string> {
    const item = this.store.requireItem(id); const fm = item.file.frontmatter;
    const refused = kindConversionRefusal(fm, to, this.store.derived(item).children.length);
    if (refused) throw new Error(`not converted: ${refused}`);
    if (fm.worktree || !['NOT_YET_SUBMITTED', 'ICEBOX'].includes(fm.status)) throw new Error('no engine is running');
    this.store.mutateItem(id, [{ set: { kind: to } }, { activity: { actor: by, text: `converted to ${to === 'epic' ? 'an epic' : 'an item'}${why?.trim() ? `: ${why.trim()}` : ''}` } }], by, { commit: `${id}: convert to ${to}` });
    return `${id} converted to ${to === 'epic' ? 'an epic' : 'an item'}`;
  }
  async approveBreakdown(): Promise<string[]> { throw new Error('no engine is running'); }
  async reviewImages(): Promise<[]> { return []; }
  async reviewImage(): Promise<null> { return null; }
  async requestReviewChanges(): Promise<void> { throw new Error('no engine is running'); }
  async releaseHold(id: string): Promise<void> { this.store.mutateItem(id, [{ unset: ['review_hold', 'skip_merge'] }], 'user', { commit: `${id}: release hold` }); }
  async closeAsDone(id: string, reason?: string): Promise<void> {
    this.store.mutateItem(id, [{ transition: { to: 'FINISHED', actor: 'user' } }, { activity: { actor: 'user', text: `closed as done without a pull request${reason?.trim() ? `: ${reason.trim()}` : ''}` } }], 'user', { commit: `${id}: close as done` });
  }
  async takeOver(id: string, note?: string): Promise<void> {
    this.store.mutateItem(id, [{ set: { taken_over: { since: isoLocal(), ...(note?.trim() ? { note: note.trim() } : {}) } } }, { activity: { actor: 'user', text: `took this item over by hand${note?.trim() ? `: ${note.trim()}` : ''}` } }], 'user', { commit: `${id}: take over` });
  }
  async handBack(id: string, note?: string): Promise<void> {
    this.store.mutateItem(id, [{ unset: ['taken_over'] }, { activity: { actor: 'user', text: `handed back to planestro${note?.trim() ? `: ${note.trim()}` : ''}` } }], 'user', { commit: `${id}: hand back` });
  }
  sessions(): SessionView[] { return []; }
  private note(level: 'info' | 'warn' | 'error', message: string): void { const e: ServerEvent = { type: 'engine.log', level, message }; this.log.push(e); this.emit(e); }
}
