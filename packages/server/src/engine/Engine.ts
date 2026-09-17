import type { ServerEvent } from '@planestro/shared';

/** What the UI/API needs from the engine. Phase 2 ships MockEngine; Phase 3 the real one. */
export interface SessionView { item: string; session_id?: string; model?: string; op?: string; started_at?: string; busy: boolean; last_output?: string }

export interface Engine {
  readonly mode: 'live' | 'dry-run';
  readonly paused: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  /** Called after an item enters QUEUED; the engine admits it when a slot is free. */
  poke(): void;
  approvePlan(id: string, notes?: string): Promise<void>;
  rejectPlan(id: string, message: string): Promise<void>;
  message(id: string, text: string): Promise<void>;
  respond(id: string, payload: Record<string, unknown>): Promise<void>;
  /** Let a held pull request (a review hold, or skip_merge) back into the merge pipeline. */
  releaseHold(id: string, note?: string): Promise<void>;
  /** Finish an item without a pull request: the work landed some other way. User-only. */
  closeAsDone(id: string, reason?: string): Promise<void>;
  sessions(): SessionView[];
  log: ServerEvent[];
}
